// Antigravity relay: a stdio MCP server for Google Antigravity (CLI, App, IDE) in front of the original runtime,
// through the shared client. Antigravity writes MCP initialization instructions to disk instead of injecting them
// into the model context, rejects eager tools whose input schema has a top-level `oneOf` (which conflicts with
// Antigravity's injected `toolSummary` field), silently leaves out a tool whose definition is long (seen with
// Antigravity CLI 1.5.17; see TOOL_DEFINITION_BUDGET), and Antigravity CLI 1.5.11 cancels `elicitation/create`
// requests immediately even though it advertises elicitation support. Antigravity's own command hooks (`antigravity.mjs
// --hook`, installed by `lcu setup --agent antigravity`) reach this relay over a private Unix socket named for the
// Antigravity process that runs both: they deliver the original instructions once per conversation through
// `injectSteps` and end turns on `Stop` (while preserving concurrent conversations and subagents using Antigravity's
// per-call `_meta["antigravity.google/conversation_id"]`). Native-app approvals are forwarded as a form when the
// client advertises form elicitation; when the client cancels or cannot show the prompt, the call result tells the
// model to run `lcu apps allow <App>` itself (Touch ID or password, lasting until revoked) and to offer `lcu apps
// revoke <App>` when its task is done.
import { readFileSync } from 'node:fs';
import {
  APPROVAL_TIMEOUT_MS,
  isMainModule,
  mergedToolDescriptor,
  nativeAppApprovalOptions,
  nativeApprovalForm,
  nativeAppApprovalResponse,
} from './client.mjs';
import {
  approvalHint as hookRelayApprovalHint, askRelays, asError, controlDirectory as hookRelayDirectory,
  INSTRUCTIONS_HEADER, launcherOf, runHookRelay, SHUTDOWN_DRAIN_TIMEOUT_MS,
} from './hook-relay.mjs';

export { INSTRUCTIONS_HEADER, launcherOf, SHUTDOWN_DRAIN_TIMEOUT_MS };

/** The Antigravity hook events LCU registers, with the default LCU turn end each one means. */
export const HOOK_EVENTS = {
  SessionStart: null,
  PreInvocation: null,
  Stop: 'Stop',
};
/** Seconds Antigravity gives each hook (`timeout` in hooks.json); the hook gives up on the relay a little earlier. */
export const HOOK_TIMEOUTS = { SessionStart: 10, PreInvocation: 30, Stop: 60 };
/** Per-call metadata key Antigravity attaches to `tools/call` naming the active conversation or subagent. */
export const CONVERSATION_ID_META = 'antigravity.google/conversation_id';
/** Ancestors of the hook checked for a relay: `sh -c`, then Antigravity (plus wrappers). */
const HOOK_ANCESTORS = 4;
const APPROVAL_REASON = 'Antigravity could not show the approval prompt';
/**
 * Longest listed tool definition, as `JSON.stringify({description, inputSchema}).length`. Antigravity CLI 1.5.17
 * silently leaves out an MCP tool whose definition is longer than roughly 850 to 900 characters (issue #93: 850
 * was listed, 900 was not), so the model never sees it and calls fail with "tool js is not enabled for server lcu".
 */
export const TOOL_DEFINITION_BUDGET = 700;

const definitionSize = ({ description, inputSchema }) => JSON.stringify({ description, inputSchema }).length;

/**
 * The descriptor Antigravity lists for an original public tool, and the original text that no longer fits in it:
 * `{tool, instructions}`. A top-level `oneOf`/`anyOf` becomes one object (`mergedToolDescriptor`). A definition
 * over `budget` then keeps the start of its original description, cut at a word, plus a note naming the session
 * instructions; if that is not enough, its top-level property descriptions go too. Types, limits and `required`
 * stay as they are. `instructions` holds the unchanged original description and property descriptions that were
 * taken out, for the relay to deliver with the original instructions ('' when the descriptor is complete).
 */
export function antigravityToolDescriptor(original, budget = TOOL_DEFINITION_BUDGET) {
  const tool = mergedToolDescriptor(original);
  if (definitionSize(tool) <= budget) return { tool, instructions: '' };
  const full = typeof tool.description === 'string' ? tool.description : '';
  const note = `[LCU: shortened for Antigravity. The rest of the \`${tool.name}\` tool's description is in this ` +
    "session's Computer Use instructions.]";
  const describe = (excerpt) => (excerpt ? `${excerpt} ${note}` : note);
  const first = full.trim().split(/\n\s*\n/)[0].trim();
  let inputSchema = tool.inputSchema;
  const moved = [];
  if (definitionSize({ description: describe(first), inputSchema }) > budget) {
    const properties = {};
    for (const [name, property] of Object.entries(inputSchema?.properties ?? {})) {
      if (property && typeof property === 'object' && typeof property.description === 'string') {
        const { description, ...rest } = property;
        moved.push(`- \`${name}\`: ${description}`);
        properties[name] = rest;
      } else {
        properties[name] = property;
      }
    }
    if (moved.length) inputSchema = { ...inputSchema, properties };
  }
  let excerpt = first;
  while (excerpt && definitionSize({ description: describe(excerpt), inputSchema }) > budget) {
    excerpt = excerpt.slice(0, Math.max(0, excerpt.lastIndexOf(' '))).trimEnd();
  }
  if (excerpt !== first) excerpt = excerpt && `${excerpt} ...`;
  const sections = [];
  if (excerpt !== full) sections.push(`Full description of the \`${tool.name}\` tool:\n\n${full}`);
  if (moved.length) sections.push(`Arguments of the \`${tool.name}\` tool:\n\n${moved.join('\n')}`);
  return { tool: { ...tool, description: describe(excerpt), inputSchema }, instructions: sections.join('\n\n') };
}

/**
 * The private directory of relay sockets: `LCU_ANTIGRAVITY_CONTROL_DIR` (tests), else LCU's state or temporary
 * one.
 */
export function controlDirectory(options) {
  return hookRelayDirectory('antigravity', 'LCU_ANTIGRAVITY_CONTROL_DIR', options);
}

/** The tool-result text that replaces an approval prompt Antigravity did not show. `lcu` is the launcher to name. */
export function approvalHint(app, lcu = 'lcu') {
  return hookRelayApprovalHint(app, lcu, APPROVAL_REASON);
}

/** Map Antigravity's Stop `terminationReason` to LCU's upstream turn-end event. */
export function stopEventOf(terminationReason) {
  return terminationReason === undefined || terminationReason === '' || terminationReason === 'NO_TOOL_CALL'
    ? 'Stop' : 'Interrupt';
}

/**
 * Run the relay on stdio. `hostPid` is the Antigravity process that started it, which also runs the hooks.
 * `createClient` (tests) replaces createCuaClient.
 */
export function runAntigravityRelay({ env = process.env, directory = controlDirectory({ env }), ...options } = {}) {
  return runHookRelay({
    ...options, env, directory, name: 'antigravity', host: 'Antigravity', approvalReason: APPROVAL_REASON,
    harness: (relay) => {
      const { client, sessions, fallback, stateOf, finish, noteApproval } = relay;
      // Most recently observed conversation id from hooks (used only when `_meta` omits `conversation_id`).
      let current;

      async function onElicitation(params, { signal }) {
        const approval = nativeAppApprovalOptions(params);
        const server = relay.server;
        const clientCaps = server?.getClientCapabilities?.();
        if (approval) {
          if (clientCaps?.elicitation?.form) {
            try {
              const answer = await server.elicitInput(nativeApprovalForm(params, approval), {
                signal, timeout: APPROVAL_TIMEOUT_MS,
              });
              if (answer?.action === 'accept' && typeof answer.content?.choice === 'string') {
                return nativeAppApprovalResponse(params, answer.content.choice);
              }
              if (answer?.action === 'decline') return { action: 'decline' };
            } catch {
              // Fall through to cancel + approvalHint when the surface cannot answer elicitation.
            }
          }
          noteApproval(approval.resource);
          // Cancel, not decline: nothing is decided, so a retry after `lcu apps allow` is not refused.
          return { action: 'cancel' };
        }
        if (clientCaps?.elicitation) {
          try {
            const answer = await server.elicitInput(params, { signal, timeout: APPROVAL_TIMEOUT_MS });
            if (answer?.action === 'accept' || answer?.action === 'decline' || answer?.action === 'cancel') {
              return answer;
            }
          } catch {
            // Fall through to cancel.
          }
        }
        return { action: 'cancel' };
      }

      /** The original instructions, then the original tool text that Antigravity's listing could not hold. */
      function sessionInstructions() {
        return [client.instructions, ...client.publicTools().map(tool => antigravityToolDescriptor(tool).instructions)]
          .filter(Boolean).join('\n\n');
      }

      function instructionsFor(state) {
        if (state.told) return {};
        const instructions = sessionInstructions();
        if (!instructions) return {};
        state.told = true;
        return { systemMessage: instructions };
      }

      /** Answer one hook `{hookEventName, conversationId, invocationNum?, terminationReason?}`: `{systemMessage?}`. */
      async function onHook({ hookEventName: event, conversationId, invocationNum, terminationReason }) {
        if (!Object.hasOwn(HOOK_EVENTS, event) || typeof conversationId !== 'string' || !conversationId) {
          throw new Error('Expected an Antigravity hook event and conversationId');
        }
        if (event === 'SessionStart') {
          current = conversationId;
          return instructionsFor(stateOf(conversationId));
        }
        if (event === 'PreInvocation') {
          const early = current === undefined ? sessions.get(fallback) : undefined;
          if (early) {
            // Mid-turn continuation of a call that ran under the fallback session: keep `fallback` adoptable by Stop.
            if (invocationNum > 0) return early.told ? {} : instructionsFor(early);
            current = conversationId;
            if (early.told) stateOf(conversationId).told = true;
            if (early.active) await finish(fallback, early.active.calls > 0 ? 'Interrupt' : 'Stop').catch(() => {});
          }
          current = conversationId;
          const state = stateOf(conversationId);
          // `invocationNum === 0` marks the start of a new user turn; if a previous turn ended without firing Stop,
          // close it here. Mid-turn continuations (`invocationNum > 0`) stay inside the same open turn.
          if ((invocationNum === undefined || invocationNum === 0) && state.active) {
            await finish(conversationId, state.active.calls > 0 ? 'Interrupt' : 'Stop').catch(() => {});
          }
          return instructionsFor(state);
        }
        // Stop
        const stopEvent = stopEventOf(terminationReason);
        if (current === undefined && sessions.has(fallback) && !sessions.has(conversationId)) {
          current = conversationId;
          if (sessions.get(fallback).told) stateOf(conversationId).told = true;
          await finish(fallback, stopEvent);
          return {};
        }
        if (!sessions.has(conversationId)) return {};
        await finish(conversationId, stopEvent);
        return {};
      }

      return {
        onHook,
        onElicitation,
        describeTool: tool => antigravityToolDescriptor(tool).tool,
        instructions: sessionInstructions,
        // The conversation or subagent Antigravity names on the call, else the one hooks last reported.
        sessionOf: ({ _meta }) => (typeof _meta?.[CONVERSATION_ID_META] === 'string' && _meta[CONVERSATION_ID_META]
          ? _meta[CONVERSATION_ID_META] : current),
      };
    },
  });
}

/**
 * Antigravity command hook: tell the relays of the Antigravity process that runs this hook about `hookEventName`,
 * and print `injectSteps` for `SessionStart`/`PreInvocation` when the relay returns original instructions.
 * Always writes valid JSON (`{}` when there is nothing to inject) and exits 0 so Antigravity is never blocked.
 */
export async function runAntigravityHook({
  stdin = readFileSync(0, 'utf8'), env = process.env, directory = controlDirectory({ env }),
  parent = process.ppid, write = text => process.stdout.write(text),
} = {}) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    write('{}');
    return;
  }
  const event = input?.hookEventName;
  const conversationId = input?.conversationId;
  if (!Object.hasOwn(HOOK_EVENTS, event) || typeof conversationId !== 'string' || !conversationId) {
    write('{}');
    return;
  }
  const payload = {
    hookEventName: event,
    conversationId,
    ...(typeof input.invocationNum === 'number' ? { invocationNum: input.invocationNum } : {}),
    ...(typeof input.terminationReason === 'string' ? { terminationReason: input.terminationReason } : {}),
  };
  const results = await askRelays(payload,
    { directory, parent, ancestors: HOOK_ANCESTORS, timeoutSeconds: HOOK_TIMEOUTS[event] });
  const unique = [...new Set(results.map(result => result.systemMessage)
    .filter(message => typeof message === 'string' && message))];
  if ((event === 'SessionStart' || event === 'PreInvocation') && unique.length) {
    write(JSON.stringify({
      injectSteps: unique.map(text => ({ systemMessage: { systemMessage: text } })),
    }));
    return;
  }
  write('{}');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--hook') {
    await runAntigravityHook().catch(() => process.stdout.write('{}'));
    return;
  }
  if (!argv.length) throw new Error('Usage: antigravity.mjs ORIGINAL_MCP_COMMAND [ARG ...] | antigravity.mjs --hook');
  await runAntigravityRelay({ command: argv });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error('Antigravity MCP relay failed:', asError(error));
    process.exit(1);
  });
}
