import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildApprovalScript, promptForApproval } from '../deepseek-approval.mjs';

const relay = fileURLToPath(new URL('../deepseek.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./deepseek-fixture.mjs', import.meta.url));

/** Start the relay in front of the synthetic upstream and connect `client` to it. */
async function connect(client, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relay, process.execPath, fixture],
    env: { ...process.env, LCU_DIAGNOSTIC_LOG: '0', ...env },
    stderr: 'ignore',
  });
  await client.connect(transport);
  return client;
}

function textOf(result) {
  return result.content?.find(item => item.type === 'text')?.text ?? '';
}

test('lists the model tools and keeps host-only tools out of the model surface', async () => {
  const client = await connect(new Client({ name: 'ds-test', version: '0.0.0' }, { capabilities: {} }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['js', 'js_reset']);
  } finally {
    await client.close();
  }
});

test('rejects a host-only tool the model must not call', async () => {
  const client = await connect(new Client({ name: 'ds-test', version: '0.0.0' }, { capabilities: {} }));
  try {
    await assert.rejects(client.callTool({ name: 'turn_ended', arguments: {
      session_id: 's', turn_id: 't', hook_event_name: 'Stop' } }), /Unknown LCU tool/);
  } finally {
    await client.close();
  }
});

test('relays a native-app approval to a harness that supports elicitation', async () => {
  const seen = [];
  const client = new Client({ name: 'ds-test', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    seen.push(request.params.message);
    return { action: 'accept', content: {}, _meta: { persist: 'always' } };
  });
  await connect(client);
  try {
    const result = await client.callTool({ name: 'js', arguments: { code: 'elicit-native' } });
    assert.deepEqual(seen, ['Allow Computer Use to use "Muse"?']);
    assert.match(textOf(result), /"action":"accept"/);
    assert.match(textOf(result), /"persist":"always"/);
  } finally {
    await client.close();
  }
});

test('refuses the app hosting the agent before asking anyone', async () => {
  const asked = [];
  const client = new Client({ name: 'ds-test', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    asked.push(request.params.message);
    return { action: 'accept', content: {} };
  });
  await connect(client);
  try {
    const result = await client.callTool({ name: 'js', arguments: { code: 'elicit-host-app' } });
    assert.deepEqual(asked, []);
    assert.match(textOf(result), /"action":"decline"/);
  } finally {
    await client.close();
  }
});

test('a harness without elicitation gets a refusal in unattended mode, never an implicit approval', async () => {
  const client = await connect(new Client({ name: 'ds-test', version: '0.0.0' }, { capabilities: {} }),
    { LCU_DEEPSEEK_APPROVAL: 'deny' });
  try {
    const result = await client.callTool({ name: 'js', arguments: { code: 'elicit-native' } });
    assert.match(textOf(result), /"action":"cancel"/);
  } finally {
    await client.close();
  }
});

test('the approval dialog offers the runtime choices and defaults to Decline', () => {
  const script = buildApprovalScript({
    message: 'Allow Computer Use to use "Muse"?',
    resource: 'Muse (com.meta.endo)',
    choices: [{ value: 'once', label: 'Allow once' }, { value: 'session', label: 'Allow for this session' },
      { value: 'decline', label: 'Decline' }],
  });
  assert.match(script, /buttons \{"Allow once", "Allow for this session", "Decline"\}/);
  assert.match(script, /default button "Decline"/);
  assert.match(script, /cancel button "Decline"/);
  assert.match(script, /App: Muse \(com\.meta\.endo\)/);
});

test('an AppleScript-quoted message keeps quotes and backslashes literal', () => {
  const script = buildApprovalScript({ message: 'Allow "X" to use a\\b', resource: 'X', choices: [{ value: 'decline', label: 'Decline' }] });
  assert.match(script, /Allow \\"X\\" to use a\\\\b/);
});

test('the dialog choice maps back to the runtime value', async () => {
  const request = { message: 'Allow Computer Use to use "Muse"?', resource: 'Muse',
    choices: [{ value: 'once', label: 'Allow once' }, { value: 'decline', label: 'Decline' }] };
  assert.equal(await promptForApproval(request, { platform: 'darwin',
    run: async () => 'button returned:Allow once\n' }), 'once');
  assert.equal(await promptForApproval(request, { platform: 'darwin',
    run: async () => { throw new Error('User canceled.'); } }), 'cancel');
  assert.equal(await promptForApproval(request, { platform: 'linux' }), 'cancel');
});
