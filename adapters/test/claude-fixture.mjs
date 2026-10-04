import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = value => {
  if (process.env.LCU_FIXTURE_LOG) {
    appendFileSync(process.env.LCU_FIXTURE_LOG, `${JSON.stringify(value)}\n`);
  }
};

const server = new Server({ name: 'original-cua-claude-contract-fixture', version: '1' }, {
  capabilities: { tools: {} },
  instructions: 'Original Claude relay fixture instructions. Preserve this text exactly.',
});

server.onerror = error => log({ type: 'server-error', message: String(error) });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'js', description: 'Original JavaScript tool description.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
  } },
  { name: 'js_reset', description: 'Original JavaScript reset description.', inputSchema: {
    type: 'object', properties: {}, additionalProperties: false,
  } },
  { name: 'js_add_node_module_dir', description: 'Original internal tool.', inputSchema: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  } },
  { name: 'turn_ended', description: 'Original lifecycle tool.', inputSchema: {
    type: 'object', properties: {
      hook_event_name: { type: 'string' }, session_id: { type: 'string' }, turn_id: { type: 'string' },
    }, required: ['hook_event_name', 'session_id', 'turn_id'],
  } },
] }));

function approvalRequest(code) {
  const url = code === 'approval-url';
  const unrelatedForm = code === 'approval-form';
  const native = code.startsWith('approval-native');
  if (url) {
    return {
      mode: 'url',
      message: 'Open the original fixture approval URL.',
      elicitationId: 'fixture-url-elicitation',
      url: 'https://approval.example.invalid/continue',
      _meta: { fixture: 'url-form-pass-through', opaque: { id: 71 } },
    };
  }
  return {
    mode: 'form',
    message: native ? 'Allow Computer Use to use "LCU Fixture App"?' :
      unrelatedForm ? 'Enter the fixture secret.' : 'Allow native window access?',
    requestedSchema: {
      type: 'object',
      properties: unrelatedForm ? { secret: { type: 'string', minLength: 1 } } : {},
      ...(unrelatedForm ? { required: ['secret'] } : {}),
    },
    _meta: native ? {
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'computer-use',
      persist: code === 'approval-native-session-only' ? ['session'] : ['session', 'always'],
      tool_name: 'get_app_state',
      tool_params: { app: code === 'approval-native-host' ? 'com.todesktop.230313mzl4w4u92' : 'dev.lcu.NativeFixture.generated' },
      fixtureOpaque: { keep: true },
    } : { fixture: 'unrelated-form', opaque: { id: 39 } },
  };
}

async function waitUntilAborted(signal) {
  await new Promise(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', resolve, { once: true });
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {}, _meta } = request.params;
  if (name === 'turn_ended') {
    log({ type: 'turn-ended', args });
    return { content: [{ type: 'text', text: 'Original cleanup completed.' }] };
  }

  log({ type: 'tool-call', name, args, meta: _meta });
  if (name === 'js' && typeof args.code === 'string' && args.code.startsWith('approval-')) {
    const params = approvalRequest(args.code);
    const response = await server.elicitInput(params, { signal: extra.signal });
    log({ type: 'elicitation-response', code: args.code, response });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }
  if (name === 'js' && args.code === 'rich-result') {
    return {
      content: [
        { type: 'text', text: 'Original result text.', annotations: { audience: ['assistant'], priority: 0.7 } },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      structuredContent: { nested: { retained: true } },
      _meta: { originalResult: { revision: 4 } },
    };
  }
  if (name === 'js' && args.code === 'tool-error') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Original tool-level failure.' }],
      _meta: { originalError: true },
    };
  }
  if (name === 'js' && args.code === 'cancel-active') {
    log({ type: 'active-call-start', code: args.code, meta: _meta });
    await waitUntilAborted(extra.signal);
    log({ type: 'active-call-aborted', code: args.code, meta: _meta });
    return { content: [{ type: 'text', text: 'fixture observed cancellation' }] };
  }
  if (name === 'js' && args.code === 'close-active') {
    log({ type: 'active-call-start', code: args.code, meta: _meta });
    await waitUntilAborted(extra.signal);
    log({ type: 'active-call-aborted', code: args.code, meta: _meta });
    return { content: [{ type: 'text', text: 'fixture observed close cancellation' }] };
  }
  if (name === 'js' && args.code === 'parallel-slow') {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (name === 'js_reset') {
    return { content: [{ type: 'text', text: 'Original reset result.' }] };
  }
  return { content: [{ type: 'text', text: name === 'js' ? args.code : name }] };
});

log({ type: 'fixture-start', pid: process.pid });
process.on('exit', code => log({ type: 'fixture-exit', pid: process.pid, code }));
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
