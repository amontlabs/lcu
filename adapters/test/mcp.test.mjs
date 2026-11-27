import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { UNSHOWN_ANSWER_MS } from '../hook-relay.mjs';
import { mcpApprovalHint } from '../mcp.mjs';
import { isolatedEnv } from './isolated-env.mjs';

const ADAPTERS = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = pathToFileURL(fileURLToPath(new URL('../../lcu/runtime.mjs', import.meta.url))).href;
const FIXTURE = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' && 'the fixture release launcher is a shell script' };

/**
 * A release whose `bin/lcu` records its arguments and runs the original-server fixture, with the repository's
 * adapters. `open()` connects an MCP client to `lcu mcp ARGS` (through lcu/runtime.mjs, as `bin/lcu mcp` runs it),
 * or with `platform`, to the relay as that platform would run it.
 */
function release(t) {
  const root = mkdtempSync(join(tmpdir(), 'lcu-mcp-'));
  mkdirSync(join(root, 'bin'));
  symlinkSync(ADAPTERS, join(root, 'adapters'));
  writeFileSync(join(root, 'bin/lcu'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, 'argv')}"\n` +
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}\n`, { mode: 0o755 });
  const env = isolatedEnv(root, { LCU_DIAGNOSTIC_LOG: '0', LCU_FIXTURE_LOG: join(root, 'calls'),
    LCU_FIXTURE_JS_ONE_OF: '1' });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, env,
    async open({ args = [], onElicit, capabilities = onElicit ? { elicitation: { form: {} } } : {}, platform } = {}) {
      const script = platform
        ? `import { runMcpRelay } from ${JSON.stringify(pathToFileURL(join(ADAPTERS, 'mcp.mjs')).href)};
           await runMcpRelay({ command: [${JSON.stringify(join(root, 'bin/lcu'))}], cwd: process.cwd(),
             platform: ${JSON.stringify(platform)} });`
        : `import { cli } from ${JSON.stringify(RUNTIME)};
           await cli(${JSON.stringify(root)}, ${JSON.stringify(['mcp', ...args])});`;
      const client = new Client({ name: 'plain-mcp-client', version: '1' }, { capabilities });
      if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
      await client.connect(new StdioClientTransport({ command: process.execPath, stderr: 'pipe', env,
        args: ['--input-type=module', '-e', script] }));
      clients.push(client);
      return client;
    },
    calls: () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse),
  };
}
const js = (client, code) => client.callTool({ name: 'js', arguments: { code } });
const text = result => result.content.map(block => block.text).join('\n');
// The hint names the launcher the relay runs, so it works without `lcu` on PATH.
const MAC_HINT = /this MCP client could not show the approval prompt\. Run `\S+\/bin\/lcu apps allow dev\.lcu\.NativeFixture\.generated` yourself/;

test('lcu mcp relays the original tools and instructions to a plain client and interrupts its turn on disconnect', posix, async t => {
  const r = release(t);
  const c = await r.open({ args: ['--chrome'] });
  assert.equal(readFileSync(join(r.root, 'argv'), 'utf8'), '--chrome\n', 'bare lcu runs underneath, with the flags');
  assert.match(c.getInstructions(), /^Original CUA initialization guide/);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['js', 'js_reset']);
  assert.equal(tools[0].inputSchema.oneOf, undefined, 'top-level combinators are merged for plain clients');
  assert.equal((await c.callTool({ name: 'turn_ended', arguments: {} })).isError, true);
  const first = await js(c, 'first');
  assert.match(first.content[0].text, /^LCU: Computer Use instructions for this session:\n\nOriginal CUA/);
  const second = await js(c, 'second');
  assert.doesNotMatch(text(second), /Computer Use instructions/, 'the instructions come once');
  await c.close();
  // One LCU turn for the whole connection, interrupted when the client goes away.
  for (let i = 0; i < 100 && !r.calls().some(row => row.name === 'turn_ended'); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const calls = r.calls();
  const turns = new Set(calls.filter(row => row.name === 'js').map(row => row.meta['x-codex-turn-metadata'].turn_id));
  assert.equal(turns.size, 1);
  const ended = calls.filter(row => row.name === 'turn_ended');
  assert.deepEqual(ended.map(row => [row.args.turn_id, row.args.hook_event_name]), [[[...turns][0], 'Interrupt']]);
});

test('lcu mcp shows native approvals as a choice form to a client that supports form elicitation', posix, async t => {
  const r = release(t);
  let answer;
  const c = await r.open({ onElicit: async ({ params }) => {
    assert.deepEqual(params.requestedSchema.properties.choice.enum, ['once', 'session', 'always', 'decline']);
    // A person takes longer than a host that never shows the form.
    await new Promise(resolve => setTimeout(resolve, UNSHOWN_ANSWER_MS + 50));
    return answer;
  } });
  await js(c, 'instructions');
  for (const [choice, expected] of [
    [{ action: 'accept', content: { choice: 'once' } }, { action: 'accept', content: {} }],
    [{ action: 'accept', content: { choice: 'always' } }, { action: 'accept', content: {}, _meta: { persist: 'always' } }],
    [{ action: 'accept', content: { choice: 'decline' } }, { action: 'decline' }],
    [{ action: 'decline' }, { action: 'decline' }], [{ action: 'cancel' }, { action: 'cancel' }],
  ]) {
    answer = choice;
    const result = await js(c, 'approval-native');
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    assert.equal(result.content.length, 1, 'an answered or dismissed form gets no hint');
  }
});

test('lcu mcp tells the model to run lcu apps allow on macOS when the client cannot show the approval', posix, async t => {
  const r = release(t);
  // No elicitation at all, an instant cancel, and an instant decline (hosts that never show the form).
  const clients = [await r.open({ platform: 'darwin' }),
    await r.open({ platform: 'darwin', onElicit: () => ({ action: 'cancel' }) }),
    await r.open({ platform: 'darwin', onElicit: () => ({ action: 'decline' }) })];
  for (const c of clients) {
    const result = await js(c, 'approval-native');
    const decision = result.content.find(block => block.text.startsWith('{'));
    assert.deepEqual(JSON.parse(decision.text), { action: 'cancel' }, 'cancelled, so a retry is not refused');
    assert.match(text(result), MAC_HINT);
    assert.match(text(result), /bin\/lcu apps revoke dev\.lcu\.NativeFixture\.generated/);
  }
});

test('elsewhere the hint names no lcu apps command, which exists only on macOS', posix, async t => {
  const r = release(t);
  const c = await r.open({ platform: 'win32' });
  const result = await js(c, 'approval-native');
  assert.match(text(result), /could not show the approval prompt\. .*Tell the person, and do not retry\./);
  assert.doesNotMatch(text(result), /lcu apps/);
  assert.match(mcpApprovalHint('Safari', '/x/bin/lcu', 'darwin'), /`\/x\/bin\/lcu apps allow Safari`/);
});

test('lcu mcp refuses other arguments and prints usage for --help', posix, t => {
  const r = release(t);
  const run = args => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { cli } from ${JSON.stringify(RUNTIME)}; await cli(${JSON.stringify(r.root)}, ${JSON.stringify(args)});`],
  { env: r.env, encoding: 'utf8', input: '' });
  for (const args of [['mcp', 'extra'], ['mcp', '--mcp-discovery-compat'], ['mcp', '--chrome', '--chrome']]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /^LCU: Usage: lcu/);
  }
  const help = run(['mcp', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /lcu mcp \[--chrome\] \[--audio\]/);
});
