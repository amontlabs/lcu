import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UNSHOWN_ANSWER_MS } from '../hook-relay.mjs';
import { isolatedEnv } from './isolated-env.mjs';

const relay = fileURLToPath(new URL('../grok.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const fixture = name => fileURLToPath(new URL(name, import.meta.url));
const unix = { skip: process.platform === 'win32' && 'Grok lifecycle sockets are Unix-only' };

function host(t) {
  const home = mkdtempSync(join(tmpdir(), 'lcu-grok-'));
  const env = isolatedEnv(home, { LCU_DIAGNOSTIC_LOG: '0', LCU_GROK_CONTROL_DIR: join(home, 'sock'),
    LCU_FIXTURE_LOG: join(home, 'calls'), LCU_RESULT_LOG: join(home, 'results') });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.close()));
    rmSync(home, { recursive: true, force: true });
  });
  return {
    async open(sessionId, file = './mcp-fixture.mjs', onElicit) {
      const client = new Client({ name: 'grok-test', version: '1' },
        { capabilities: onElicit ? { elicitation: { form: {} } } : {} });
      if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
      await client.connect(new StdioClientTransport({ command: process.execPath, stderr: 'pipe',
        args: [relay, process.execPath, fixture(file)], env: { ...env, GROK_SESSION_ID: sessionId } }));
      clients.push(client);
      return client;
    },
    hook(event, sessionId, promptId, extra = {}) {
      const result = spawnSync(process.execPath, [relay, '--hook'], { env, encoding: 'utf8', timeout: 15000,
        input: JSON.stringify({ hook_event_name: event, sessionId, promptId, ...extra }) });
      assert.equal(result.status, 0, result.stderr);
    },
    records: name => readFileSync(join(home, name), 'utf8').trim().split('\n').map(JSON.parse),
    // Hooks run as children of this process, so their host PID is ours.
    marker: (sessionId, promptId) => join(env.LCU_GROK_CONTROL_DIR, `turns-${process.pid}-${sha(sessionId)}`, sha(promptId)),
  };
}
const js = (client, code) => client.callTool({ name: 'js', arguments: { code } });

test('Grok recovers an early submit, forwards original descriptors, PNG and errors, and ends the named turn', unix, async t => {
  const h = host(t);
  h.hook('UserPromptSubmit', 'a', 'p1');
  const c = await h.open('a', './result-fixture.mjs');
  assert.match(c.getInstructions(), /^Original CUA initialization guide/);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['js', 'js_reset']);
  assert.equal(tools[0].description, 'Original JS description.');
  assert.equal((await c.callTool({ name: 'turn_ended', arguments: {} })).isError, true);
  for (const kind of ['image', 'error']) {
    const result = await js(c, 'lcu-result:' + kind);
    const original = h.records('results').find(row => row.kind === 'result' && row.fixtureCase === kind);
    assert.deepEqual(result, original.result);
  }
  h.hook('Stop', 'a', 'p1');
  h.hook('SessionEnd', 'a');
  const calls = h.records('results').filter(row => row.kind === 'call');
  assert.deepEqual(calls.map(row => row.name), ['js', 'js', 'turn_ended']);
  assert.equal(calls[0].meta['x-codex-turn-metadata'].turn_id, 'p1');
  assert.deepEqual(calls.at(-1).args, { hook_event_name: 'Stop', session_id: 'a', turn_id: 'p1' });
});

test('Grok sessions sharing a host and delayed end reports do not clean up another prompt', unix, async t => {
  const h = host(t);
  const a = await h.open('a');
  const b = await h.open('b');
  await assert.rejects(js(a, 'no hooks'), /active Grok prompt/);
  h.hook('UserPromptSubmit', 'a', 'first');
  h.hook('UserPromptSubmit', 'b', 'first');
  await Promise.all([js(a, 'first-a'), js(b, 'first-b')]);
  // Grok dispatches a cancelled turn's report off its command loop, so it can follow the next prompt's submit.
  h.hook('UserPromptSubmit', 'a', 'second');
  await js(a, 'second-a');
  h.hook('StopCancelled', 'a', 'first');
  h.hook('Stop', 'b', 'first');
  h.hook('StopFailure', 'a', 'second');
  const ended = h.records('calls').filter(row => row.name === 'turn_ended');
  assert.deepEqual(ended.map(({ args }) => [args.session_id, args.turn_id, args.hook_event_name]),
    [['a', 'first', 'Interrupt'], ['b', 'first', 'Stop'], ['a', 'second', 'Interrupt']]);
});

const ended = h => h.records('calls').filter(row => row.name === 'turn_ended').map(({ args }) => [args.turn_id, args.hook_event_name]);
const turnsOf = h => h.records('calls').filter(row => row.name === 'js').map(row => row.meta['x-codex-turn-metadata'].turn_id);

test('Grok settles a turn with no end report when the next prompt starts (cancel-and-send)', unix, async t => {
  const h = host(t);
  const c = await h.open('a');
  h.hook('UserPromptSubmit', 'a', 'first');
  await js(c, 'first');
  // Grok sends no StopCancelled for a cancel-and-send: the next prompt simply starts.
  h.hook('UserPromptSubmit', 'a', 'second');
  assert.equal(existsSync(h.marker('a', 'first')), false);
  await js(c, 'second');
  h.hook('UserPromptSubmit', 'a', 'third');
  h.hook('UserPromptSubmit', 'a', 'fourth');
  await js(c, 'fourth');
  assert.deepEqual(ended(h), [['first', 'Interrupt'], ['second', 'Interrupt']]);
  assert.deepEqual(turnsOf(h), ['first', 'second', 'fourth']);
});

test('Grok interrupts a turn whose end report was lost once the next prompt calls', unix, async t => {
  const h = host(t);
  const c = await h.open('a');
  h.hook('UserPromptSubmit', 'a', 'first');
  await js(c, 'first');
  // Neither the first prompt's Stop nor the second prompt's submit reached the relay; only the markers changed.
  rmSync(h.marker('a', 'first'));
  writeFileSync(h.marker('a', 'second'), 'second');
  await js(c, 'second');
  await js(c, 'second again');
  const calls = h.records('calls');
  assert.deepEqual(calls.filter(row => row.name === 'turn_ended').map(({ args }) => [args.turn_id, args.hook_event_name]),
    [['first', 'Interrupt']]);
  assert.deepEqual(calls.filter(row => row.name === 'js').map(row => row.meta['x-codex-turn-metadata'].turn_id),
    ['first', 'second', 'second']);
  h.hook('Stop', 'a', 'second');
  assert.deepEqual(h.records('calls').filter(row => row.name === 'turn_ended').map(({ args }) => args.turn_id),
    ['first', 'second']);
});

test('Grok idle notifications settle unreported turns but keep a prompt submitted after them', unix, async t => {
  const h = host(t);
  const c = await h.open('a');
  h.hook('UserPromptSubmit', 'a', 'rewound');
  await js(c, 'rewound');
  // A rewind reports nothing; Grok's idle_prompt ping follows about a minute later.
  const old = new Date(Date.now() - 60_000);
  utimesSync(h.marker('a', 'rewound'), old, old);
  h.hook('Notification', 'a', undefined, { notificationType: 'permission_prompt', timestamp: new Date().toISOString() });
  assert.equal(existsSync(h.marker('a', 'rewound')), true, 'other notifications are ignored');
  h.hook('Notification', 'a', undefined, { notificationType: 'idle_prompt', timestamp: new Date().toISOString() });
  assert.equal(existsSync(h.marker('a', 'rewound')), false);
  assert.deepEqual(ended(h), [['rewound', 'Interrupt']]);
  await assert.rejects(js(c, 'idle'), /active Grok prompt/);

  // A ping dispatched before the next prompt arrives late: the new prompt and its turn stay open.
  h.hook('UserPromptSubmit', 'a', 'fresh');
  await js(c, 'fresh');
  h.hook('Notification', 'a', undefined, { notificationType: 'idle_prompt', timestamp: old.toISOString() });
  await js(c, 'fresh again');
  assert.deepEqual(ended(h), [['rewound', 'Interrupt']]);
  assert.deepEqual(turnsOf(h), ['rewound', 'fresh', 'fresh']);
});

test("Grok ignores a subagent's prompt, stop and teardown events", unix, async t => {
  const h = host(t);
  const c = await h.open('a');
  h.hook('UserPromptSubmit', 'a', 'main');
  await js(c, 'main');
  const child = { subagentType: 'general' };
  h.hook('UserPromptSubmit', 'a', 'child', child);
  h.hook('Stop', 'a', 'main', child);
  h.hook('StopCancelled', 'a', 'main', child);
  h.hook('SessionEnd', 'a', undefined, child);
  await js(c, 'main again');
  assert.deepEqual(ended(h), []);
  assert.deepEqual(turnsOf(h), ['main', 'main']);
  h.hook('Stop', 'a', 'main');
  assert.deepEqual(ended(h), [['main', 'Stop']]);
});

const HINT = /could not show the approval prompt\. Run `lcu apps allow dev\.lcu\.NativeFixture\.generated` yourself/;
const hintOf = result => result.content.slice(1).map(block => block.text).join('\n');

test('Grok propagates real native approval choices, including explicit refusal and dismissal', unix, async t => {
  const h = host(t);
  let answer;
  const c = await h.open('s', './mcp-fixture.mjs', async ({ params }) => {
    assert.deepEqual(params.requestedSchema.properties.choice.enum, ['once', 'session', 'always', 'decline']);
    // A person takes longer than the unshown-form threshold to answer.
    await new Promise(resolve => setTimeout(resolve, UNSHOWN_ANSWER_MS + 50));
    return answer;
  });
  h.hook('UserPromptSubmit', 's', 'p');
  for (const [choice, expected] of [
    [{ action: 'accept', content: { choice: 'once' } }, { action: 'accept', content: {} }],
    [{ action: 'accept', content: { choice: 'session' } }, { action: 'accept', content: {}, _meta: { persist: 'session' } }],
    [{ action: 'accept', content: { choice: 'always' } }, { action: 'accept', content: {}, _meta: { persist: 'always' } }],
    [{ action: 'accept', content: { choice: 'decline' } }, { action: 'decline' }],
    [{ action: 'decline' }, { action: 'decline' }], [{ action: 'cancel' }, { action: 'cancel' }],
  ]) {
    answer = choice;
    const result = await js(c, 'approval-native');
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    assert.equal(result.content.length, 1, 'an answered or dismissed form gets no lcu apps allow hint');
  }
});

test('Grok tells the model how to get approval when the host cannot show the form', unix, async t => {
  const h = host(t);
  // A host that cancels the form at once, and a client without elicitation.
  const instant = await h.open('instant', './mcp-fixture.mjs', () => ({ action: 'cancel' }));
  const plain = await h.open('plain');
  h.hook('UserPromptSubmit', 'instant', 'p');
  h.hook('UserPromptSubmit', 'plain', 'p');
  for (const c of [instant, plain]) {
    const result = await js(c, 'approval-native');
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'cancel' });
    assert.match(hintOf(result), HINT);
  }
});
