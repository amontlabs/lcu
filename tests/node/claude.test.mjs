// The Claude Code approval mod (claude_mod.mjs) and host-only tool visibility (claude_visibility.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';

import * as mod from '../../lcu/claude_mod.mjs';
import * as visibility from '../../lcu/claude_visibility.mjs';
import { REPO, temporary, write } from './fixtures.mjs';

const MOD = join(REPO, 'adapters/claude-mod/lcu-approve');
const snapshot = (root) => Object.fromEntries(readdirSync(root, { recursive: true }).sort()
  .filter((name) => { try { readFileSync(join(root, name)); return true; } catch { return false; } })
  .map((name) => [name.split(sep).join('/'), readFileSync(join(root, name), 'utf8')]));

test('the shipped mod is a function-hook plugin for the lcu server', () => {
  assert.equal(JSON.parse(readFileSync(join(MOD, '.claude-plugin/plugin.json'), 'utf8')).name, mod.NAME);
  assert.deepEqual(JSON.parse(readFileSync(join(MOD, 'hooks/hooks.json'), 'utf8')), { modules: ['./register.tsx'] });
  const source = readFileSync(join(MOD, 'hooks/register.tsx'), 'utf8');
  assert.ok(source.includes("const SERVER = 'lcu'"));
  for (const event of ["'classic.Elicitation'", "'tool.call'", "'tool.check'", "'ui.render'", "'computer-use-apps'"]) assert.ok(source.includes(event), event);
});

test('user-scope install is idempotent, omits the mod tests and records the lcu command', (t) => {
  const home = temporary(t);
  const target = mod.install(home, REPO);
  assert.equal(target, join(home, '.claude/skills/lcu-approve'));
  assert.deepEqual(Object.keys(snapshot(target)).sort(), ['.claude-plugin/plugin.json', 'hooks/data.ts', 'hooks/hooks.json',
    'hooks/register.tsx', 'hooks/views.tsx', 'lcu.json', 'types/index.d.ts']);
  const before = snapshot(target);
  mod.install(home, REPO);
  assert.deepEqual(snapshot(target), before);
  assert.deepEqual(JSON.parse(before['lcu.json']), { lcu: join(REPO, 'bin/lcu') });
  const release = join(home, 'prefix/releases/1.0-abc');
  cpSync(MOD, join(release, 'adapters/claude-mod/lcu-approve'), { recursive: true, filter: (path) => basename(path) !== 'tests' });
  assert.deepEqual(JSON.parse(readFileSync(join(mod.install(home, release), 'lcu.json'), 'utf8')), { lcu: join(home, 'prefix/current/bin/lcu') });
});

test('project scope installs under the project; a reinstall replaces changed and drops stale files', (t) => {
  const root = temporary(t);
  const project = join(root, 'project');
  mkdirSync(project);
  assert.equal(mod.install(join(root, 'home'), REPO, { project }), join(project, '.claude/skills/lcu-approve'));
  assert.equal(existsSync(join(root, 'home/.claude')), false);
  const target = mod.install(root, REPO);
  writeFileSync(join(target, 'hooks/register.tsx'), 'old');
  writeFileSync(join(target, 'hooks/old.tsx'), 'stale');
  mod.install(root, REPO);
  assert.equal(readFileSync(join(target, 'hooks/register.tsx'), 'utf8'), readFileSync(join(MOD, 'hooks/register.tsx'), 'utf8'));
  assert.equal(existsSync(join(target, 'hooks/old.tsx')), false);
});

test('a foreign plugin of the same name is refused and kept; remove deletes only the mod', (t) => {
  const home = temporary(t);
  const target = write(join(home, '.claude/skills/lcu-approve/.claude-plugin/plugin.json'), '{"name": "mine"}');
  assert.throws(() => mod.install(home, REPO), /not the LCU mod/);
  assert.throws(() => mod.remove(home), /not the LCU mod/);
  assert.equal(readFileSync(target, 'utf8'), '{"name": "mine"}');
  const other = temporary(t);
  write(join(other, '.claude/skills/other/SKILL.md'), 'keep');
  mod.install(other, REPO);
  assert.equal(mod.remove(other), true);
  assert.equal(existsSync(join(other, '.claude/skills/lcu-approve')), false);
  assert.equal(readFileSync(join(other, '.claude/skills/other/SKILL.md'), 'utf8'), 'keep');
  assert.equal(mod.remove(other), false);
  assert.throws(() => mod.install(other, join(other, 'empty')), /Reinstall LCU/);
});

test('visibility denies exactly the host-only tools, adds the lifecycle hooks once and keeps other settings', (t) => {
  const home = temporary(t);
  const path = write(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['mcp__lcu__js'], deny: ['Bash'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  visibility.install(home);
  const first = readFileSync(path, 'utf8');
  const settings = JSON.parse(first);
  assert.deepEqual(settings.permissions, { allow: ['mcp__lcu__js'], deny: ['Bash', ...visibility.HOST_ONLY] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'mine');
  assert.deepEqual(settings.hooks.SubagentStop[0].hooks[0], visibility.lifecycleHooks(home).SubagentStop.hooks[0]);
  assert.equal(settings.hooks.StopFailure[0].hooks[0].timeout, 600);
  assert.ok(!visibility.MOD_ONLY.some((tool) => settings.permissions.deny.includes(tool)));
  visibility.install(home);
  assert.equal(readFileSync(path, 'utf8'), first);
  for (const bad of ['[]', '{"permissions": []}', '{"permissions": {"deny": [1]}}', '{"hooks": {"Stop": {}}}', '{"hooks": {"Stop": [{"matcher": 1, "hooks": []}]}}',
    '{"permissions": null}', '{"permissions": {"deny": null}}', '{"hooks": null}', '{"hooks": {"Stop": null}}']) {
    writeFileSync(path, bad);
    assert.throws(() => visibility.install(home), Error, bad);
    assert.equal(readFileSync(path, 'utf8'), bad);
  }
});

test('an empty settings file or one with a byte order mark is read as before', (t) => {
  for (const content of ['', '\uFEFF{"model": "sonnet"}']) {
    const home = temporary(t);
    const path = write(join(home, '.claude/settings.json'), content);
    visibility.install(home);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions.deny, visibility.HOST_ONLY);
    if (content) assert.equal(settings.model, 'sonnet');
  }
});

const events = ['PreToolUse', 'Stop', 'StopFailure', 'SubagentStop'];
function fixture(t, settings = {}) {
  const home = temporary(t);
  mkdirSync(join(home, '.claude'));
  const path = join(home, '.claude/settings.json');
  writeFileSync(path, JSON.stringify(settings));
  return { home, path, read: () => JSON.parse(readFileSync(path, 'utf8')) };
}
test('LCU lifecycle hooks execute without a connected MCP client and PreToolUse stays synchronous', t => {
  const f = fixture(t);
  visibility.install(f.home);
  const { hooks } = f.read();
  for (const event of events) {
    assert.equal(hooks[event].length, 1, event);
    for (const hook of hooks[event][0].hooks) {
      assert.equal(hook.type, 'command', `${event} must not require a connected MCP server`);
      assert.equal(hook.async ?? false, false, `${event} must await acknowledgement`);
      assert.equal(typeof hook.command, 'string');
    }
  }
});
test('re-setup migrates old LCU MCP hook entries without deleting neighboring user hooks', t => {
  const mine = { type: 'command', command: 'user-owned-hook' };
  const foreign = { type: 'mcp_tool', server: 'lcu', tool: 'user_owned_tool' };
  const end = (event, session) => ({ type: 'mcp_tool', server: 'lcu', tool: 'turn_ended', input: {
    hook_event_name: event, session_id: session, turn_id: '${prompt_id}' } });
  const old = {
    PreToolUse: [{ matcher: 'mcp__lcu__js|mcp__lcu__js_reset', hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'set_turn_context',
      input: { session_id: '${session_id}', turn_id: '${prompt_id}', tool_use_id: '${tool_use_id}', agent_id: '${agent_id}' } }] }],
    Stop: [{ hooks: [mine, end('Stop', '${session_id}'), foreign] }],
    StopFailure: [{ hooks: [end('Interrupt', '${session_id}')] }],
    SubagentStop: [{ hooks: [end('SubagentStop', '${agent_id}')] }],
  };
  const f = fixture(t, { hooks: old, permissions: { allow: ['Bash(user-command)'] } });
  visibility.install(f.home);
  const installed = f.read();
  for (const event of events) {
    const hooks = installed.hooks[event].flatMap(group => group.hooks);
    assert.equal(hooks.filter(h => h.type === 'mcp_tool' && h.server === 'lcu' &&
      ['turn_ended', 'set_turn_context'].includes(h.tool)).length, 0, `${event} retains a noisy legacy hook`);
  }
  assert.ok(installed.hooks.Stop.some(g => g.hooks.some(h => JSON.stringify(h) === JSON.stringify(mine))));
  assert.ok(installed.hooks.Stop.some(g => g.hooks.some(h => JSON.stringify(h) === JSON.stringify(foreign))));
  assert.deepEqual(installed.permissions.allow, ['Bash(user-command)']);
  const first = readFileSync(f.path, 'utf8');
  visibility.install(f.home);
  assert.equal(readFileSync(f.path, 'utf8'), first);
});


test('Windows hooks run the account-data helper directly with the selected app Node', () => {
  const home = 'C:\\Users\\fixture';
  const node = 'C:\\LCU\\apps\\new\\node.exe';
  const hook = visibility.lifecycleHooks(home, node, 'win32').Stop.hooks[0];
  assert.deepEqual(hook, { type: 'command', command: node,
    args: ['C:\\Users\\fixture\\AppData\\Local\\LCU\\claude\\claude-hook.mjs'], timeout: 600 });
});

test('migration recognizes only exact legacy handlers and keeps group fields and foreign variants', t => {
  const home = temporary(t);
  const legacy = { type: 'mcp_tool', server: 'lcu', tool: 'set_turn_context', input: {
    session_id: '${session_id}', turn_id: '${prompt_id}', tool_use_id: '${tool_use_id}', agent_id: '${agent_id}' } };
  const foreign = [{ ...legacy, timeout: 42 }, { ...legacy, input: { ...legacy.input, session_id: 'mine' } }];
  const changedMatcher = { matcher: 'mcp__lcu__js', hooks: [legacy] };
  const path = write(join(home, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'mcp__lcu__js|mcp__lcu__js_reset', label: 'keep-group', hooks: [legacy, ...foreign] }, changedMatcher,
  ] } }));
  visibility.install(home);
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse.slice(0, 2), [
    { matcher: 'mcp__lcu__js|mcp__lcu__js_reset', label: 'keep-group', hooks: foreign }, changedMatcher,
  ]);
  const first = readFileSync(path, 'utf8');
  visibility.install(home);
  assert.equal(readFileSync(path, 'utf8'), first);
});


test('setup migrates release-bound command hooks and refreshes the standalone copy', t => {
  const home = temporary(t);
  const root = join(home, 'prefix/releases/new');
  const prefix = join(home, 'prefix');
  const previous = { type: 'command', command: process.execPath,
    args: process.platform === 'win32' ? [join(prefix, 'windows_launcher.mjs'), 'claude-hook']
      : [join(prefix, 'current/lcu/claude_hook.mjs')], timeout: 600 };
  const mine = { ...previous, timeout: 42 };
  const path = write(join(home, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [previous, mine] }] } }));
  visibility.install(home, { root });
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(settings.hooks.Stop[0].hooks, [mine]);
  assert.deepEqual(settings.hooks.Stop[1], visibility.lifecycleHooks(home).Stop);
  const helper = visibility.helperPath(home);
  const source = readFileSync(join(REPO, 'lcu/claude_hook.mjs'), 'utf8');
  assert.equal(readFileSync(helper, 'utf8'), source);
  writeFileSync(helper, source + '// earlier copy\n');
  assert.equal(visibility.refresh(home, root), true);
  assert.equal(readFileSync(helper, 'utf8'), source);
  const before = readFileSync(path, 'utf8');
  visibility.install(home, { root });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('installed lifecycle hooks stay silent after their release is rolled back and pruned', t => {
  const home = temporary(t);
  const release = join(home, 'prefix/current');
  cpSync(join(REPO, 'lcu'), join(release, 'lcu'), { recursive: true });
  const path = visibility.install(home, { root: release });
  const hook = JSON.parse(readFileSync(path, 'utf8')).hooks.Stop[0].hooks[0];
  const standalone = join(home, 'standalone', 'hook.mjs');
  mkdirSync(join(home, 'standalone'));
  cpSync(hook.args[0], standalone);
  rmSync(join(home, 'prefix'), { recursive: true, force: true });
  for (const args of [hook.args, [standalone]]) {
    const result = spawnSync(hook.command, args, { encoding: 'utf8', timeout: 2_000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'old-relay', prompt_id: 'p' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});


test('helper installation ignores umask 000 and preserves user-owned parent modes', {
  skip: process.platform === 'win32' && 'POSIX permission bits',
}, t => {
  for (const existingParents of [false, true]) {
    const home = temporary(t);
    const local = join(home, '.local');
    const share = join(local, 'share');
    if (existingParents) {
      mkdirSync(share, { recursive: true });
      chmodSync(local, 0o755);
      chmodSync(share, 0o755);
    }
    const previousMask = process.umask(0);
    try { visibility.install(home); } finally { process.umask(previousMask); }
    for (const directory of [join(share, 'lcu'), join(share, 'lcu/claude')]) {
      assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    }
    assert.equal(statSync(visibility.helperPath(home)).mode & 0o777, 0o600);
    if (existingParents) {
      assert.equal(statSync(local).mode & 0o777, 0o755);
      assert.equal(statSync(share).mode & 0o777, 0o755);
    }
  }
});

test('refresh repairs a 0666 helper and its writable LCU directories even when bytes match', {
  skip: process.platform === 'win32' && 'POSIX permission bits',
}, t => {
  const home = temporary(t);
  visibility.install(home);
  const helper = visibility.helperPath(home);
  const directories = [join(home, '.local/share/lcu'), join(home, '.local/share/lcu/claude')];
  const before = readFileSync(helper);
  chmodSync(helper, 0o666);
  for (const directory of directories) chmodSync(directory, 0o777);
  const previousMask = process.umask(0);
  try { visibility.refresh(home, REPO); } finally { process.umask(previousMask); }
  assert.equal(statSync(helper).mode & 0o777, 0o600);
  for (const directory of directories) assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(helper), before);
});
