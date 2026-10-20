import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Synthetic upstream for the DeepSeek relay tests. It stands in for the installed LCU server: the
 * same tool names, an approval request shaped like a native-app approval, and echo results. It
 * never describes real computer use and never touches a desktop or an app.
 */

const NATIVE_APPROVAL = {
  mode: 'form',
  message: 'Allow Computer Use to use "Muse"?',
  requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
  _meta: {
    codex_approval_kind: 'mcp_tool_call',
    connector_id: 'computer-use',
    tool_params: { app: 'Muse' },
    persist: ['session', 'always'],
  },
};

const HOST_APP_APPROVAL = {
  ...NATIVE_APPROVAL,
  message: 'Allow Computer Use to use "Terminal"?',
  _meta: { ...NATIVE_APPROVAL._meta, tool_params: { app: 'com.apple.Terminal' } },
};

const tools = [
  { name: 'js', description: 'Synthetic JavaScript tool.', inputSchema: {
    type: 'object', properties: { code: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['code'] } },
  { name: 'js_reset', description: 'Synthetic reset tool.', inputSchema: { type: 'object', properties: {} } },
  { name: 'turn_ended', description: 'Host-only lifecycle tool.', inputSchema: {
    type: 'object', properties: { session_id: { type: 'string' }, turn_id: { type: 'string' },
      hook_event_name: { type: 'string' } }, required: ['session_id', 'turn_id', 'hook_event_name'] } },
  { name: 'js_add_node_module_dir', description: 'Host-only module directory tool.', inputSchema: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

const server = new Server({ name: 'lcu-deepseek-fixture', version: '0.0.0' },
  { capabilities: { tools: {} }, instructions: 'Synthetic DeepSeek relay instructions.' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  if (name !== 'js') return { content: [{ type: 'text', text: `ran ${name}` }] };
  if (args?.code === 'elicit-native') {
    const answer = await server.elicitInput(NATIVE_APPROVAL);
    return { content: [{ type: 'text', text: `approval:${JSON.stringify(answer)}` }] };
  }
  if (args?.code === 'elicit-host-app') {
    const answer = await server.elicitInput(HOST_APP_APPROVAL);
    return { content: [{ type: 'text', text: `approval:${JSON.stringify(answer)}` }] };
  }
  return { content: [{ type: 'text', text: `js:${args?.code ?? ''}` }] };
});
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void server.close(); });
