// Port of tests/test_codex_hooks.py and tests/test_codex_update_notice.py, plus export_files/original_hooks and
// require_cli_hook_support cases the Python suite covers only through live scripts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { ROOT, lcu, nat, tempdir } from './p4_support.mjs';
import { which } from '../../lcu/compat/which.mjs';
import { loads as tomlLoads } from '../../lcu/compat/toml.mjs';
import { toPlain } from '../../lcu/compat/pyjson.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';
import { skipOnWindows } from './windows_skip.mjs';

const hooks = await lcu('codex_hooks');
const { _selected_codex_home, require_cli_hook_support, install_hooks, is_notice_group, notice_hook } = hooks;
const plain = (value) => toPlain(value, { allowReorder: true });

// ------------------------------------------------------------------------------------------- test_codex_hooks
test('absent CODEX_HOME defaults to .codex', () => {
  assert.equal(_selected_codex_home({ HOME: '/home/a', USERPROFILE: '/home/a' }), nat('/home/a/.codex')); // USERPROFILE: Windows' home
});

test('explicit CODEX_HOME is kept', () => {
  assert.equal(_selected_codex_home({ HOME: '/home/a', CODEX_HOME: '/x/c' }), nat('/x/c'));
});

test('empty CODEX_HOME is rejected', () => {
  assert.throws(() => _selected_codex_home({ HOME: '/home/a', CODEX_HOME: '' }), { name: 'ValueError', message: /CODEX_HOME is set but empty/ });
});

test('require_cli_hook_support rejects empty CODEX_HOME', () => {
  // The guard fires before probing for a codex executable on PATH.
  assert.throws(() => require_cli_hook_support({ HOME: '/home/a', CODEX_HOME: '', PATH: '' }), { message: /CODEX_HOME is set but empty/ });
});

// ------------------------------------------------------------------------------------------- require_cli_hook_support
function fakeCodex(t, body) {
  const dir = tempdir(t);
  mkdirSync(`${dir}/bin`);
  writeFileSync(`${dir}/bin/codex`, `#!/bin/sh\n${body}\n`);
  chmodSync(`${dir}/bin/codex`, 0o755);
  return dir;
}

test('require_cli_hook_support passes without codex and with a working one', (t) => {
  assert.equal(require_cli_hook_support({ HOME: '/home/a', PATH: '' }), undefined);
  const dir = fakeCodex(t, 'echo "$@ $HOME $CODEX_HOME" >> "$LOG"; cat "$CODEX_HOME/config.toml" >> "$LOG"; exit 0');
  // LOG is not forwarded (only PATH, LANG, LC_ALL, TMPDIR, SystemRoot, SYSTEMROOT, PATHEXT): write it via PATH dir.
  const env = { PATH: `${dir}/bin:/usr/bin:/bin`, HOME: '/home/a', LOG: `${dir}/log` };
  require_cli_hook_support(env);
});

test('require_cli_hook_support probes with an isolated home and reports a failing CLI', { skip: skipOnWindows('the fake Codex CLI is a #! shell script; Windows runs codex.exe and the probe passes only a fixed environment (no way to hand a script to a copy of node.exe)') }, (t) => {
  const dir = fakeCodex(t, [
    'if [ "$1" = "--version" ]; then echo " codex-cli 0.1.0 "; exit 0; fi',
    `printf '%s\\n' "$*" "$HOME" "$CODEX_HOME" "$(pwd -P)" "\${LOG-unset}" > "${'$'}{0%/bin/codex}/probe"`,
    'cat "$CODEX_HOME/config.toml" >> "${0%/bin/codex}/probe"',
    'echo "unknown variant  \\`mcp_tool\\`" >&2; exit 2',
  ].join('\n'));
  const env = { PATH: `${dir}/bin:/usr/bin:/bin`, HOME: '/home/a', LOG: 'secret' };
  assert.throws(() => require_cli_hook_support(env), {
    name: 'ValueError',
    message: `Installed Codex CLI ${dir}/bin/codex (codex-cli 0.1.0) cannot load the original MCP lifecycle hooks. ` +
      'Codex reported: unknown variant `mcp_tool`.  Update this standalone Codex CLI to the latest public release with ' +
      'MCP tool hook support (official npm package: `npm install -g @openai/codex@latest`), then rerun `lcu setup --agent codex`.',
  });
  const probe = readFileSync(`${dir}/probe`, 'utf8').split('\n');
  assert.equal(probe[0], 'mcp list');
  assert.equal(probe[1], probe[2]); // HOME == CODEX_HOME == the probe directory
  assert.match(probe[1], /\/lcu-codex-hook-probe-[a-z0-9_]{8}$/);
  assert.ok(probe[3].endsWith(probe[1].split('/').at(-1)));
  assert.equal(probe[4], 'unset'); // only the safe environment reaches the probe
  assert.equal(probe.slice(5).join('\n'), '[hooks]\nStop = [{ hooks = [{ type = "mcp_tool", server = "lcu", tool = "turn_ended", input = { session_id = "s", turn_id = "t" } }] }]\n');
});

test('require_cli_hook_support without output says unknown version and no detail', { skip: skipOnWindows('the fake Codex CLI is a #! shell script; Windows runs codex.exe and the probe passes only a fixed environment (no way to hand a script to a copy of node.exe)') }, (t) => {
  const dir = fakeCodex(t, 'exit 1');
  assert.throws(() => require_cli_hook_support({ PATH: `${dir}/bin:/usr/bin:/bin`, HOME: '/h' }), {
    message: `Installed Codex CLI ${dir}/bin/codex (unknown version) cannot load the original MCP lifecycle hooks. Update this standalone Codex CLI to the latest public release with MCP tool hook support (official npm package: \`npm install -g @openai/codex@latest\`), then rerun \`lcu setup --agent codex\`.`,
  });
});

// ------------------------------------------------------------------------------------------- test_codex_update_notice
test('notice hook runs the stable command quoted', () => {
  const group = plain(notice_hook('/a b/current/bin/lcu'));
  const hook = group.hooks[0];
  assert.equal(hook.type, 'command');
  assert.equal(hook.command, "'/a b/current/bin/lcu' update --notice --hook SessionStart");
  assert.ok(hook.commandWindows.endsWith(' update --notice --hook SessionStart'));
  assert.deepEqual([group.matcher, hook.timeout, hook.statusMessage], ['startup|resume', 10, 'Checking for LCU updates']);
  const prompt = plain(notice_hook('/a b/current/bin/lcu', 'UserPromptSubmit'));
  assert.equal('matcher' in prompt, false);
  const promptHook = prompt.hooks[0];
  assert.equal(promptHook.command, "'/a b/current/bin/lcu' update --notice --hook UserPromptSubmit");
  assert.ok(promptHook.commandWindows.endsWith(' update --notice --hook UserPromptSubmit'));
  assert.equal(promptHook.timeout, 5);
  assert.equal('statusMessage' in promptHook, false);
  // Key order as Python builds the dicts.
  assert.deepEqual(Object.keys(group), ['matcher', 'hooks']);
  assert.deepEqual(Object.keys(hook), ['type', 'command', 'commandWindows', 'timeout', 'statusMessage']);
  assert.equal(hook.commandWindows, '"/a b/current/bin/lcu" update --notice --hook SessionStart');
});

test('notice ownership detection', () => {
  assert.equal(is_notice_group(notice_hook('/x/current/bin/lcu')), true);
  assert.equal(is_notice_group(notice_hook('/x y/lcu')), true);
  assert.equal(is_notice_group(notice_hook('/x/lcu.cmd', 'UserPromptSubmit')), true);
  assert.equal(is_notice_group(notice_hook('/x/lcu', 'UserPromptSubmit'), 'UserPromptSubmit'), true);
  assert.equal(is_notice_group(notice_hook('/x/lcu', 'UserPromptSubmit'), 'SessionStart'), false);
  for (const other of [
    { hooks: [{ type: 'command', command: 'echo hi' }] },
    { hooks: [{ type: 'command', command: '/x/other update --notice --hook SessionStart' }] },
    { hooks: [{ type: 'command', command: '/x/lcu update --notice --hook-json' }] },
    { hooks: [{ type: 'command', command: '/x/lcu update --notice --hook Stop' }] },
    { hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'turn_ended' }] },
    { hooks: [] },
  ]) {
    assert.equal(is_notice_group(other), false);
    assert.equal(is_notice_group(new Map(Object.entries(other))), false);
  }
  // Unbalanced quoting in someone else's hook: not ours.
  assert.equal(is_notice_group({ hooks: [{ type: 'command', command: "'/x/lcu update --notice --hook SessionStart" }] }), false);
  assert.equal(is_notice_group('not a dict'), false);
});

// ------------------------------------------------------------------------------------------- export_files / original_hooks
function host(t, events = ['Stop', 'Interrupt', 'SubagentStop'], server = 'cua_repl') {
  const root = tempdir(t);
  const hostRoot = `${root}/host`;
  const plugin = `${hostRoot}/plugins/unified-computer-use`;
  mkdirSync(`${plugin}/.codex-plugin`, { recursive: true });
  const hook = { type: 'mcp_tool', server, tool: 'turn_ended', input: { session_id: 's', turn_id: 't' } };
  const manifest = { name: 'unified-computer-use', version: '1.0.0', description: 'orig',
    hooks: { hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ ...hook }] }]])) } };
  writeFileSync(`${plugin}/.codex-plugin/plugin.json`, JSON.stringify(manifest));
  writeFileSync(`${plugin}/.mcp.json`, '{"mcpServers": {"cua_repl": {"command": "x", "args": [], "startup_timeout_sec": 120.0, "enabled": false}}}');
  return { root, hostRoot };
}

test('original_hooks retargets the upstream records and rejects contract changes', (t) => {
  const { hostRoot } = host(t);
  const events = plain(hooks.original_hooks(hostRoot));
  assert.deepEqual(Object.keys(events), ['Stop', 'Interrupt', 'SubagentStop']);
  assert.equal(events.Stop[0].hooks[0].server, 'lcu');
  assert.throws(() => hooks.original_hooks(host(t, ['Stop', 'Interrupt']).hostRoot),
    { name: 'ValueError', message: 'Upstream lifecycle events changed; review before installation.' });
  assert.throws(() => hooks.original_hooks(host(t, undefined, 'other').hostRoot),
    { name: 'ValueError', message: 'Upstream lifecycle contract changed; review before installation.' });
});

test('export_files mirrors the original plugin byte for byte as Python writes it', (t) => {
  const { hostRoot } = host(t);
  const files = hooks.export_files(['/opt/lcu/bin/lcu', '--chrome'], hostRoot);
  assert.deepEqual(Object.keys(files), ['.codex-plugin/plugin.json', '.mcp.json', 'lifecycle-contract.json']);
  const hook = '{\n              "type": "mcp_tool",\n              "server": "lcu",\n              "tool": "turn_ended",\n              "input": {\n                "session_id": "s",\n                "turn_id": "t"\n              }\n            }';
  assert.equal(files['.mcp.json'].toString(),
    '{\n  "mcpServers": {\n    "lcu": {\n      "command": "/opt/lcu/bin/lcu",\n      "args": [\n        "--chrome"\n      ],\n' +
    '      "startup_timeout_sec": 120.0,\n      "enabled": true\n    }\n  }\n}\n');
  const manifest = files['.codex-plugin/plugin.json'].toString();
  assert.ok(manifest.startsWith('{\n  "name": "lcu",\n  "version": "1.0.0",\n  "description": "Computer use through the locally installed Codex runtime.",\n  "hooks": {\n    "hooks": {\n      "Stop": [\n        {\n          "hooks": [\n            ' + hook), manifest);
  const contract = JSON.parse(files['lifecycle-contract.json'].toString());
  assert.deepEqual(Object.keys(contract), ['hooks', 'requestMetadata', 'lifecycle', 'unsupportedHosts', 'codexTrust']);
});

// ------------------------------------------------------------------------------------------- install_hooks (real Codex CLI)
const CODEX = which('codex');

function installFixture(t) {
  const { root, hostRoot } = host(t);
  const home = `${root}/home`;
  mkdirSync(home);
  const config = `${home}/config.toml`;
  const env = { ...process.env, HOME: home, CODEX_HOME: home };
  const install = (notice) => install_hooks(CODEX, config, root, env, hostRoot, notice);
  return { root, home, config, install };
}

const loadConfig = (config) => plain(tomlLoads(readFileSync(config, 'utf8')));

test('install is trusted, idempotent and removable', { skip: CODEX ? false : 'Codex CLI not installed', timeout: 300000 }, (t) => {
  const { config, install } = installFixture(t);
  writeFileSync(config, '[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo mine" }] }]\n');
  install('/p/current/bin/lcu');
  const first = readFileSync(config);
  let data = loadConfig(config);
  assert.deepEqual(new Set(Object.keys(data.hooks).filter((k) => k !== 'state')),
    new Set(['Stop', 'Interrupt', 'SubagentStop', 'SessionStart', 'UserPromptSubmit']));
  let start = data.hooks.SessionStart;
  assert.equal(start[0].hooks[0].command, 'echo mine');
  assert.equal(start.filter((g) => is_notice_group(g)).length, 1);
  assert.equal(Object.keys(data.hooks.state).filter((k) => k.includes('session_start:1:0')).length, 1);
  let prompt = data.hooks.UserPromptSubmit;
  assert.equal(prompt.length, 1);
  assert.equal(is_notice_group(prompt[0], 'UserPromptSubmit'), true);
  assert.equal(Object.keys(data.hooks.state).filter((k) => k.includes('user_prompt_submit:0:0')).length, 1);
  assert.equal(Object.keys(data.hooks.state).length, 5); // three original hooks + two notices; 'echo mine' stays untrusted
  install('/p/current/bin/lcu');
  assert.deepEqual(readFileSync(config), first);
  install('/q/current/bin/lcu');
  data = loadConfig(config);
  start = data.hooks.SessionStart;
  assert.deepEqual(start.map((g) => is_notice_group(g)), [false, true]);
  assert.ok(start[1].hooks[0].command.includes('/q/current/bin/lcu'));
  prompt = data.hooks.UserPromptSubmit;
  assert.equal(prompt.length, 1);
  assert.ok(prompt[0].hooks[0].command.includes('/q/current/bin/lcu'));
  install(null);
  data = loadConfig(config);
  assert.deepEqual(data.hooks.SessionStart.map((g) => g.hooks[0].command), ['echo mine']);
  assert.deepEqual(data.hooks.UserPromptSubmit ?? [], []);
});

test('install refuses a modified LCU lifecycle hook', { skip: CODEX ? false : 'Codex CLI not installed', timeout: 300000 }, (t) => {
  const { config, install } = installFixture(t);
  const before = '[hooks]\nStop = [{ hooks = [{ type = "mcp_tool", server = "lcu", tool = "turn_ended", input = { session_id = "x" } }] }]\n';
  writeFileSync(config, before);
  assert.throws(() => install(null), { name: 'ValueError', message: 'Existing LCU Stop hook differs from upstream; review it before setup.' });
  assert.equal(readFileSync(config, 'utf8'), before);
  writeFileSync(config, '[hooks]\nStop = "x"\n');
  assert.throws(() => install(null), { name: 'ValueError', message: 'Invalid existing Codex hook list: Stop' });
  writeFileSync(config, 'hooks = [\n');
  assert.throws(() => install(null), { name: 'TOMLDecodeError', message: 'Invalid value (at end of document)' });
});

test('install writes the same bytes as the Python implementation', {
  skip: CODEX && which('python3') ? false : 'Codex CLI or python3 not installed', timeout: 300000,
}, (t) => {
  const { root, home, config, install } = installFixture(t);
  const initial = '# mine\nmodel = "gpt-x"  # kept\n[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo mine", timeout = 5 }] }]\n';
  const python = (notice) => {
    const script = 'import json, os, sys\nsys.path.insert(0, sys.argv[1])\nfrom lcu.codex_hooks import install_hooks\n' +
      'a = json.loads(sys.argv[2])\ninstall_hooks(a["cli"], a["config"], a["cwd"], dict(os.environ), a["host"], a["notice"])\n';
    const args = JSON.stringify({ cli: CODEX, config, cwd: root, host: `${root}/host`, notice });
    const result = spawnSync('python3', ['-B', '-c', script, ORACLE_ROOT, args], {
      env: { ...process.env, HOME: home, CODEX_HOME: home }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  for (const notice of ['/p/current/bin/lcu', null]) {
    rmSync(config, { force: true });
    writeFileSync(config, initial);
    python(notice);
    const expected = readFileSync(config, 'utf8');
    writeFileSync(config, initial);
    install(notice);
    assert.equal(readFileSync(config, 'utf8'), expected);
  }
});
