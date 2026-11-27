// `lcu mcp`: the stdio MCP server to register with any MCP client LCU has no adapter for (Amp, for one). It is the
// hook relay without hooks, in front of the original server that bare `lcu` starts:
// - It lists the original `js` and `js_reset` with any top-level oneOf/anyOf merged, which many clients reject, and
//   puts the original instructions before the first call result, since many clients ignore server instructions.
// - A native-app approval is shown as a form of the original request's choices when the client supports form
//   elicitation. Otherwise the request is cancelled and the call result tells the model what to do: on macOS, run
//   `lcu apps allow <App>` (Touch ID or password), retry, and offer `lcu apps revoke <App>` afterwards.
// - With no hooks, nothing reports turn ends: each connection is one LCU turn, interrupted when the client
//   disconnects or the relay is stopped.
import { isMainModule, mergedToolDescriptor } from './client.mjs';
import { approvalHint, asError, elicitThroughClient, runHookRelay } from './hook-relay.mjs';

const APPROVAL_REASON = 'this MCP client could not show the approval prompt';

/** The call-result text that replaces an approval prompt the client did not show, for `platform`. */
export function mcpApprovalHint(app, lcu = 'lcu', platform = process.platform) {
  // Only macOS has `lcu apps`; Windows approvals need a client that can show the prompt.
  if (platform === 'darwin') return approvalHint(app, lcu, APPROVAL_REASON);
  return `LCU: Computer Use needs the person's approval to control ${app}, and ${APPROVAL_REASON}. ` +
    'On this platform LCU can only ask through a client that shows MCP form elicitation, or a harness that ' +
    '`lcu setup --agent` registers. Tell the person, and do not retry.';
}

/** Run the relay on stdio in front of `command` (the bare `lcu` server). `createClient` (tests) replaces createCuaClient. */
export function runMcpRelay({ platform = process.platform, ...options }) {
  return runHookRelay({
    ...options, name: 'mcp', host: 'MCP client', approvalReason: APPROVAL_REASON,
    hint: (app, lcu) => mcpApprovalHint(app, lcu, platform),
    harness: relay => ({
      sessionOf: () => undefined,
      describeTool: mergedToolDescriptor,
      onElicitation: (params, extra) => elicitThroughClient(relay, params, extra),
    }),
  });
}

/** Serve until the client disconnects or a signal stops the relay, then exit. */
export async function serve(command, { cwd = process.cwd(), env = process.env } = {}) {
  const relay = await runMcpRelay({ command, cwd, env });
  // SIGINT too: Ctrl-C in a terminal client reaches its whole process group.
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.once(signal, () => { void relay.close(); });
  await relay.done;
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  const command = process.argv.slice(2);
  if (!command.length) {
    console.error('Usage: mcp.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
    process.exit(2);
  }
  serve(command).catch(error => {
    console.error('LCU MCP relay failed:', asError(error));
    process.exit(1);
  });
}
