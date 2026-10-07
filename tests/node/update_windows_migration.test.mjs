// Round-2 review F2 (.port/reviews/round2-launch.md): `lcu update --post-install` moves LCU-owned Windows
// registrations written by Python releases ([python, -B, <prefix>\windows_launcher.py, flags]) and by the interim
// direct-Node form ([node.exe, <prefix>\...\dispatcher.mjs, flags]) to the validating
// [<SystemRoot>\System32\cmd.exe, /d, /c, <prefix>\lcu.cmd, flags] form through setup's own registration path.
// Windows FIXTURE only (setup.impl.platform = 'win32' with POSIX paths on this host; the upstream registration
// step, setup.impl.configure, is replaced by a stand-in that rewrites the harness file the way add-mcp does).
// No live Windows claim. Chain covered: old registration -> post-install (what a runtime-only update runs) ->
// prune's pin view -> the registered launch command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import * as update from '../../lcu/update.mjs';
import * as setup from '../../lcu/setup.mjs';
import * as maintenance from '../../lcu/maintenance.mjs';
import { dumps, loads } from '../../lcu/compat/pyjson.mjs';
import * as tomllib from '../../lcu/compat/toml.mjs';

const SAVED_ENV = { ...process.env };
const SAVED_SETUP = { ...setup.impl };
const SAVED_UPDATE = { ...update._inject };
const SAVED_IO = { ...setup.io };

let tmp, home, prefix, root, project, out, err, calls, failWith;
const OLD_GEN = () => path.join(prefix, 'apps', 'a'.repeat(64));
const NEW_GEN = () => path.join(prefix, 'apps', 'b'.repeat(64));
const nodeOf = (generation) => path.join(generation, 'app/resources/cua_node/bin/node.exe');
const codexFile = () => path.join(home, '.codex/config.toml');
const claudeFile = () => path.join(project, '.mcp.json');
const piFile = () => path.join(home, 'AppData/Local/LCU/pi/commands.json');
const pinsFile = () => path.join(prefix, 'launcher-pins.json');
const toml = (s) => `'${s}'`;

function writeCodex(argv) {
  fs.mkdirSync(path.dirname(codexFile()), { recursive: true });
  fs.writeFileSync(codexFile(), `[mcp_servers.other]\ncommand = 'other-tool'\n\n[mcp_servers.lcu]\ncommand = ${toml(argv[0])}\n`
    + `args = [${argv.slice(1).map(toml).join(', ')}]\n\n[mcp_servers.lcu.tools.js]\napproval_mode = 'approve'\n`);
}
function writeClaude(argv) {
  fs.writeFileSync(claudeFile(), `${dumps(new Map([['mcpServers', new Map([['keep', new Map([['command', 'x']])],
    ['lcu', new Map([['command', argv[0]], ['args', argv.slice(1)]])]])]]), { indent: 2 })}\n`);
}
const codexArgv = () => {
  const server = tomllib.loads(fs.readFileSync(codexFile(), 'utf8')).get('mcp_servers').get('lcu');
  return [server.get('command'), ...server.get('args')];
};
const claudeArgv = () => {
  const server = loads(fs.readFileSync(claudeFile(), 'utf8')).get('mcpServers').get('lcu');
  return [server.get('command'), ...server.get('args')];
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-winmig-')));
  home = path.join(tmp, 'home');
  prefix = path.join(tmp, 'prefix');
  root = path.join(prefix, 'releases', '0.9.5-abcdefabcdef');
  project = path.join(tmp, 'project');
  for (const dir of [home, root, project, path.dirname(nodeOf(OLD_GEN())), path.dirname(nodeOf(NEW_GEN()))]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'bundle.json'), '{"version": "0.9.5"}');
  fs.writeFileSync(path.join(prefix, '.lcu-install'), '');
  fs.writeFileSync(path.join(prefix, 'lcu.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(prefix, 'windows_launcher.py'), '# old trampoline\n');
  fs.writeFileSync(nodeOf(OLD_GEN()), '');
  fs.writeFileSync(nodeOf(NEW_GEN()), '');
  fs.writeFileSync(path.join(prefix, 'launcher.json'), dumps(new Map([['node', nodeOf(NEW_GEN())],
    ['dispatcher', path.join(prefix, 'launcher-runtimes/current/dispatcher.mjs')]])));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), SystemRoot: 'C:\\Windows',
    XDG_CACHE_HOME: path.join(home, 'xdg') });
  setup.impl.platform = 'win32';
  // Off Windows: POSIX paths on this host, the Windows branches are selected by platform; on a Windows host its own.
  setup.impl.windows_paths = process.platform === 'win32';
  out = ''; err = ''; calls = []; failWith = null;
  setup.io.stdout = (t) => { out += t; };
  setup.io.stderr = (t) => { err += t; };
  update._inject.io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; } };
  setup.impl.installer_environment = (h, names, env) => env;
  setup.impl.installer_paths = (toolsRoot) => [path.join(toolsRoot, 'node.exe'), 'skills', 'add-mcp'];
  // Stand-in for the upstream registration (add-mcp upsertServer / Pi commands.json): rewrites only `lcu`.
  setup.impl.configure = async (names, h, command, toolsRoot, releaseRoot, options) => {
    calls.push({ names, command, toolsRoot, releaseRoot, options });
    if (failWith) return [[names[0], 'MCP', failWith]];
    if (names[0] === 'codex') {
      const text = fs.readFileSync(codexFile(), 'utf8');
      const relay = [path.join(toolsRoot, 'node.exe'), path.join(releaseRoot, 'adapters/codex.mjs'), ...command];
      fs.writeFileSync(codexFile(), text.replace(/\[mcp_servers\.lcu\]\ncommand = .*\nargs = .*\n/,
        `[mcp_servers.lcu]\ncommand = ${toml(relay[0])}\nargs = [${relay.slice(1).map(toml).join(', ')}]\n`));
    } else if (names[0] === 'claude-code') {
      writeClaude([path.join(toolsRoot, 'node.exe'), path.join(releaseRoot, 'adapters/claude.mjs'), ...command]);
    }
    return [];
  };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  Object.assign(setup.impl, SAVED_SETUP);
  Object.assign(setup.io, SAVED_IO);
  Object.assign(update._inject, SAVED_UPDATE);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function legacyFixture() {
  // Python-release Codex user registration, with a caller approval setting and an unrelated server.
  writeCodex(['C:\\Python312\\python.exe', '-B', path.join(prefix, 'windows_launcher.py'), '--audio']);
  // Interim direct-Node Claude Code project registration (inside the relay), pinned to the old generation.
  writeClaude(['C:\\old\\node.exe', path.join(prefix, 'releases/0.9.4-aaaaaaaaaaaa/adapters/claude.mjs'),
    nodeOf(OLD_GEN()), path.join(prefix, 'launcher-runtimes', 'a'.repeat(64), 'dispatcher.mjs'), '--chrome']);
  fs.writeFileSync(pinsFile(), `${dumps(new Map([['registrations', new Map([
    [`claude-code|project|${project}`, nodeOf(OLD_GEN())]])]]), { indent: 2 })}\n`);
  // Another installation's Pi registration: not ours, never touched.
  fs.mkdirSync(path.dirname(piFile()), { recursive: true });
  fs.writeFileSync(piFile(), `${dumps(new Map([['projects', new Map()], ['user', ['py', '-B', 'D:\\other\\windows_launcher.py']]]), { indent: 2 })}\n`);
}

const CMD = () => ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', path.join(prefix, 'lcu.cmd')];

test('post-install migrates owned Python and interim-Node registrations, keeping scope, flags and approval', async () => {
  legacyFixture();
  const piBefore = fs.readFileSync(piFile());
  const status = await update.main(root, ['--post-install']);
  assert.equal(status, 0, err);
  assert.deepEqual(calls.map((c) => [c.names, c.command, c.options.scope, c.options.project, c.options.approval, c.options.setup_command]), [
    [['codex'], [...CMD(), '--audio'], 'user', null, null, path.join(prefix, 'lcu.cmd')],
    [['claude-code'], [...CMD(), '--chrome'], 'project', project, null, path.join(prefix, 'lcu.cmd')],
  ]);
  assert.ok(calls.every((c) => c.releaseRoot === root && c.toolsRoot === path.join(root, 'agent-tools')));
  // Launch: the registered command is the validating cmd form setup builds.
  const codexInner = codexArgv().slice(2);
  assert.equal(setup.windows_command_form(codexInner), 'cmd');
  setup.assert_windows_registration(codexInner);
  assert.deepEqual(codexInner, [...CMD(), '--audio']);
  assert.deepEqual(claudeArgv().slice(2), [...CMD(), '--chrome']);
  // Unrelated entries and the caller's approval setting are preserved; another prefix's registration is untouched.
  const codexDoc = tomllib.loads(fs.readFileSync(codexFile(), 'utf8'));
  assert.equal(codexDoc.get('mcp_servers').get('other').get('command'), 'other-tool');
  assert.equal(codexDoc.get('mcp_servers').get('lcu').get('tools').get('js').get('approval_mode'), 'approve');
  assert.equal(loads(fs.readFileSync(claudeFile(), 'utf8')).get('mcpServers').get('keep').get('command'), 'x');
  assert.ok(fs.readFileSync(piFile()).equals(piBefore));
  // Prune: the old generation is no longer pinned once its registration moved; the current one is.
  const pins = maintenance._launcher_pins(prefix);
  assert.equal(maintenance._pinned_by(OLD_GEN(), pins), false);
  assert.equal(maintenance._pinned_by(NEW_GEN(), pins), true);
  assert.match(out, /Claude Code \(project .*\): registration now runs .*lcu\.cmd\./);
  assert.match(out, /Codex \(user\): registration now runs .*lcu\.cmd\./);
  // Idempotent: a second post-install finds nothing left to migrate.
  calls.length = 0;
  assert.equal(await update.main(root, ['--post-install']), 0);
  assert.equal(calls.length, 0);
});

test('a failed migration is reported, keeps the old registration and its pin, and does not fail the install', async () => {
  legacyFixture();
  failWith = 'installer exited 1: boom';
  const codexBefore = fs.readFileSync(codexFile());
  const pinsBefore = fs.readFileSync(pinsFile());
  assert.equal(await update.main(root, ['--post-install']), 1); // `lcu update` prints its non-fatal hint
  assert.match(err, /lcu update: could not move the Codex \(user\) registration off the previous launcher: MCP: installer exited 1: boom\. It keeps working through the old launcher; rerun `.*lcu\.cmd setup --agent codex` to finish\.\n/);
  assert.match(err, /--agent claude-code --scope project --project /);
  assert.ok(fs.readFileSync(codexFile()).equals(codexBefore));
  assert.ok(fs.readFileSync(pinsFile()).equals(pinsBefore));
  assert.equal(maintenance._pinned_by(OLD_GEN(), maintenance._launcher_pins(prefix)), true);
});

test('unrecognised launcher arguments are reported, not rewritten', async () => {
  writeCodex(['C:\\Python312\\python.exe', '-B', path.join(prefix, 'windows_launcher.py'), '--audio', '--weird']);
  const before = fs.readFileSync(codexFile());
  assert.equal(await update.main(root, ['--post-install']), 1);
  assert.equal(calls.length, 0);
  assert.match(err, /unrecognised launcher arguments --audio --weird/);
  assert.ok(fs.readFileSync(codexFile()).equals(before));
});

test('current-form and foreign registrations, and non-Windows hosts, are left alone', async () => {
  writeCodex(['C:\\x\\node.exe', path.join(root, 'adapters/codex.mjs'), ...CMD()]);
  assert.equal(await update.main(root, ['--post-install']), 0);
  writeCodex(['C:\\Python312\\python.exe', '-B', 'D:\\elsewhere\\windows_launcher.py']);
  assert.equal(await update.main(root, ['--post-install']), 0);
  assert.equal(calls.length, 0);
  setup.impl.platform = 'linux';
  writeCodex(['C:\\Python312\\python.exe', '-B', path.join(prefix, 'windows_launcher.py')]);
  assert.deepEqual(await update.migrate_windows_registrations(root, home), { migrated: [], failures: [] });
  assert.equal(calls.length, 0);
});

test('a registration the harness still lists in the old form after re-registration is reported (Pi)', async () => {
  fs.mkdirSync(path.dirname(piFile()), { recursive: true });
  const before = `${dumps(new Map([['projects', new Map()], ['user', ['py', '-B', path.join(prefix, 'windows_launcher.py'), '--chrome']]]), { indent: 2 })}\n`;
  fs.writeFileSync(piFile(), before);
  assert.equal(await update.main(root, ['--post-install']), 1);
  assert.deepEqual(calls.map((c) => [c.names, c.command, c.options.scope]), [[['pi'], [...CMD(), '--chrome'], 'user']]);
  assert.match(err, /Pi \(user\) registration off the previous launcher: the harness still lists the previous launcher/);
  assert.equal(fs.readFileSync(piFile(), 'utf8'), before);
});
