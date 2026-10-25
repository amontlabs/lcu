// Junie CLI relay: a stdio MCP server for Junie in front of the original runtime, through the shared client.
// Junie's MCP client sends no turn identity, ignores server instructions and cannot answer elicitation, so
// Junie's own command hooks (`junie.mjs --hook`, installed by `lcu setup --agent junie`) reach this relay over a
// private socket named for the Junie process that runs both: they mark the turn boundaries and carry the original
// instructions into the first prompt of each session. When Junie starts the relay only after that prompt's hooks
// (macOS), the session's first call result carries them instead. Native-app approvals cannot be shown in Junie; the call
// result tells the model to run `lcu apps allow <App>` itself (the person approves with Touch ID or their password,
// which allows the app until it is revoked), and to offer `lcu apps revoke <App>` when its task is done.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { persistAudioContent } from './audio-files.mjs';
import { createCuaClient, isMainModule, MODEL_TOOLS, nativeAppApprovalOptions } from './client.mjs';

/** The Junie hook events LCU registers, with the LCU turn end each one means. */
export const HOOK_EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  Stop: 'Stop',
  StopFailure: 'Interrupt',
  SessionEnd: 'Interrupt',
};
/** Seconds Junie gives each hook (`timeout` in config.json); the hook gives up on the relay a little earlier. */
export const HOOK_TIMEOUTS = { SessionStart: 10, UserPromptSubmit: 30, Stop: 60, StopFailure: 60, SessionEnd: 10 };
/** Once Junie is gone, open turns get this long to end upstream before the original server is closed anyway. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const REQUEST_LIMIT = 64 * 1024;
/** The line above the original instructions when a call result carries them (the prompt hook could not). */
export const INSTRUCTIONS_HEADER = 'LCU: Computer Use instructions for this session:';
/** Ancestors of the hook checked for a relay: `sh -c`, then Junie (one more for a wrapper). */
const HOOK_ANCESTORS = 3;

function asError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Longest socket directory: a socket path must fit in 104 bytes on macOS, and its name takes up to 24. */
const MAX_DIRECTORY_BYTES = 78;

/**
 * The private directory of relay sockets: `LCU_JUNIE_CONTROL_DIR` (tests), else beside LCU's other state, or in
 * the temporary directory when that path is too long for a socket. The relay and its hooks share Junie's
 * environment, so both choose the same one.
 */
export function controlDirectory({ env = process.env, home = env.HOME || homedir(), temporary = env.TMPDIR || tmpdir(),
  uid = process.getuid?.() } = {}) {
  if (env.LCU_JUNIE_CONTROL_DIR) return env.LCU_JUNIE_CONTROL_DIR;
  const state = join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'lcu', 'junie');
  return Buffer.byteLength(state) <= MAX_DIRECTORY_BYTES ? state : join(temporary, `lcu-junie-${uid}`);
}

// `lcu apps allow` waits this long for Touch ID or the password (AUTH_TIMEOUT in lcu/apps.mjs); Junie's shell tool
// defaults to 30 s, which ends the command before most people can approve.
const AUTH_WAIT_SECONDS = 300;
const shellWord =(word) => (/^[A-Za-z0-9._\/-]+$/.test(word) ? word : `"${word.replace(/["\\$`]/g, '\\$&')}"`);

/** The absolute `lcu` launcher among the relay's original command (setup passes it), else plain `lcu`. */
export function launcherOf(command = []) {
  return [...command].reverse().find(word => typeof word === 'string' && isAbsolute(word) && basename(word) === 'lcu') ?? 'lcu';
}

/** The tool-result text that replaces an approval prompt Junie cannot show. `lcu` is the launcher to name. */
export function approvalHint(app, lcu = 'lcu') {
  const run = (verb) => `\`${shellWord(lcu)} apps ${verb} ${shellWord(app)}\``;
  return `LCU: Computer Use needs the person's approval to control ${app}, and Junie cannot show approval prompts ` +
    `yet. Run ${run('allow')} yourself in a terminal: the person approves with Touch ID or their password, which ` +
    `allows ${app} until it is revoked. It waits up to 5 minutes for them, so give the command a timeout of at ` +
    `least ${AUTH_WAIT_SECONDS} seconds. Then retry the call. If the command fails, is refused or times out (for ` +
    'example, nobody is there to approve), ask the person to run it themselves and stop. In your final answer, ' +
    `say that ${app} stays allowed until revoked, show ${run('revoke')}, and offer to run it for them.`;
}

/**
 * Run the relay on stdio. `hostPid` is the Junie process that started it, which also runs the hooks.
 * `createClient` (tests) replaces createCuaClient.
 */
export async function runJunieRelay({
  command, cwd, env = process.env, hostPid = process.ppid, directory = controlDirectory({ env }),
  shutdownDrainMs = SHUTDOWN_DRAIN_TIMEOUT_MS, createClient = createCuaClient,
} = {}) {
  // Session id -> { active: {turnId, calls}, pending: {turnId, event}, cleaning, told }.
  const sessions = new Map();
  // The session Junie last reported through a hook; calls before any hook use this relay's own id.
  let current;
  const fallback = `junie-${randomUUID()}`;
  // The launcher named in approval hints, so they work when `lcu` is not on PATH.
  const lcu = launcherOf(command);
  // Calls in flight -> the apps whose approval Junie could not show during them.
  const inFlight = new Set();

  const client = createClient({
    command, cwd, env, adapter: 'junie',
    allowedOrigins: process.env.LCU_APPROVED_ORIGINS ? JSON.parse(process.env.LCU_APPROVED_ORIGINS) : [],
    onElicitation: async (params) => {
      const approval = nativeAppApprovalOptions(params);
      // An approval request does not name the call it came from, so only a lone call can get the hint;
      // with calls overlapping, the model still sees the runtime's own "not approved" error.
      if (approval && inFlight.size === 1) for (const call of inFlight) call.add(approval.resource);
      // Cancel, not decline: nothing is decided, so a retry after `lcu apps allow` is not refused.
      return { action: 'cancel' };
    },
  });

  const stateOf = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) sessions.set(sessionId, state = {});
    return state;
  };

  /** End the session's open LCU turn upstream; a failure keeps it pending for the session's next call. */
  async function finish(sessionId, event) {
    const state = sessions.get(sessionId);
    if (!state) return;
    if (state.active) {
      state.pending = { turnId: state.active.turnId, event };
      state.active = undefined;
    }
    if (state.cleaning) return state.cleaning;
    const cleanup = state.pending;
    if (!cleanup) return;
    const attempt = (async () => {
      await client.turnEnded({ sessionId, turnId: cleanup.turnId, event: cleanup.event });
      if (state.pending === cleanup) state.pending = undefined;
    })();
    state.cleaning = attempt;
    try {
      await attempt;
    } finally {
      if (state.cleaning === attempt) state.cleaning = undefined;
    }
  }

  /**
   * The open LCU turn of the session, ending a missed or failed earlier one first. A failed end of any
   * session's turn is retried too, so no call runs while an earlier turn's hooks may still hold the desktop.
   */
  async function turnOf(sessionId) {
    const state = stateOf(sessionId);
    const unfinished = [...sessions].filter(([id, other]) => id !== sessionId && (other.pending || other.cleaning));
    if (state.active && !unfinished.length) return state.active;
    try {
      await Promise.all([...unfinished.map(([id]) => finish(id, 'Interrupt')),
        ...(state.active ? [] : [finish(sessionId, 'Interrupt')])]);
    } catch (error) {
      throw new Error('LCU is still finishing the previous turn, so Computer Use actions are paused. ' +
        `Try again in a few seconds. ${asError(error)}`);
    }
    state.active ??= { turnId: randomUUID(), calls: 0 };
    return state.active;
  }

  /** Make `sessionId` the current one; any other session's open turn ended with it (a new or resumed session). */
  async function announce(sessionId) {
    current = sessionId;
    stateOf(sessionId);
    await Promise.all([...sessions].filter(([id, other]) => id !== sessionId && (other.active || other.pending))
      .map(([id]) => finish(id, 'Interrupt').catch(() => {})));
  }

  /** Answer one hook: `{additional_context?}`. */
  async function onHook(event, sessionId) {
    if (!Object.hasOwn(HOOK_EVENTS, event) || typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Expected a Junie hook event and session id');
    }
    if (event === 'SessionStart') {
      await announce(sessionId);
      return {};
    }
    if (event === 'UserPromptSubmit') {
      await announce(sessionId);
      const state = stateOf(sessionId);
      // Junie runs Stop only for a successful task, never for chat mode or an interrupted one: a new prompt
      // means the previous turn is over. A call still running means it was interrupted.
      if (state.active) await finish(sessionId, state.active.calls > 0 ? 'Interrupt' : 'Stop').catch(() => {});
      if (state.told) return {};
      state.told = true;
      const instructions = client.instructions;
      return instructions ? { additional_context: instructions } : {};
    }
    // Junie can start this relay only after the session's first SessionStart and UserPromptSubmit hooks, so calls
    // before any hook ran under the relay's own id; the first ending hook ends that turn and names the session.
    if (current === undefined && sessions.has(fallback)) {
      current = sessionId;
      // The instructions a call already carried count for the session the relay now follows.
      if (sessions.get(fallback).told) stateOf(sessionId).told = true;
      await finish(fallback, HOOK_EVENTS[event]);
      return {};
    }
    if (!sessions.has(sessionId)) return {};
    await finish(sessionId, HOOK_EVENTS[event]);
    return {};
  }

  // Hook requests: one JSON line `{hook_event_name, session_id}` in, one `{ok, result|error}` line out.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (statSync(directory).uid !== process.getuid()) throw new Error(`LCU socket directory belongs to another account: ${directory}`);
  chmodSync(directory, 0o700);
  const socketPath = join(directory, `${hostPid}-${process.pid}.sock`);
  rmSync(socketPath, { force: true });
  const control = createServer(socket => {
    let input = '';
    const decoder = new StringDecoder('utf8');
    const reply = (value) => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      if (input === null) return;
      input += decoder.write(chunk);
      if (input.length > REQUEST_LIMIT) {
        input = null;
        reply({ ok: false, error: 'request too large' });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = null;
      try {
        const request = JSON.parse(line);
        reply({ ok: true, result: await onHook(request?.hook_event_name, request?.session_id) });
      } catch (error) {
        reply({ ok: false, error: asError(error) });
      }
    });
  });

  let server;
  let shutdown;
  const close = () => shutdown ??= (async () => {
    control.close();
    rmSync(socketPath, { force: true });
    let timer;
    const drained = Promise.allSettled([...sessions.keys()].map(id => finish(id, 'Interrupt')));
    await Promise.race([drained, new Promise(resolve => { timer = setTimeout(resolve, shutdownDrainMs); })]);
    clearTimeout(timer);
    await client.close().catch(error => console.error('Junie MCP relay upstream close failed:', asError(error)));
    await server?.close().catch(() => {});
  })();

  try {
    await client.connect();
    await new Promise((resolve, reject) => {
      control.once('error', reject);
      control.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    const tools = client.publicTools();
    server = new Server({ name: 'lcu-junie-relay', version: '0.1.0' }, {
      capabilities: { tools: {} },
      instructions: client.instructions,
    });
    server.onerror = error => console.error('Junie MCP relay server error:', asError(error));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {} } = request.params;
      if (!MODEL_TOOLS.has(name)) return { isError: true, content: [{ type: 'text', text: `Unknown LCU tool: ${name}` }] };
      const sessionId = current ?? fallback;
      const turn = await turnOf(sessionId);
      const approvals = new Set();
      turn.calls++;
      inFlight.add(approvals);
      try {
        const result = await persistAudioContent(await client.call(name, args, {
          sessionId, turnId: turn.turnId, toolCallId: randomUUID(), signal: extra.signal,
        }));
        const added = [...approvals].map(app => ({ type: 'text', text: approvalHint(app, lcu) }));
        // A session whose first prompt the hook could not reach (the relay started later) gets the original
        // instructions with its first call result instead, once. They go first: Junie saves a long result to a
        // file and the model may read only its beginning.
        const state = stateOf(sessionId);
        const leading = [];
        if (!state.told && client.instructions) {
          state.told = true;
          leading.push({ type: 'text', text: `${INSTRUCTIONS_HEADER}\n\n${client.instructions}` });
        }
        if (!added.length && !leading.length) return result;
        return { ...result, content: [...leading, ...(result.content ?? []), ...added] };
      } finally {
        inFlight.delete(approvals);
        turn.calls--;
      }
    });
    server.onclose = () => { void close(); };
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
  // The SDK's stdio transport does not surface stdin EOF, which is how Junie closes the server.
  process.stdin.once('end', () => { void close(); });
  return { server, socketPath, sessions, close };
}

/** The parent pid of `pid`, or undefined. */
function parentOf(pid) {
  try {
    const parent = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isInteger(parent) && parent > 1 ? parent : undefined;
  } catch {
    return undefined;
  }
}

/** Send one request to a relay socket; resolves to its result, or rejects. */
function ask(socketPath, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, timeoutMs);
    const done = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.on('error', error => done(error));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response?.ok) done(undefined, response.result ?? {});
        else done(new Error(typeof response?.error === 'string' ? response.error : 'relay refused the hook'));
      } catch (error) {
        done(error);
      }
    });
    socket.on('end', () => done(new Error('relay closed the connection')));
  });
}

/**
 * Junie command hook: tell the relays of the Junie process that runs this hook about `hook_event_name`, and
 * print UserPromptSubmit's additional context. It never blocks or fails Junie: every problem exits 0 silently.
 */
export async function runJunieHook({
  stdin = readFileSync(0, 'utf8'), env = process.env, directory = controlDirectory({ env }),
  parent = process.ppid, write = text => process.stdout.write(text),
} = {}) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return;
  }
  const event = input?.hook_event_name;
  if (!Object.hasOwn(HOOK_EVENTS, event) || typeof input.session_id !== 'string' || !input.session_id) return;
  let names;
  try {
    if (!statSync(directory).isDirectory()) return;
    names = readdirSync(directory);
  } catch {
    return;
  }
  const timeoutMs = (HOOK_TIMEOUTS[event] - 2) * 1000;
  const contexts = [];
  for (let pid = parent, depth = 0; pid && depth < HOOK_ANCESTORS; pid = parentOf(pid), depth++) {
    const sockets = names.filter(name => name.startsWith(`${pid}-`) && name.endsWith('.sock'));
    if (!sockets.length) continue;
    await Promise.all(sockets.map(async name => {
      const socketPath = join(directory, name);
      try {
        const result = await ask(socketPath, { hook_event_name: event, session_id: input.session_id }, timeoutMs);
        if (typeof result.additional_context === 'string' && result.additional_context) {
          contexts.push(result.additional_context);
        }
      } catch (error) {
        // A relay that exited without removing its socket.
        if (['ECONNREFUSED', 'ENOENT'].includes(error?.code)) rmSync(socketPath, { force: true });
      }
    }));
    break;
  }
  if (event === 'UserPromptSubmit' && contexts.length) {
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: contexts.join('\n\n') } }));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--hook') {
    await runJunieHook().catch(() => {});
    return;
  }
  if (!argv.length) throw new Error('Usage: junie.mjs ORIGINAL_MCP_COMMAND [ARG ...] | junie.mjs --hook');
  const relay = await runJunieRelay({ command: argv, cwd: process.cwd() });
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { relay.close().finally(() => process.exit(0)); });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error('Junie MCP relay failed:', asError(error));
    process.exitCode = 1;
  });
}
