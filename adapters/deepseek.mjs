import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  APPROVAL_TIMEOUT_MS,
  MODEL_TOOLS,
  callOutcome,
  callTimeout,
  callWithDeadline,
  createAppUpdateRestart,
  createApprovalGate,
  createApprovalLogger,
  createCallTracker,
  isMainModule,
  nativeAppApprovalOptions,
  nativeAppApprovalResponse,
  relayElicitation,
  selectedAppBuild,
} from './client.mjs';
import { promptForApproval } from './deepseek-approval.mjs';
import { openDiagnosticLog } from './diagnostics.mjs';
import { declineAgentHostApp } from './host-guard.mjs';

/**
 * DeepSeek Harness relay.
 *
 * The harness launches this file as a stdio MCP server and speaks MCP to it; this file starts the
 * installed LCU server (`bin/lcu`, the original CUA MCP server through the selected app's Node) and
 * relays the model-visible tools. Nothing here implements computer use: schemas, instructions,
 * execution and policy stay upstream, as for every other LCU adapter.
 *
 * Two host adaptations, both recorded in docs/ADAPTERS.md:
 *
 * 1. Only the model tools `js` and `js_reset` are listed. Host-only tools (`turn_ended`,
 *    `js_add_node_module_dir`) stay out of the model's tool list. The harness has no turn lifecycle
 *    hook, so the relay never ends a turn: computer use stays available for the whole session, which
 *    is the same effect as `lcu cross-turn on` in Claude Code. No `x-codex-turn-metadata` is
 *    injected; the installed server falls back to the connection-scoped identity it derives itself.
 * 2. The harness MCP client does not advertise form elicitation, so the relay cannot forward an
 *    approval. It presents the runtime's own question natively instead and answers from that choice
 *    (see deepseek-approval.mjs). When the client does advertise elicitation, the request is
 *    forwarded unchanged and the harness renders it.
 */

function report(label, error) {
  console.error(`${label}:`, error instanceof Error ? error.message : String(error));
}

export async function runDeepseekBridge({
  command, args = [], cwd, env, log = openDiagnosticLog({ adapter: 'deepseek' }), appBuild, prompt,
} = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('DeepSeek bridge requires the original MCP command and string arguments');
  }

  const restarts = createAppUpdateRestart({ log,
    build: appBuild ?? (() => selectedAppBuild([command, ...args], { cwd, env: env ?? process.env })) });
  // The current original server: { client, generation, retired }. A restart after an app update replaces it.
  let link;
  let restarting;
  let restartFailure;
  let originalCapabilities;
  let server;
  let connected = false;
  let shutdown;
  let serverClose;
  // Unattended machines (CI, a headless run) get a refusal instead of a question. Nothing is
  // approved implicitly: `deny` answers every approval request with the runtime's own cancellation.
  const approvalMode = String((env ?? process.env).LCU_DEEPSEEK_APPROVAL ?? '').trim().toLowerCase();
  // Dialogs that are open right now, so shutdown can close them instead of leaving a question behind.
  const liveDialogs = new Set();
  const approvals = createApprovalGate();
  const calls = createCallTracker(log);
  const approvalLog = createApprovalLogger(log, calls);
  const settled = () => restarting?.catch(() => {});

  /** True once the harness said it can render server-initiated form requests itself. */
  const clientCanElicit = () => {
    const capabilities = server?.getClientCapabilities?.();
    return Boolean(capabilities && capabilities.elicitation);
  };

  const elicitationHandler = async (request, extra) => {
    const refused = declineAgentHostApp(request.params);
    const approval = nativeAppApprovalOptions(request.params);
    const entry = approvalLog.open(refused ? 'agent_host_refused' : approval ? 'native_app' : 'other', request.params);
    let response = refused;
    if (!response) {
      try {
        response = await answerElicitation(request.params, approval, extra.signal);
      } catch {
        response = { action: 'cancel' };
      }
    }
    entry.end(response);
    return response;
  };

  /** Forward the request when the harness can present it, else present it here. */
  async function answerElicitation(params, approval, signal) {
    // A refusal configured here outranks every other path, including a harness that could answer for
    // itself: on an unattended machine nothing may approve, whoever is attached.
    if (approvalMode === 'deny') return { action: 'cancel' };
    if (clientCanElicit()) return relayElicitation(server, approvals, params, signal);
    // Only a native-app approval has a question this relay knows how to ask. A browser-origin or an
    // unknown form is cancelled, never guessed: LCU keeps no permission cache.
    if (!approval) return { action: 'cancel' };
    if (signal?.aborted) return { action: 'cancel' };
    // The dialog is closed, not just abandoned, when the request ends or the relay shuts down.
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    signal?.addEventListener('abort', stop, { once: true });
    liveDialogs.add(stopping);
    try {
      const chosen = await approvals.track(() =>
        (prompt ?? promptForApproval)(approval, { signal: stopping.signal }));
      return nativeAppApprovalResponse(params, chosen);
    } finally {
      liveDialogs.delete(stopping);
      signal?.removeEventListener('abort', stop);
    }
  }

  /** Start one original server with this relay's handlers; one that fails is closed. */
  async function openUpstream() {
    const generation = restarts.begin();
    const transport = new StdioClientTransport({
      command,
      args,
      ...(cwd ? { cwd } : {}),
      env: env ?? process.env,
      stderr: 'inherit',
    });
    const client = new Client({ name: 'lcu-deepseek-relay', version: '0.1.0' }, {
      capabilities: { elicitation: { form: {}, url: {} } },
    });
    const next = { client, generation, retired: false };
    client.setRequestHandler(ElicitRequestSchema, elicitationHandler);
    const connectStarted = Date.now();
    try {
      await client.connect(transport);
      log.event('upstream_connect', { ms: Date.now() - connectStarted, ok: true });
    } catch (error) {
      log.event('upstream_connect', { ms: Date.now() - connectStarted, ok: false });
      await client.close().catch(() => {});
      throw error;
    }
    const capabilities = client.getServerCapabilities() ?? {};
    if (!capabilities.tools) {
      await client.close().catch(() => {});
      throw new Error('Original CUA server does not advertise tools');
    }
    if (capabilities.tools.listChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async notification => {
        if (server && originalCapabilities?.tools?.listChanged) await server.notification(notification);
      });
    }
    client.onerror = error => report('DeepSeek MCP relay upstream error', error);
    client.onclose = () => {
      // A server this relay replaced closes without ending the relay.
      if (!next.retired && server && server.transport) {
        serverClose ??= server.close().catch(error => {
          report('DeepSeek MCP relay close failed', error);
        });
      }
    };
    return next;
  }

  /** Close the old original server, then start a fresh one after the selected app changed. */
  function restartUpstream() {
    restarting ??= (async () => {
      const old = link;
      link = undefined;
      connected = false;
      if (old) old.retired = true;
      try {
        await old?.client.close();
      } catch (error) {
        report('DeepSeek MCP upstream close failed', error);
      }
      log.event('upstream_close', { cause: 'app_updated' });
      try {
        if (shutdown) throw new Error('the relay is shutting down');
        const next = await openUpstream();
        if (shutdown) {
          next.retired = true;
          await next.client.close().catch(() => {});
          throw new Error('the relay is shutting down');
        }
        link = next;
        connected = true;
      } catch (error) {
        restartFailure = error;
        throw error;
      }
    })().finally(() => { restarting = undefined; });
    return restarting;
  }

  const modelToolResult = error => ({
    isError: true,
    content: [{ type: 'text', text: `LCU could not restart the computer-use runtime: ${error.message}` }],
  });

  try {
    link = await openUpstream();
    connected = true;
    const upstream = link.client;
    originalCapabilities = upstream.getServerCapabilities() ?? {};
    server = new Server(upstream.getServerVersion() ?? { name: 'lcu', version: '0.1.0' }, {
      capabilities: {
        tools: originalCapabilities.tools.listChanged ? { listChanged: true } : {},
      },
      ...(upstream.getInstructions() === undefined ? {} : { instructions: upstream.getInstructions() }),
    });
    server.onerror = error => report('DeepSeek MCP relay server error', error);

    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      await settled();
      if (!link) throw new Error('The original CUA server is not running');
      const listed = await link.client.listTools(request.params, { signal: extra.signal });
      return { ...listed, tools: listed.tools.filter(tool => MODEL_TOOLS.has(tool.name)) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { params } = request;
      if (!MODEL_TOOLS.has(params.name)) {
        throw new Error(`Unknown LCU tool: ${params.name}`);
      }
      // A call that arrives while a restart replaces the original server runs on the fresh one.
      await settled();
      const current = link;
      if (!current) {
        if (params.name === 'js' || params.name === 'js_reset') {
          return modelToolResult(restartFailure ?? new Error('the original CUA server is not running'));
        }
        throw new Error('The original CUA server is not running');
      }
      return calls.track(params.name, { timeout_ms: params.arguments?.timeout_ms, signal: extra.signal }, async () => {
        const outcome = await callOutcome(() => callWithDeadline(approvals,
          callTimeout(params.name, params.arguments), extra.signal,
          signal => current.client.callTool(params, undefined, { signal, timeout: APPROVAL_TIMEOUT_MS })));
        const replaced = params.name === 'js'
          ? await restarts.afterJs(current.generation, outcome, restartUpstream) : undefined;
        if (replaced) return replaced;
        if ('error' in outcome) throw outcome.error;
        return outcome.result;
      });
    });

    const closeUpstream = () => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        for (const dialog of [...liveDialogs]) dialog.abort();
        // A restart still starting its fresh server closes that one itself once it sees the shutdown.
        if (connected) {
          connected = false;
          try {
            await link.client.close();
          } catch (error) {
            report('DeepSeek MCP upstream close failed', error);
          }
          log.event('upstream_close');
        }
      })();
      return shutdown;
    };
    server.onclose = () => { void closeUpstream(); };
    const closeDownstream = () => {
      serverClose ??= server.close().catch(error => {
        report('DeepSeek MCP relay close failed', error);
      });
      return serverClose;
    };
    await server.connect(new StdioServerTransport());
    // The SDK stdio server does not report stdin EOF through onclose.
    process.stdin.once('end', closeDownstream);
    return {
      server,
      get upstream() { return link?.client; },
      close: async () => {
        process.stdin.off('end', closeDownstream);
        await closeDownstream();
        await closeUpstream();
      },
    };
  } catch (error) {
    if (connected) await link.client.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: deepseek.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
  await runDeepseekBridge({ command, args });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    report('DeepSeek MCP relay failed', error);
    process.exitCode = 1;
  });
}
