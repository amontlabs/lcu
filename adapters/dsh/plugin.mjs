// DeepSeek Harness (DSH) host plugin: the original runtime's js and js_reset tools, its instructions, its
// native-app approvals through DSH's question card, and its turn cleanup on DSH's turn end. The generated
// bundle `lcu setup --agent dsh` links imports DSH's own MCP tool helper and passes it in (see apply).
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCuaClient, nativeAppApprovalOptions, nativeAppApprovalResponse } from '../client.mjs';
import { persistAudioContent } from '../audio-files.mjs';

export const name = 'lcu-computer-use';
export const inject = ['tools', 'systemPrompt'];

/** After DSH's MCP servers section (MCP_SERVERS, 3100 in @deepseek-ai/dsh-system-prompt). */
export const PROMPT_ORDER = 3100;
export const PROMPT_SECTION = 'lcu-computer-use';
const QUESTION_ID = 'lcu-app-approval';

/** The lcu argv: `LCU_MCP_COMMAND` (tests), the generated bundle's `command`, or this release's launcher. */
export function commandFrom(config) {
  const raw = process.env.LCU_MCP_COMMAND;
  if (raw) return JSON.parse(raw);
  if (Array.isArray(config?.command)) return config.command;
  const runtime = fileURLToPath(new URL('../../bin/lcu', import.meta.url));
  if (process.platform === 'darwin') return [runtime];
  if (process.platform === 'linux') {
    const session = fileURLToPath(new URL('../../bin/lcu-session', import.meta.url));
    return [session, '--user', userInfo().username, '--', runtime];
  }
  throw new Error(`LCU does not support ${process.platform}`);
}

function originsFromEnvironment() {
  const raw = process.env.LCU_APPROVED_ORIGINS;
  return raw ? JSON.parse(raw) : [];
}

const SECRET_NAME = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * The environment of the lcu process: DSH's own, without its `DSH_*` variables and without names DSH
 * treats as credentials (its provider keys arrive in this process's environment). LCU reads none of them.
 */
export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    value !== undefined && !key.startsWith('DSH_') && !SECRET_NAME.test(key)));
}

const cancel = () => ({ action: 'cancel' });

/** Ask the person through DSH's question card; any refusal, error or free text cancels. */
async function ask(questions, agent, signal, question, detail, labels) {
  if (!questions || !agent) return undefined;
  try {
    const result = await questions.ask({ agent, signal, questions: [{ id: QUESTION_ID, question,
      ...(detail ? { detail } : {}), options: labels.map(label => ({ label })) }] });
    const answer = result?.answers?.find(item => item.id === QUESTION_ID);
    return answer && !answer.custom?.trim() && answer.selected?.length === 1 ? answer.selected[0] : undefined;
  } catch {
    // ASK_CANCELLED, ASK_ABORTED, NO_PROVIDER (headless, ACP), DELEGATED_CALLER (subagents), CALLER_NOT_LIVE.
    return undefined;
  }
}

/**
 * Cordis apply. `deps.createMcpToolDefinition` is DSH's `@deepseek-ai/dsh-mcp-client` helper, which gives
 * the results DSH's own content and image handling: the bundle resolves it from the DSH installation,
 * which only a linked bundle's own files can do. `deps.createClient` replaces createCuaClient in tests.
 */
export async function apply(ctx, config = {}, deps = {}) {
  const { createMcpToolDefinition, createClient = createCuaClient } = deps;
  if (typeof createMcpToolDefinition !== 'function') {
    throw new Error('LCU DSH plugin: load it through the bundle `lcu setup --agent dsh` generates');
  }
  // Session id -> { active: {turn, turnId}, pending: {turnId, event}, cleaning: Promise }.
  const sessions = new Map();
  // Tool calls in flight -> their agent: an approval is asked in the one agent with a call in flight.
  const inFlight = new Map();
  const log = message => ctx.logger?.warn?.(message);

  const client = createClient({
    command: commandFrom(config),
    cwd: process.cwd(),
    env: childEnvironment(),
    adapter: 'dsh',
    allowedOrigins: originsFromEnvironment(),
    onElicitation: async (params, { signal }) => {
      const agents = new Set(inFlight.values());
      const agent = agents.size === 1 ? [...agents][0] : undefined;
      const questions = ctx.get('userQuestions');
      const nativeApproval = nativeAppApprovalOptions(params);
      if (nativeApproval) {
        const selected = await ask(questions, agent, signal, nativeApproval.message,
          `Application: ${nativeApproval.resource}`, nativeApproval.choices.map(choice => choice.label));
        const value = nativeApproval.choices.find(choice => choice.label === selected)?.value ?? 'cancel';
        return nativeAppApprovalResponse(params, value);
      }
      const schema = params?.requestedSchema;
      if (params?.mode === 'url' || schema?.type !== 'object' ||
          Object.keys(schema.properties ?? {}).length !== 0 ||
          (schema.required?.length ?? 0) !== 0 || typeof params.message !== 'string') {
        return cancel();
      }
      const selected = await ask(questions, agent, signal, params.message, undefined, ['Allow', 'Decline']);
      if (selected === 'Allow') return { action: 'accept', content: {} };
      if (selected === 'Decline') return { action: 'decline' };
      return cancel();
    },
  });

  let closing;
  const close = () => closing ??= (async () => {
    await Promise.allSettled([...sessions.keys()].map(id => finish(id, 'Interrupt')));
    sessions.clear();
    await client.close();
  })();
  ctx.effect(() => close, 'lcu.client');

  /** End the session's LCU turn upstream; a failure keeps it pending for the session's next call. */
  async function finish(sessionId, event, turn) {
    const state = sessions.get(sessionId);
    if (!state) return;
    if (state.active && (turn === undefined || state.active.turn === turn)) {
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

  /** The LCU turn id of the agent's open DSH turn, ending an earlier one first. */
  async function turnOf(agent) {
    const session = agent?.session;
    if (!session?.id) throw new Error('LCU requires a DSH agent session');
    const boundary = ctx.get('sessionProjections')?.stateOf(session, 'turnBoundary');
    if (!boundary || boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === undefined) {
      throw new Error('LCU requires an active DSH agent turn');
    }
    const turn = boundary.lastTurn;
    let state = sessions.get(session.id);
    if (!state) sessions.set(session.id, state = {});
    if (state.active?.turn === turn) return state.active.turnId;
    // A turn whose end LCU missed, or whose cleanup failed, must finish before this turn's first action.
    try {
      await finish(session.id, 'Interrupt');
    } catch (error) {
      throw new Error('LCU is still finishing the previous turn, so Computer Use actions are paused. ' +
        `Try again in a few seconds. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (state.active?.turn !== turn) state.active = { turn, turnId: randomUUID() };
    return state.active.turnId;
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || !sessions.has(session?.id)) return;
    const reason = event.data?.reason?.kind;
    finish(session.id, reason === 'completed' ? 'Stop' : 'Interrupt', event.data?.turn)
      .catch(error => log(`LCU turn cleanup is pending: ${error instanceof Error ? error.message : String(error)}`));
  }, { global: true });
  ctx.on('session/disposed', (session) => {
    if (!sessions.has(session?.id)) return;
    finish(session.id, 'Interrupt').catch(() => {}).finally(() => sessions.delete(session.id));
  }, { global: true });

  await client.connect();
  const instructions = client.instructions;
  for (const tool of client.publicTools()) {
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: tool.name,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      // No timeoutMs: the client bounds each call and stops that deadline while an approval is open.
      async call(args, exec) {
        const turnId = await turnOf(exec.agent);
        inFlight.set(exec, exec.agent);
        try {
          return await persistAudioContent(await client.call(tool.name, args, {
            sessionId: exec.agent.session.id, turnId, toolCallId: exec.callId, signal: exec.signal,
            model: exec.agent.options?.model, reasoningEffort: exec.agent.options?.reasoningEffort,
          }));
        } finally {
          inFlight.delete(exec);
        }
      },
    }));
  }
  ctx.systemPrompt.section({ name: PROMPT_SECTION, order: PROMPT_ORDER, interpolate: false, text: () => instructions });
}
