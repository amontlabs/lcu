import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const MODEL_TOOLS = new Set(['js', 'js_reset']);

/** Default cleanup/tool timeout; `js` extends past a longer requested run. */
export const TURN_END_TIMEOUT_MS = 120_000;

/** Bound a tool call's timeout, extending `js` past its requested run. */
export function callTimeout(name, args) {
  const requested = Number(args?.timeout_ms);
  return name === 'js' && Number.isFinite(requested) && requested > 0
    ? Math.max(TURN_END_TIMEOUT_MS, requested + 30_000)
    : TURN_END_TIMEOUT_MS;
}

/** Longest timer delay Node accepts; an approval wait ends only by answer or abort. */
export const APPROVAL_TIMEOUT_MS = 2 ** 31 - 1;

/** Count pending approvals so tool-call deadlines stand still while a human decides. */
export function createApprovalGate() {
  let pending = 0;
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    get pending() { return pending; },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async track(run) {
      pending++;
      notify();
      try { return await run(); } finally {
        pending--;
        notify();
      }
    },
  };
}

/** Run `run(signal)` under a deadline that does not elapse while the gate has a pending approval. */
export async function callWithDeadline(gate, timeout, signal, run) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  let remaining = timeout;
  let started;
  let timer;
  const sync = () => {
    if (gate.pending > 0) {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining -= Date.now() - started;
    } else if (timer === undefined) {
      started = Date.now();
      timer = setTimeout(() => controller.abort(
        McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout })),
      Math.max(remaining, 0));
    }
  };
  const unsubscribe = gate.onChange(sync);
  sync();
  try {
    return await run(controller.signal);
  } finally {
    unsubscribe();
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** Forward an upstream approval to the downstream host without the SDK's default request timeout. */
export function relayElicitation(server, gate, params, signal) {
  return gate.track(() => server.elicitInput(params, { signal, timeout: APPROVAL_TIMEOUT_MS }));
}

/** True when importMetaUrl is the process entrypoint, resolving symlinks robustly. */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const NATIVE_APPROVAL_PERSISTENCE = [
  ['session', 'Allow for this session'],
  ['always', 'Always allow'],
];

const HOST_CONTROL_TIMEOUT_MS = 45_000;
const CONTROL_RESPONSE_LIMIT = 1024 * 1024;

/** Send one bounded request to the private, per-client macOS host-control socket. */
export function sendControlRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const decoder = new StringDecoder('utf8');
    const socket = createConnection(socketPath);
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const deadline = setTimeout(() => finish(new Error('LCU host-control request timed out')),
      HOST_CONTROL_TIMEOUT_MS);
    socket.on('error', error => finish(new Error(`LCU host-control connection failed: ${error.message}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, 'utf8') > CONTROL_RESPONSE_LIMIT) {
        finish(new Error('LCU host-control response exceeded its size limit'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response || typeof response !== 'object' || Array.isArray(response) ||
            typeof response.ok !== 'boolean') {
          throw new Error('invalid response shape');
        }
        if (!response.ok) {
          finish(new Error(typeof response.error === 'string' ? response.error : 'host control failed'));
          return;
        }
        finish(undefined, response.result);
      } catch (error) {
        finish(new Error(`Invalid LCU host-control response: ${error.message}`));
      }
    });
    socket.on('end', () => {
      if (!settled) finish(new Error('LCU host-control connection ended before a response'));
    });
  });
}

/** Return the choices supported by an original native-app approval request. */
export function nativeAppApprovalOptions(params) {
  const meta = params?._meta;
  const schema = params?.requestedSchema;
  const properties = schema?.properties;
  const app = meta?.tool_params?.app;
  if (params?.mode !== 'form' || typeof params.message !== 'string' || !params.message ||
      schema?.type !== 'object' || properties === null || typeof properties !== 'object' ||
      Array.isArray(properties) || Object.keys(properties ?? {}).length !== 0 ||
      (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
      meta?.codex_approval_kind !== 'mcp_tool_call' || meta?.connector_id !== 'computer-use' ||
      typeof app !== 'string' || !app) {
    return undefined;
  }

  const requested = new Set(Array.isArray(meta.persist) ? meta.persist : []);
  const choices = [{ value: 'once', label: 'Allow once' }];
  for (const [value, label] of NATIVE_APPROVAL_PERSISTENCE) {
    if (requested.has(value)) choices.push({ value, label });
  }
  choices.push({ value: 'decline', label: 'Decline' });
  return { message: params.message, resource: app, choices };
}

/** Map a selected native-app approval choice to the original MCP response. */
export function nativeAppApprovalResponse(params, value) {
  const request = nativeAppApprovalOptions(params);
  if (!request) return { action: 'cancel' };
  if (value === 'cancel') return { action: 'cancel' };
  if (value === 'decline') return { action: 'decline' };
  if (value === 'once' && request.choices.some(choice => choice.value === 'once')) {
    return { action: 'accept', content: {} };
  }
  if (NATIVE_APPROVAL_PERSISTENCE.some(([scope]) => scope === value) &&
      request.choices.some(choice => choice.value === value)) {
    return { action: 'accept', content: {}, _meta: { persist: value } };
  }
  return { action: 'cancel' };
}

/** How long a recorded mod choice stays valid; the host's answer follows it within milliseconds. */
export const APPROVAL_CHOICE_TTL_MS = 30_000;

/** Tool-use ids the Claude host assigns to calls a mod makes (the model's ids come from the API). */
export const MOD_TOOL_USE_PREFIX = 'toolu_plugin_';

const MOD_CHOICES = new Set(['session', 'always', 'deny', 'cancel']);

/**
 * Pending native-app approvals and the human choices a host mod records for them.
 * A record exists only while the runtime's elicitation is open. A choice is bound
 * to its record id, is accepted once, and only from a mod-originated call.
 */
export function createApprovalBroker({ now = Date.now, ttlMs = APPROVAL_CHOICE_TTL_MS } = {}) {
  const records = new Map();
  const fail = reason => ({ ok: false, error: reason });

  return {
    get size() { return records.size; },
    /** Register an open native-app approval; returns its id. */
    open(params) {
      const approval = nativeAppApprovalOptions(params);
      if (!approval) return undefined;
      const meta = params._meta;
      const display = Array.isArray(meta.tool_params_display)
        ? meta.tool_params_display.find(item => item?.name === 'app') : undefined;
      const warning = [meta.warningSubtitle, meta.subtitle].find(
        value => typeof value === 'string' && value.trim());
      const id = randomUUID();
      records.set(id, {
        id,
        app: meta.tool_params.app,
        label: typeof display?.value === 'string' && display.value ? display.value : meta.tool_params.app,
        scopes: approval.choices.map(choice => choice.value).filter(value => value === 'session' || value === 'always'),
        riskLevel: typeof meta.riskLevel === 'string' ? meta.riskLevel : 'low',
        ...(warning ? { warning } : {}),
        message: params.message,
        createdAt: now(),
        claimedAt: undefined,
        choice: undefined,
        waiters: [],
      });
      return id;
    },
    /** The mod asks for the display data of the oldest unclaimed record with this exact message. */
    describe(message, toolUseId) {
      if (typeof toolUseId !== 'string' || !toolUseId.startsWith(MOD_TOOL_USE_PREFIX)) {
        return fail('approval_request accepts only host-mod calls');
      }
      if (typeof message !== 'string' || !message) return fail('approval_request requires the elicitation message');
      const record = [...records.values()].find(item => item.message === message && item.claimedAt === undefined);
      if (!record) return fail('No pending native-app approval matches this message');
      record.claimedAt = now();
      const { id, app, label, scopes, riskLevel, warning } = record;
      return { ok: true, approval: { id, message: record.message, app, label, scopes, riskLevel, ...(warning ? { warning } : {}) } };
    },
    /** Record the human's choice for one pending record. */
    choose(id, choice, toolUseId) {
      if (typeof toolUseId !== 'string' || !toolUseId.startsWith(MOD_TOOL_USE_PREFIX)) {
        return fail('approval_choice accepts only host-mod calls');
      }
      const record = typeof id === 'string' ? records.get(id) : undefined;
      if (!record || record.claimedAt === undefined) return fail('Unknown approval id');
      if (record.choice !== undefined) return fail('This approval already has a choice');
      if (!MOD_CHOICES.has(choice)) return fail('Unknown approval choice');
      if (choice === 'always' && !record.scopes.includes('always')) {
        return fail('Always allow was not offered for this app');
      }
      record.choice = choice === 'session' && !record.scopes.includes('session') ? 'once' : choice;
      record.chosenAt = now();
      record.chosenInput = choice;
      for (const waiter of record.waiters.splice(0)) waiter(choice);
      return { ok: true };
    },
    /**
     * Resolve with the recorded choice once there is one (immediately if already recorded), or
     * with 'none' when the request ends or `signal` aborts without a choice. A mod waits here
     * because a call in flight does not count against its hook's time limit.
     */
    wait(id, toolUseId, signal) {
      if (typeof toolUseId !== 'string' || !toolUseId.startsWith(MOD_TOOL_USE_PREFIX)) {
        return Promise.resolve(fail('approval_wait accepts only host-mod calls'));
      }
      const record = typeof id === 'string' ? records.get(id) : undefined;
      if (!record || record.claimedAt === undefined) return Promise.resolve(fail('Unknown approval id'));
      if (record.choice !== undefined) return Promise.resolve({ ok: true, choice: record.chosenInput });
      return new Promise(resolve => {
        const finish = choice => resolve({ ok: true, choice });
        record.waiters.push(finish);
        signal?.addEventListener('abort', () => finish('none'), { once: true });
      });
    },
    /** Remove the record and return its still-valid recorded choice, if any. */
    settle(id) {
      const record = records.get(id);
      records.delete(id);
      for (const waiter of record?.waiters.splice(0) ?? []) waiter('none');
      if (!record || record.choice === undefined || now() - record.chosenAt > ttlMs) return undefined;
      return record.choice === 'deny' ? 'decline' : record.choice;
    },
  };
}

function originApproval(params, allowedOrigins) {
  const meta = params?._meta ?? params?.meta;
  if (meta?.tool_name !== 'access_browser_origin' || typeof meta.origin !== 'string') return false;
  let origin;
  try {
    const url = new URL(meta.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== meta.origin) return false;
    origin = url.origin;
  } catch {
    return false;
  }
  return allowedOrigins.has(origin);
}

/** Transport and lifecycle bridge only. The installed original server owns CUA behavior. */
export function createCuaClient({ command, cwd, env, onElicitation, allowedOrigins = [] }) {
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || !part)) {
    throw new TypeError('command must be a nonempty argv array');
  }
  const approved = new Set(allowedOrigins.map(origin => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError(`Expected an exact HTTP(S) origin: ${origin}`);
    }
    return origin;
  }));
  let controlDirectory;
  let controlSocketPath;
  if (process.platform === 'darwin') {
    try {
      controlDirectory = mkdtempSync(join(tmpdir(), 'lcu-'));
      chmodSync(controlDirectory, 0o700);
      controlSocketPath = join(controlDirectory, 'c.sock');
    } catch {
      if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
      controlDirectory = undefined;
      controlSocketPath = undefined;
    }
  }
  const childEnv = { ...(env ?? process.env),
    ...(controlSocketPath ? { LCU_MAC_CONTROL_SOCKET: controlSocketPath } : {}),
  };
  if (!controlSocketPath) delete childEnv.LCU_MAC_CONTROL_SOCKET;
  const transport = new StdioClientTransport({
    command: command[0], args: command.slice(1), cwd,
    env: childEnv, stderr: 'inherit',
  });
  const client = new Client({ name: 'lcu-harness-adapter', version: '0.1.0' }, {
    capabilities: { elicitation: {} },
  });
  let connected = false;
  let tools;
  const approvals = createApprovalGate();
  const callSignals = new Set();
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const params = request.params;
    if (originApproval(params, approved)) return { action: 'accept', content: {} };
    if (typeof onElicitation !== 'function') return { action: 'cancel' };
    const signal = AbortSignal.any([extra.signal, ...callSignals]);
    const aborted = new Promise(resolve => {
      if (signal.aborted) resolve({ action: 'cancel' });
      else signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
    });
    const answer = await approvals.track(() => Promise.race([onElicitation(params, { signal }), aborted]));
    if (answer?.action === 'accept' || answer?.action === 'decline' || answer?.action === 'cancel') return answer;
    return { action: 'cancel' };
  });

  return {
    async connect() {
      if (connected) return this;
      try {
        await client.connect(transport);
        connected = true;
        const listed = await client.listTools();
        tools = listed.tools.filter(tool => MODEL_TOOLS.has(tool.name));
        if (tools.length !== MODEL_TOOLS.size) throw new Error('Original CUA js/js_reset tools are missing');
        return this;
      } catch (error) {
        connected = false;
        await client.close().catch(() => {});
        if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true });
        controlDirectory = undefined;
        controlSocketPath = undefined;
        throw error;
      }
    },
    get instructions() {
      if (!connected) throw new Error('LCU is not connected');
      return client.getInstructions() ?? '';
    },
    publicTools() {
      if (!connected) throw new Error('LCU is not connected');
      return tools;
    },
    async call(name, args, {
      sessionId, turnId, toolCallId, itemId, threadId, threadSource,
      chatgptConversationId, model, reasoningEffort, metadata, signal,
    } = {}) {
      if (!connected) throw new Error('LCU is not connected');
      if (!MODEL_TOOLS.has(name)) throw new Error(`Tool is reserved for host use: ${name}`);
      if (!sessionId || !turnId) throw new Error('A real host session and active turn are required');
      const timeout = callTimeout(name, args);
      const inherited = metadata?.['x-codex-turn-metadata'];
      const original = typeof inherited === 'string' ? (() => {
        try { return JSON.parse(inherited); } catch { return undefined; }
      })() : inherited;
      const turnMetadata = original && typeof original === 'object' && !Array.isArray(original)
        ? { ...original } : {};
      Object.assign(turnMetadata, {
        session_id: sessionId,
        turn_id: turnId,
        ...(toolCallId ? { call_id: toolCallId } : {}),
        ...(itemId ? { item_id: itemId } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(threadSource ? { thread_source: threadSource } : {}),
        ...(chatgptConversationId ? { chatgpt_conversation_id: chatgptConversationId } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      });
      if (signal) callSignals.add(signal);
      try {
        return await callWithDeadline(approvals, timeout, signal, deadlineSignal => client.callTool({
          name, arguments: args, _meta: {
            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
            'x-codex-turn-metadata': turnMetadata,
          },
        }, undefined, { signal: deadlineSignal, timeout: APPROVAL_TIMEOUT_MS }));
      } finally {
        if (signal) callSignals.delete(signal);
      }
    },
    async turnEnded({ sessionId, turnId, event = 'Stop' }) {
      if (!connected) return;
      if (!sessionId || !turnId || !['Stop', 'Interrupt', 'SubagentStop'].includes(event)) {
        throw new Error('Invalid original CUA lifecycle event');
      }
      const result = await client.callTool({ name: 'turn_ended', arguments: {
        hook_event_name: event, session_id: sessionId, turn_id: turnId,
      } }, undefined, { timeout: TURN_END_TIMEOUT_MS });
      if (result.isError) {
        const detail = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      return result;
    },
    get hasHostControl() { return connected && Boolean(controlSocketPath); },
    async controlStatus({ sessionId, turnId }) {
      if (!connected) throw new Error('LCU host control is unavailable after the client closes');
      if (!controlSocketPath) throw new Error('LCU host control is unavailable on this platform');
      if (!sessionId || !turnId) throw new Error('Host control requires the active session and turn IDs');
      const result = await sendControlRequest(controlSocketPath, {
        type: 'status', session_id: sessionId, turn_id: turnId,
      });
      if (!result || typeof result !== 'object' ||
          !Array.isArray(result.computerUse?.activeApplications)) {
        throw new Error('Original host returned an invalid Computer Use status response');
      }
      return result;
    },
    async controlStop({ sessionId, turnId, app }) {
      if (!connected) throw new Error('LCU host control is unavailable after the client closes');
      if (!controlSocketPath) throw new Error('LCU host control is unavailable on this platform');
      if (!sessionId || !turnId || !app) throw new Error('Host Stop requires the active session, turn, and app IDs');
      const result = await sendControlRequest(controlSocketPath, {
        type: 'stop', session_id: sessionId, turn_id: turnId, app,
      });
      if (!result || result.accepted !== true || result.applicationId !== app) {
        throw new Error('Original host did not confirm Computer Use Stop for the selected app');
      }
      return result;
    },
    async close() {
      connected = false;
      try { await client.close(); }
      finally {
        if (controlDirectory) {
          rmSync(controlDirectory, { recursive: true, force: true });
          controlDirectory = undefined;
          controlSocketPath = undefined;
        }
      }
    },
  };
}
