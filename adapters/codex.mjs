import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { persistAudioContent } from './audio-files.mjs';
import {
  APPROVAL_TIMEOUT_MS,
  callTimeout,
  callWithDeadline,
  createApprovalGate,
  isMainModule,
  relayElicitation,
} from './client.mjs';

const HOST_ONLY_TOOLS = new Set(['js_add_node_module_dir', 'turn_ended']);

function report(label, error) {
  console.error(`${label}:`, error instanceof Error ? error.message : String(error));
}

/** Relay the original Codex CUA MCP server and replace only returned audio blocks. */
export async function runCodexBridge({ command, args = [], cwd, env } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) ||
      args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Codex bridge requires the original MCP command and string arguments');
  }

  const upstreamTransport = new StdioClientTransport({
    command,
    args,
    ...(cwd ? { cwd } : {}),
    env: env ?? process.env,
    stderr: 'inherit',
  });
  const upstream = new Client({ name: 'lcu-codex-relay', version: '0.1.0' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  let server;
  let connected = false;
  let shutdown;
  let nextProgressToken = 0;
  const approvals = createApprovalGate();
  const progressHandlers = new Map();

  upstream.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    try {
      return await relayElicitation(server, approvals, request.params, extra.signal);
    } catch {
      return { action: 'cancel' };
    }
  });

  try {
    await upstream.connect(upstreamTransport);
    connected = true;
    // SDK 1.x removes a request's progress callback as soon as its response is
    // parsed, while notification handlers run in a later microtask. A progress
    // frame adjacent to its result can therefore be rejected as an unknown
    // token. Route progress through the public notification-handler API and
    // keep our own per-call token until the tool call settles; late frames are
    // benign and ignored.
    upstream.setNotificationHandler(ProgressNotificationSchema, async notification => {
      const { progressToken, ...progress } = notification.params;
      const handler = progressHandlers.get(progressToken);
      if (handler) await handler(progress);
    });
    const originalCapabilities = upstream.getServerCapabilities() ?? {};
    if (!originalCapabilities.tools) {
      throw new Error('Original CUA server does not advertise tools');
    }
    const capabilities = {
      tools: originalCapabilities.tools.listChanged ? { listChanged: true } : {},
    };
    const serverOptions = { capabilities };
    const instructions = upstream.getInstructions();
    if (instructions !== undefined) serverOptions.instructions = instructions;
    server = new Server(upstream.getServerVersion() ?? { name: 'lcu-codex-relay', version: '0.1.0' }, serverOptions);
    server.onerror = error => report('Codex MCP relay server error', error);
    upstream.onerror = error => report('Codex MCP relay upstream error', error);

    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const listed = await upstream.listTools(request.params, { signal: extra.signal });
      return { ...listed, tools: listed.tools.filter(tool => !HOST_ONLY_TOOLS.has(tool.name)) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { params } = request;
      const progressSends = [];
      let upstreamParams = params;
      const downstreamProgressToken = extra._meta?.progressToken;
      let upstreamProgressToken;
      if (downstreamProgressToken !== undefined) {
        upstreamProgressToken = `lcu-codex-${++nextProgressToken}`;
        upstreamParams = {
          ...params,
          _meta: { ...params._meta, progressToken: upstreamProgressToken },
        };
        progressHandlers.set(upstreamProgressToken, progress => {
          const send = extra.sendNotification({
            method: 'notifications/progress',
            params: { ...progress, progressToken: downstreamProgressToken },
          }).catch(error => report('Codex MCP progress relay error', error));
          progressSends.push(send);
          return send;
        });
      }
      try {
        const result = await callWithDeadline(approvals, callTimeout(params.name, params.arguments),
          extra.signal, signal => upstream.callTool(upstreamParams, undefined, {
            signal,
            timeout: APPROVAL_TIMEOUT_MS,
          }));
        return persistAudioContent(result);
      } finally {
        if (upstreamProgressToken !== undefined) progressHandlers.delete(upstreamProgressToken);
        // Drain notifications on both success and failure so neither a result
        // nor an error can overtake progress already accepted for this call.
        await Promise.all(progressSends);
      }
    });

    if (originalCapabilities.tools.listChanged) {
      upstream.setNotificationHandler(ToolListChangedNotificationSchema, async notification => {
        await server.notification(notification);
      });
    }

    const closeUpstream = () => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        if (connected) {
          connected = false;
          try {
            await upstream.close();
          } catch (error) {
            report('Codex MCP upstream close failed', error);
          }
        }
      })();
      return shutdown;
    };
    server.onclose = () => { void closeUpstream(); };
    let serverClose;
    upstream.onclose = () => {
      if (server && server.transport) {
        if (!serverClose) serverClose = server.close().catch(error => {
          report('Codex MCP relay close failed', error);
        });
      }
    };
    const closeDownstream = () => {
      if (!serverClose) serverClose = server.close().catch(error => {
        report('Codex MCP relay close failed', error);
      });
      return serverClose;
    };
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // The SDK stdio server does not report stdin EOF through onclose.
    process.stdin.once('end', closeDownstream);
    return {
      server,
      upstream,
      close: async () => {
        process.stdin.off('end', closeDownstream);
        await closeDownstream();
        await closeUpstream();
      },
    };
  } catch (error) {
    if (connected) await upstream.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: codex.mjs ORIGINAL_MCP_COMMAND [ARG ...]');
  await runCodexBridge({ command, args });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    report('Codex MCP relay failed', error);
    process.exitCode = 1;
  });
}
