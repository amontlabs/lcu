import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { approvalHint, controlDirectory, INSTRUCTIONS_HEADER, launcherOf, runJunieHook } from '../junie.mjs';

// Junie is not supported on Windows (setup refuses it): the relay and its hooks meet on a Unix socket.
const unix = { skip: process.platform === 'win32' && 'Junie is not supported on Windows' };
const relay = fileURLToPath(new URL('../junie.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));

/** The relay as Junie runs it: a child of this process, which also runs the hooks. */
async function withRelay(run) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-junie-'));
  const control = join(directory, 'control');
  const log = join(directory, 'fixture.jsonl');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, TMPDIR: directory,
    LCU_FIXTURE_LOG: log, LCU_JUNIE_CONTROL_DIR: control, LCU_DIAGNOSTIC_LOG: '0',
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [relay, process.execPath, fixture], env,
    stderr: 'pipe' });
  const client = new Client({ name: 'junie-client', version: '1.0.0' }, { capabilities: { sampling: {} } });
  await client.connect(transport);
  const entries = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const hook = (event, sessionId, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relay, '--hook'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: directory, ...extra }));
  });
  const js = async code => (await client.callTool({ name: 'js', arguments: { code } })).content.map(item => item.text);
  const until = async predicate => {
    for (let i = 0; i < 200 && !predicate(entries()); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(entries()), JSON.stringify(entries()));
  };
  try {
    return await run({ client, transport, hook, js, entries, until, control, directory });
  } finally {
    await client.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}

const turnOf = entry => entry.meta['x-codex-turn-metadata'];

test('Junie relay lists only the original js and js_reset with the original instructions', unix, async () => {
  await withRelay(async ({ client, control }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['js', 'js_reset']);
    assert.equal(tools[0].description, 'Original JS description.');
    assert.equal(client.getInstructions(), 'Original CUA initialization guide.');
    const sockets = readdirSync(control);
    assert.deepEqual(sockets, [`${process.pid}-${client.transport.pid}.sock`]);
    const result = await client.callTool({ name: 'turn_ended', arguments: {} });
    assert.equal(result.isError, true);
  });
});

test('the first prompt of each session carries the original instructions as additional context', unix, async () => {
  await withRelay(async ({ hook }) => {
    assert.deepEqual(await hook('SessionStart', 'junie-session', { source: 'startup' }), { status: 0, stdout: '' });
    const first = await hook('UserPromptSubmit', 'junie-session', { prompt: 'Open the app' });
    assert.equal(first.status, 0);
    assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
      additionalContext: 'Original CUA initialization guide.' } });
    assert.deepEqual(await hook('UserPromptSubmit', 'junie-session', { prompt: 'Again' }), { status: 0, stdout: '' });
    assert.match((await hook('UserPromptSubmit', 'cleared-session')).stdout, /Original CUA initialization guide/);
  });
});

test('calls carry the Junie session and one turn per prompt; Stop, StopFailure and SessionEnd end it', unix, async () => {
  await withRelay(async ({ hook, js, entries, until }) => {
    await hook('UserPromptSubmit', 'junie-session');
    assert.deepEqual(await js('one'), ['one']);
    await js('two');
    await hook('Stop', 'junie-session', { stop_hook_active: false, last_assistant_message: 'done' });
    await until(list => list.length === 3);
    await hook('UserPromptSubmit', 'junie-session');
    await js('three');
    await hook('StopFailure', 'junie-session', { error: 'server_error' });
    await hook('UserPromptSubmit', 'junie-session');
    await js('four');
    await hook('SessionEnd', 'junie-session', { reason: 'prompt_input_exit' });
    await until(list => list.length === 7);
    const [one, two, stop, three, failure, four, end] = entries();
    assert.equal(turnOf(one).session_id, 'junie-session');
    assert.equal(turnOf(one).turn_id, turnOf(two).turn_id);
    assert.notEqual(turnOf(one).call_id, turnOf(two).call_id);
    assert.deepEqual([stop.name, stop.args.hook_event_name, stop.args.session_id, stop.args.turn_id],
      ['turn_ended', 'Stop', 'junie-session', turnOf(one).turn_id]);
    assert.notEqual(turnOf(three).turn_id, turnOf(one).turn_id);
    assert.deepEqual([failure.args.hook_event_name, failure.args.turn_id], ['Interrupt', turnOf(three).turn_id]);
    assert.deepEqual([end.args.hook_event_name, end.args.turn_id], ['Interrupt', turnOf(four).turn_id]);
    // A Stop with no LCU call in the turn, or for another session, ends nothing upstream.
    await hook('UserPromptSubmit', 'junie-session');
    await hook('Stop', 'junie-session');
    await hook('Stop', 'other-session');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(entries().length, 7);
  });
});

test('a new prompt ends a turn Junie reported no Stop for; a new session interrupts the old one', unix, async () => {
  await withRelay(async ({ hook, js, entries, until }) => {
    await hook('UserPromptSubmit', 'junie-session');
    await js('one');
    await hook('UserPromptSubmit', 'junie-session');
    await until(list => list.length === 2);
    assert.deepEqual([entries()[1].args.hook_event_name, entries()[1].args.turn_id], ['Stop', turnOf(entries()[0]).turn_id]);
    await js('two');
    await hook('SessionStart', 'new-session', { source: 'clear' });
    await until(list => list.length === 4);
    assert.deepEqual([entries()[3].args.hook_event_name, entries()[3].args.session_id], ['Interrupt', 'junie-session']);
    await js('three');
    assert.equal(turnOf(entries()[4]).session_id, 'new-session');
  });
});

test('calls before any hook use the relay\'s own session; closing Junie\'s connection interrupts the open turn', unix, async () => {
  await withRelay(async ({ client, js, entries, until }) => {
    await js('early');
    assert.match(turnOf(entries()[0]).session_id, /^junie-[0-9a-f-]{36}$/);
    await client.close();
    await until(list => list.length === 2);
    assert.deepEqual([entries()[1].args.hook_event_name, entries()[1].args.turn_id], ['Interrupt', turnOf(entries()[0]).turn_id]);
  });
});

test('a relay Junie started after the prompt hooks ends its first turn on Stop and follows the session after', unix, async () => {
  await withRelay(async ({ hook, js, entries, until }) => {
    // Junie on macOS (26.10.20) runs SessionStart and UserPromptSubmit before it starts the MCP server.
    await js('early');
    await hook('Stop', 'junie-session', { stop_hook_active: false });
    await until(list => list.length === 2);
    const [early, stop] = entries();
    assert.deepEqual([stop.args.hook_event_name, stop.args.session_id, stop.args.turn_id],
      ['Stop', turnOf(early).session_id, turnOf(early).turn_id]);
    await hook('UserPromptSubmit', 'junie-session');
    await js('next');
    assert.equal(turnOf(entries()[2]).session_id, 'junie-session');
    await hook('Stop', 'junie-session');
    await until(list => list.length === 4);
    assert.deepEqual([entries()[3].args.hook_event_name, entries()[3].args.session_id], ['Stop', 'junie-session']);
  });
});

const INSTRUCTIONS_BLOCK = `${INSTRUCTIONS_HEADER}\n\nOriginal CUA initialization guide.`;

test('a relay Junie started late gives the instructions with the first call, once, and not again on the next prompt', unix, async () => {
  await withRelay(async ({ hook, js }) => {
    // No hook reached this relay before its first call, so the call result carries the instructions.
    assert.deepEqual(await js('early'), [INSTRUCTIONS_BLOCK, 'early']);
    assert.equal(INSTRUCTIONS_HEADER, 'LCU: Computer Use instructions for this session:');
    assert.deepEqual(await js('again'), ['again']);
    // Stop adopts the relay's own session as Junie's; that session's next prompt does not repeat them.
    await hook('Stop', 'junie-session');
    assert.deepEqual(await hook('UserPromptSubmit', 'junie-session'), { status: 0, stdout: '' });
    assert.deepEqual(await js('next'), ['next']);
    // A new session still gets them on its first prompt.
    assert.match((await hook('UserPromptSubmit', 'cleared-session')).stdout, /Original CUA initialization guide/);
    assert.deepEqual(await js('cleared'), ['cleared']);
  });
});

test('a relay started before the first prompt gives the instructions only through the prompt hook', unix, async () => {
  await withRelay(async ({ hook, js }) => {
    const first = await hook('UserPromptSubmit', 'junie-session');
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, 'Original CUA initialization guide.');
    assert.deepEqual(await js('one'), ['one']);
    assert.deepEqual(await js('two'), ['two']);
    assert.match((await hook('UserPromptSubmit', 'cleared-session')).stdout, /Original CUA initialization guide/);
    assert.deepEqual(await js('three'), ['three']);
  });
});

test('a failed turn end is retried before the session\'s next call, which is refused while it still fails', unix, async () => {
  await withRelay(async ({ hook, js, entries, until }) => {
    await hook('UserPromptSubmit', 'fail-once-session');
    await js('one');
    await hook('Stop', 'fail-once-session');
    await hook('UserPromptSubmit', 'fail-once-session');
    await js('two');
    const list = entries();
    assert.deepEqual(list.map(entry => entry.name), ['js', 'turn_ended', 'turn_ended', 'js']);
    assert.deepEqual(list.slice(1, 3).map(entry => entry.args.hook_event_name), ['Stop', 'Stop']);
    assert.equal(list[2].args.turn_id, turnOf(list[0]).turn_id);
    assert.notEqual(turnOf(list[3]).turn_id, turnOf(list[0]).turn_id);
    await hook('UserPromptSubmit', 'fail-session');
    await js('three');
    await hook('Stop', 'fail-session');
    const refused = await (async () => { try { return await js('four'); } catch (error) { return error.message; } })();
    assert.match(String(refused), /still finishing the previous turn/);
    // The Stop, then its retry before `four`, which never reached the runtime.
    const ends = entries().filter(entry => entry.name === 'turn_ended' && entry.args.session_id === 'fail-session');
    assert.deepEqual(ends.map(entry => [entry.args.hook_event_name, entry.args.turn_id]),
      [['Stop', turnOf(entries().at(-3)).turn_id], ['Stop', turnOf(entries().at(-3)).turn_id]]);
    assert.equal(entries().some(entry => entry.args?.code === 'four'), false);
    // Another session's calls are refused too while that end fails.
    await hook('UserPromptSubmit', 'junie-session');
    const other = await (async () => { try { return await js('five'); } catch (error) { return error.message; } })();
    assert.match(String(other), /still finishing the previous turn/);
    assert.equal(entries().some(entry => entry.args?.code === 'five'), false);
  });
});

test('an app approval Junie cannot show is cancelled and the result tells the model to run `lcu apps allow`', unix, async () => {
  await withRelay(async ({ hook, js }) => {
    await hook('UserPromptSubmit', 'junie-session');
    const [decision, hint] = await js('approval-native');
    assert.deepEqual(JSON.parse(decision), { action: 'cancel' });
    assert.equal(hint, approvalHint('dev.lcu.NativeFixture.generated'));
    assert.match(hint, /`lcu apps allow dev\.lcu\.NativeFixture\.generated`/);
    // An agent host app is refused before anyone could be asked, so there is nothing to allow.
    assert.deepEqual(await js('approval-native-host'), [JSON.stringify({ action: 'decline' })]);
    assert.deepEqual(await js('plain'), ['plain']);
    // An approval request does not say which call asked, so overlapping calls get no hint.
    const [slow, asked] = await Promise.all([js('sleep-300'), js('approval-native')]);
    assert.deepEqual(slow, ['sleep-300']);
    assert.deepEqual(asked, [JSON.stringify({ action: 'cancel' })]);
  });
  const hint = approvalHint('Visual Studio Code');
  assert.match(hint, /Run `lcu apps allow "Visual Studio Code"` yourself in a terminal/);
  assert.match(hint, /timeout of at least 300 seconds/);
  assert.match(hint, /until it is revoked\. .*Then retry the call\./);
  assert.match(hint, /fails, is refused or times out .*ask the person to run it themselves and stop/);
  assert.match(hint, /In your final answer, say that Visual Studio Code stays allowed until revoked, show `lcu apps revoke "Visual Studio Code"`, and offer to run it for them\.$/);
  assert.doesNotMatch(hint, /Do not run/);
  assert.match(approvalHint('A"$b'), /`lcu apps allow "A\\"\\\$b"`/);
  // The launcher setup passes to the relay is named in full, so the hint works when `lcu` is not on PATH.
  const launcher = '/home/u/.local/share/lcu/current/bin/lcu';
  assert.equal(launcherOf(['/x/bin/lcu-session', '--user', 'u', '--', launcher, '--chrome']), launcher);
  assert.equal(launcherOf([process.execPath, 'fixture.mjs']), 'lcu');
  assert.match(approvalHint('Notes', launcher), new RegExp(`\`${launcher} apps allow Notes\``));
  assert.match(approvalHint('Notes', '/Users/a b/bin/lcu'), /`"\/Users\/a b\/bin\/lcu" apps revoke Notes`/);
});

test('the hook stays silent and never fails without a relay, with bad input, or with a stale socket', unix, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-junie-hook-'));
  try {
    const written = [];
    const write = text => written.push(text);
    await runJunieHook({ stdin: 'not json', directory, write });
    await runJunieHook({ stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's' }),
      directory: join(directory, 'missing'), write });
    await runJunieHook({ stdin: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's' }), directory, write });
    // A relay that exited without closing its server leaves its socket behind.
    const stale = join(directory, `${process.pid}-1.sock`);
    spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => process.exit(0))`]);
    assert.equal(existsSync(stale), true);
    await runJunieHook({ stdin: JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), directory, write,
      parent: process.pid });
    assert.deepEqual(written, []);
    assert.equal(existsSync(stale), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(controlDirectory({ env: { HOME: '/home/a' } }), '/home/a/.local/state/lcu/junie');
  assert.equal(controlDirectory({ env: { HOME: '/home/a', XDG_STATE_HOME: '/s' } }), '/s/lcu/junie');
  // A socket path must fit in 104 bytes on macOS.
  assert.equal(controlDirectory({ env: { HOME: `/home/${'a'.repeat(60)}` }, temporary: '/tmp', uid: 501 }), '/tmp/lcu-junie-501');
});
