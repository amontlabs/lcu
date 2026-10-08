import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  APPROVAL_TIMEOUT_MS,
  callTimeout,
  callWithDeadline,
  createApprovalBroker,
  createApprovalGate,
  createApprovalLogger,
  createCallTracker,
  isMainModule,
  nativeAppApprovalOptions,
  nativeAppApprovalResponse,
  relayElicitation,
  TURN_END_TIMEOUT_MS,
} from './client.mjs';
import { openDiagnosticLog } from './diagnostics.mjs';
import { declineAgentHostApp } from './host-guard.mjs';

const PUBLIC_TOOLS = new Set(['js', 'js_reset']);
const CONTEXT_TOOL = 'set_turn_context';
const APPROVAL_REQUEST_TOOL = 'approval_request';
const APPROVAL_CHOICE_TOOL = 'approval_choice';
const TURN_END_TOOL = 'turn_ended';
/** Listed for the lcu-approve mod but never allowed or denied in Claude's permissions; refused without a plugin tool-use id. */
const MOD_ONLY_TOOLS = new Set(['approval_request', 'approval_choice']);
const TURN_CONTEXT_META = 'x-codex-turn-metadata';
const CLAUDE_TOOL_USE_META = 'claudecode/toolUseId';
/**
 * Once the host is gone, Interrupt cleanup for its open turns gets this long before the original server is
 * closed anyway, so a relay whose host exited or was killed ends within seconds, not after the cleanup's own
 * timeouts (20 s per step on macOS) or after an in-flight call.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const TURN_CONTEXT_SCHEMA = {
  type: 'object',
  properties: {
    session_id: { type: 'string', minLength: 1 },
    turn_id: { type: 'string', minLength: 1 },
    tool_use_id: { type: 'string', minLength: 1 },
    agent_id: { type: 'string' },
  },
  required: ['session_id', 'turn_id', 'tool_use_id'],
  additionalProperties: false,
};

const APPROVAL_REQUEST_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string', minLength: 1 } },
  required: ['message'],
  additionalProperties: false,
};
const APPROVAL_CHOICE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    choice: { type: 'string', enum: ['session', 'always', 'deny', 'cancel'] },
  },
  required: ['id', 'choice'],
  additionalProperties: false,
};

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function turnKey(sessionId, turnId) {
  return JSON.stringify([sessionId, turnId]);
}

function asError(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireTurnContext(value) {
  if (!value || typeof value !== 'object' ||
      !nonEmptyString(value.session_id) || !nonEmptyString(value.turn_id) ||
      !nonEmptyString(value.tool_use_id) ||
      (value.agent_id !== undefined && typeof value.agent_id !== 'string')) {
    throw new Error('Claude turn context requires session_id, turn_id, and tool_use_id');
  }
  return {
    sessionId: value.session_id,
    turnId: value.turn_id,
    toolUseId: value.tool_use_id,
    ...(typeof value.agent_id === 'string' && value.agent_id ? { agentId: value.agent_id } : {}),
  };
}

function nativeForm(params, approval) {
  const choices = approval.choices;
  return {
    ...params,
    mode: 'form',
    message: approval.message,
    requestedSchema: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: choices.map(choice => choice.value),
          enumNames: choices.map(choice => choice.label),
        },
      },
      required: ['choice'],
    },
  };
}

/**
 * Run a Claude-facing MCP server that relays the selected original LCU server.
 * The relay leaves public tool descriptors, instructions, and result blocks
 * with the original server and changes only the host-specific identity seams.
 */
export async function runClaudeBridge({
  command, args = [], cwd, env, log = openDiagnosticLog({ adapter: 'claude' }),
  shutdownDrainMs = SHUTDOWN_DRAIN_TIMEOUT_MS,
} = {}) {
  if (!nonEmptyString(command) || !Array.isArray(args) ||
      args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Claude bridge requires the original MCP command and string arguments');
  }

  const upstreamTransport = new StdioClientTransport({
    command,
    args,
    ...(cwd ? { cwd } : {}),
    env: env ?? process.env,
    stderr: 'inherit',
  });
  const upstream = new Client({ name: 'lcu-claude-relay', version: '0.1.0' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  const contexts = new Map();
  const activeTurns = new Map();
  const cleanupInFlight = new Map();
  const cleanedTurns = new Set();
  let server;
  const approvals = createApprovalGate();
  const broker = createApprovalBroker();
  const calls = createCallTracker(log);
  const approvalLog = createApprovalLogger(log, calls);
  const loggedApprovals = new Map();
  let liveCalls = 0;
  let connected = false;
  let shutdown;
  let serverClose;

  const clearTurnContexts = (sessionId, turnId) => {
    for (const [toolUseId, context] of contexts) {
      if (context.sessionId === sessionId && context.turnId === turnId) contexts.delete(toolUseId);
    }
  };

  async function turnEnded(sessionId, turnId, event) {
    if (!nonEmptyString(sessionId) || !nonEmptyString(turnId) ||
        !['Stop', 'Interrupt', 'SubagentStop'].includes(event)) {
      throw new Error('Claude lifecycle cleanup requires an exact session, prompt, and supported event');
    }
    const key = turnKey(sessionId, turnId);
    if (cleanedTurns.has(key)) return { content: [{ type: 'text', text: 'Turn already ended.' }] };
    // Each bind stores a fresh activeTurns entry; a changed entry at resolution
    // means the turn was re-bound while this cleanup was in flight.
    const generation = activeTurns.get(key);
    let rebound = false;
    let cleanup = cleanupInFlight.get(key);
    const started = Date.now();
    let outcome = 'error';
    if (!cleanup) {
      cleanup = upstream.callTool({ name: TURN_END_TOOL, arguments: {
        hook_event_name: event,
        session_id: sessionId,
        turn_id: turnId,
      } }, undefined, { timeout: TURN_END_TIMEOUT_MS });
      cleanupInFlight.set(key, cleanup);
    }
    try {
      const result = await cleanup.finally(() => { rebound = activeTurns.get(key) !== generation; });
      if (result.isError) {
        const detail = (result.content ?? []).filter(item => item.type === 'text')
          .map(item => item.text).join('\n');
        throw new Error(`Original CUA turn cleanup failed: ${detail || 'unknown error'}`);
      }
      if (!rebound) {
        cleanedTurns.add(key);
        if (cleanedTurns.size > 256) cleanedTurns.delete(cleanedTurns.values().next().value);
        activeTurns.delete(key);
      }
      outcome = 'ok';
      return result;
    } finally {
      log.event('turn_end', { hook_event: event, ms: Date.now() - started, outcome });
      if (cleanupInFlight.get(key) === cleanup) cleanupInFlight.delete(key);
      // A re-bound turn keeps its new identities for the later Stop cleanup.
      if (!rebound) clearTurnContexts(sessionId, turnId);
    }
  }

  try {
    const connectStarted = Date.now();
    try {
      await upstream.connect(upstreamTransport);
    } catch (error) {
      log.event('upstream_connect', { ms: Date.now() - connectStarted, ok: false });
      throw error;
    }
    connected = true;
    log.event('upstream_connect', { ms: Date.now() - connectStarted, ok: true });
    const listed = await upstream.listTools();
    const upstreamTools = listed.tools;
    const publicTools = upstreamTools.filter(tool => PUBLIC_TOOLS.has(tool.name));
    if (publicTools.length !== PUBLIC_TOOLS.size ||
        !upstreamTools.some(tool => tool.name === TURN_END_TOOL)) {
      throw new Error('Original CUA js/js_reset and turn_ended tools are required');
    }
    if (upstreamTools.some(tool => [CONTEXT_TOOL, APPROVAL_REQUEST_TOOL, APPROVAL_CHOICE_TOOL].includes(tool.name))) {
      throw new Error('Original CUA server already uses a Claude relay host-only tool name');
    }
    const turnEndedTool = upstreamTools.find(tool => tool.name === TURN_END_TOOL);
    const contextTool = {
      name: CONTEXT_TOOL,
      description: 'Internal Claude host hook: bind the exact prompt and tool-use identity.',
      inputSchema: TURN_CONTEXT_SCHEMA,
    };

    // These cannot be hidden with deny rules like the tools above: a denied MCP tool is
    // removed from Claude Code's tool list, and the mod's `$.mcp.call` needs it listed.
    // The relay rejects any call without a mod-originated tool-use id, and the mod denies the model's.
    const approvalRequestTool = {
      name: APPROVAL_REQUEST_TOOL,
      description: 'Internal Claude host mod: describe the pending native-app approval for an elicitation message.',
      inputSchema: APPROVAL_REQUEST_SCHEMA,
    };
    const approvalChoiceTool = {
      name: APPROVAL_CHOICE_TOOL,
      description: 'Internal Claude host mod: record the person\'s choice for a pending native-app approval.',
      inputSchema: APPROVAL_CHOICE_SCHEMA,
    };

    server = new Server({ name: 'lcu-claude-relay', version: '0.1.0' }, {
      capabilities: { tools: {} },
      instructions: upstream.getInstructions() ?? '',
    });
    server.onerror = error => console.error('Claude MCP relay server error:', asError(error));
    upstream.onerror = error => console.error('Claude MCP relay upstream error:', asError(error));

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...publicTools, turnEndedTool, contextTool, approvalRequestTool, approvalChoiceTool],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: toolArgs = {}, _meta } = request.params;
      if (name === CONTEXT_TOOL) {
        const context = requireTurnContext(toolArgs);
        // Match Claude's child cleanup identity while preserving the shared prompt ID.
        if (context.agentId) context.sessionId = context.agentId;
        const previous = contexts.get(context.toolUseId);
        if (previous && (previous.sessionId !== context.sessionId || previous.turnId !== context.turnId ||
            previous.agentId !== context.agentId)) {
          throw new Error('Conflicting Claude identity for the same tool_use_id');
        }
        if (!previous && contexts.size >= 1024) {
          throw new Error('Too many pending Claude tool identities; LCU rejected this call safely');
        }
        contexts.set(context.toolUseId, context);
        const key = turnKey(context.sessionId, context.turnId);
        // The turn is live again: a later Stop must reach upstream turn_ended
        // even if an earlier aborted call already ran Interrupt cleanup for it.
        cleanedTurns.delete(key);
        // A cleanup still in flight ended the earlier life of this turn; the
        // next Stop must start its own upstream turn_ended instead of joining it.
        cleanupInFlight.delete(key);
        activeTurns.set(key, {
          sessionId: context.sessionId,
          turnId: context.turnId,
        });
        return { content: [{ type: 'text', text: 'Turn context bound.' }] };
      }
      if (MOD_ONLY_TOOLS.has(name)) {
        // Host-only: answered for the lcu-approve mod, which Claude Code marks with a plugin tool-use id.
        const modCall = _meta?.[CLAUDE_TOOL_USE_META];
        const outcome = name === APPROVAL_REQUEST_TOOL ? broker.describe(toolArgs.message, modCall)
          : broker.choose(toolArgs.id, toolArgs.choice, modCall);
        if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: outcome.error }] };
        if (name === APPROVAL_REQUEST_TOOL) loggedApprovals.get(outcome.approval.id)?.claimed();
        else loggedApprovals.get(toolArgs.id)?.choice(toolArgs.choice);
        const body = outcome.approval ?? { ok: true };
        return { content: [{ type: 'text', text: JSON.stringify(body) }] };
      }
      if (name === TURN_END_TOOL) {
        const event = toolArgs.hook_event_name;
        return turnEnded(toolArgs.session_id, toolArgs.turn_id, event);
      }
      if (!PUBLIC_TOOLS.has(name)) {
        return { isError: true, content: [{ type: 'text', text: `Unknown LCU tool: ${name}` }] };
      }

      const toolUseId = _meta?.[CLAUDE_TOOL_USE_META];
      const context = nonEmptyString(toolUseId) ? contexts.get(toolUseId) : undefined;
      if (!context || context.toolUseId !== toolUseId) {
        return { isError: true, content: [{ type: 'text', text:
          'Missing exact Claude PreToolUse identity; LCU did not run this tool call.' }] };
      }
      contexts.delete(toolUseId);
      const metadata = _meta && typeof _meta === 'object' && !Array.isArray(_meta)
        ? { ..._meta } : {};
      const inheritedTurnMetadata = metadata[TURN_CONTEXT_META];
      let turnMetadata = inheritedTurnMetadata;
      if (typeof turnMetadata === 'string') {
        try { turnMetadata = JSON.parse(turnMetadata); } catch { turnMetadata = undefined; }
      }
      turnMetadata = turnMetadata && typeof turnMetadata === 'object' && !Array.isArray(turnMetadata)
        ? { ...turnMetadata } : {};
      Object.assign(turnMetadata, {
        session_id: context.sessionId,
        turn_id: context.turnId,
        call_id: toolUseId,
      });
      metadata[TURN_CONTEXT_META] = turnMetadata;
      liveCalls++;
      try {
        return await calls.track(name, { timeout_ms: toolArgs.timeout_ms, signal: extra.signal }, () =>
          callWithDeadline(approvals, callTimeout(name, toolArgs), extra.signal,
            signal => upstream.callTool({ name, arguments: toolArgs, _meta: metadata }, undefined, {
              signal,
              timeout: APPROVAL_TIMEOUT_MS,
            })));
      } finally {
        liveCalls--;
        // Never let cleanup mask the original tool result or abort error.
        if (extra.signal.aborted) {
          // The runtime's own cancel of an open elicitation is not always delivered: with no other
          // call alive, nobody is left to answer an approval the mod is still holding open.
          if (liveCalls === 0) broker.cancelWaiting();
          try {
            await turnEnded(context.sessionId, context.turnId, 'Interrupt');
          } catch (error) {
            console.error('Claude MCP interrupt cleanup failed:', asError(error));
          }
        }
      }
    });

    upstream.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const params = request.params;
      const refused = declineAgentHostApp(params);
      const entry = approvalLog.open(refused ? 'agent_host_refused'
        : nativeAppApprovalOptions(params) ? 'native_app' : 'other', params);
      const response = refused ?? await answerElicitation(params, extra, entry);
      entry.end(response);
      return response;
    });

    async function answerElicitation(params, extra, entry) {
      const approval = nativeAppApprovalOptions(params);
      const pendingId = approval ? broker.open(params) : undefined;
      if (pendingId) loggedApprovals.set(pendingId, entry);
      try {
        const response = await relayElicitation(
          server, approvals, approval ? nativeForm(params, approval) : params, extra.signal);
        if (!approval) return response;
        // A claimed record means the lcu-approve mod answers for the person: the host's own answer
        // was only its hook's block, so keep this elicitation open until the mod records a choice
        // (the approval gate holds tool-call deadlines meanwhile) or the request ends.
        if (response.action !== 'accept' && broker.isClaimed(pendingId)) {
          const waited = await approvals.track(() => broker.awaitChoice(pendingId, extra.signal));
          return waited ? nativeAppApprovalResponse(params, waited) : { action: 'cancel' };
        }
        // A choice the lcu-approve mod recorded for this exact request answers for the person.
        const modChoice = broker.settle(pendingId);
        if (modChoice) return nativeAppApprovalResponse(params, modChoice);
        if (response.action !== 'accept') return nativeAppApprovalResponse(params, response.action);
        return nativeAppApprovalResponse(params, response.content?.choice);
      } catch {
        return { action: 'cancel' };
      } finally {
        if (pendingId) {
          broker.settle(pendingId);
          loggedApprovals.delete(pendingId);
        }
      }
    }

    const closeUpstreamAfterTurnCleanup = () => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        const drain = (async () => {
          for (const turn of [...activeTurns.values()]) {
            try {
              await turnEnded(turn.sessionId, turn.turnId, 'Interrupt');
            } catch (error) {
              console.error('Claude MCP turn cleanup during shutdown failed:', asError(error));
            }
          }
        })();
        let timer;
        const drained = await Promise.race([drain.then(() => true), new Promise(resolve => {
          timer = setTimeout(resolve, shutdownDrainMs, false);
        })]);
        clearTimeout(timer);
        if (!drained) {
          console.error(`Claude MCP turn cleanup during shutdown did not finish within ${shutdownDrainMs} ms; ` +
            'closing the original server');
          log.event('shutdown_drain', { ms: shutdownDrainMs, outcome: 'timeout' });
        }
        if (connected) {
          connected = false;
          try {
            await upstream.close();
          } catch (error) {
            console.error('Claude MCP upstream close failed:', asError(error));
          }
          log.event('upstream_close');
        }
      })();
      return shutdown;
    };
    server.onclose = () => { void closeUpstreamAfterTurnCleanup(); };
    const transport = new StdioServerTransport();
    const closeDownstream = () => {
      // The host is gone. Closing the server aborts its in-flight calls, which cancels them upstream and
      // starts their Interrupt cleanup, and its onclose drains the remaining turns before closing upstream.
      // Draining first would wait for each in-flight call to end on its own.
      if (!serverClose) serverClose = server.close().catch(error => {
        console.error('Claude MCP relay close failed:', asError(error));
      });
      void closeUpstreamAfterTurnCleanup();
    };
    await server.connect(transport);
    // The SDK's stdio server transport owns MCP framing but does not surface stdin EOF.
    // EOF is the actual Claude-side connection-close signal; use it to drain exact
    // active turns before closing the original MCP client.
    process.stdin.once('end', closeDownstream);
    return { server, upstream, contexts, activeTurns, close: async () => {
      process.stdin.off('end', closeDownstream);
      await closeUpstreamAfterTurnCleanup();
      if (!serverClose) serverClose = server.close();
      await serverClose;
    } };
  } catch (error) {
    if (connected) await upstream.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: claude.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
  await runClaudeBridge({ command, args });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error('Claude MCP relay failed:', asError(error));
    process.exitCode = 1;
  });
}
