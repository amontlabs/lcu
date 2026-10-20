import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildApprovalScript, dialogChoices, promptForApproval } from '../deepseek-approval.mjs';

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

test('the refusal setting outranks a harness that could answer the request itself', async () => {
  // An unattended run must not be approved by whichever client happens to be attached.
  const asked = [];
  const client = new Client({ name: 'ds-test', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    asked.push(request.params.message);
    return { action: 'accept', content: {}, _meta: { persist: 'always' } };
  });
  await connect(client, { LCU_DEEPSEEK_APPROVAL: 'deny' });
  try {
    const result = await client.callTool({ name: 'js', arguments: { code: 'elicit-native' } });
    assert.deepEqual(asked, []);
    assert.match(textOf(result), /"action":"cancel"/);
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
  assert.match(script, /buttons \{"Allow for this session", "Decline"\}/);
  assert.match(script, /default button "Decline"/);
  assert.match(script, /cancel button "Decline"/);
  assert.match(script, /App: Muse \(com\.meta\.endo\)/);
});

test('a four-scope runtime request stays within the three-button limit', () => {
  // `display dialog` rejects a fourth button with -50, which would read as a cancelled approval.
  const choices = [{ value: 'once', label: 'Allow once' }, { value: 'session', label: 'Allow for this session' },
    { value: 'always', label: 'Always allow' }, { value: 'decline', label: 'Decline' }];
  const buttons = dialogChoices(choices);
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map(button => button.value), ['session', 'always', 'decline']);
  const script = buildApprovalScript({ message: 'Allow?', resource: 'X', choices });
  assert.equal((script.match(/Allow/g) ?? []).length, 2);
  assert.match(script, /default button "Decline"/);
});

test('only the once scope is offered when the runtime offers no session', () => {
  assert.deepEqual(dialogChoices([{ value: 'once', label: 'Allow once' }, { value: 'decline', label: 'Decline' }]),
    [{ value: 'once', label: 'Allow once' }, { value: 'decline', label: 'Decline' }]);
});

test('an AppleScript-quoted message keeps quotes and backslashes literal', () => {
  const script = buildApprovalScript({ message: 'Allow "X" to use a\\b', resource: 'X', choices: [{ value: 'decline', label: 'Decline' }] });
  assert.match(script, /Allow \\"X\\" to use a\\\\b/);
});

test('a cancelled request closes the dialog rather than leaving it open', async () => {
  const controller = new AbortController();
  let handedSignal;
  const run = (script, { signal } = {}) => new Promise(resolve => {
    handedSignal = signal;
    signal?.addEventListener('abort', () => resolve('button returned:Decline'), { once: true });
  });
  const pending = promptForApproval({ message: 'Allow?', resource: 'X',
    choices: [{ value: 'decline', label: 'Decline' }] }, { platform: 'darwin', run, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, 'cancel');
  assert.equal(handedSignal.aborted, true);
});

test('an already-cancelled request never opens the dialog', async () => {
  let ran = false;
  const controller = new AbortController();
  controller.abort();
  assert.equal(await promptForApproval({ message: 'Allow?', resource: 'X',
    choices: [{ value: 'decline', label: 'Decline' }] },
  { platform: 'darwin', run: async () => { ran = true; return 'button returned:Decline'; }, signal: controller.signal }), 'cancel');
  assert.equal(ran, false);
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


test('registration keeps a private capability store private', async () => {
  const { configureDeepseek } = await import('../../lcu/harness_setup.mjs');
  const home = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-home-'));
  try {
    mkdirSync(join(home, '.dsh', 'bot'), { recursive: true });
    const store = join(home, '.dsh', 'bot', 'state.json');
    writeFileSync(store, JSON.stringify({ capabilities: { items: {} } }));
    // A store the harness wrote 0600 must not become 0644 because setup ran under umask 022.

    (await import('node:fs')).chmodSync(store, 0o600);
    configureDeepseek(home, ['/usr/bin/node', '/r/adapters/deepseek.mjs', '/r/bin/lcu'], { clock: () => 1 });
    assert.equal(statSync(store).mode & 0o777, 0o600);
    assert.equal(statSync(`${store}.lcu-backup`).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(store, 'utf8'));
    assert.equal(saved.capabilities.items.lcu.command, '/usr/bin/node');
    assert.deepEqual(saved.capabilities.items.lcu.args, ['/r/adapters/deepseek.mjs', '/r/bin/lcu']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
