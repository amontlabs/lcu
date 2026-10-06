// scripts/install.sh: the pre-Node bootstrap (static help, --existing-app parsing, Node gate, env quarantine).
// Replaces tests/test_interpreter.py::test_installer_shell_script_selects_python_312 (the Python-version gate is
// gone by design: the bootstrap now requires the selected app's own Node and gates it before executing it).
//
// LCU_UPDATE_INSTALL_SH=1 node --test tests/node/install_sh.test.mjs   regenerates the static help blocks and the
// LCU COMMON block (lcu/shim/common.sh verbatim) in scripts/install.sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/install.sh');
// Fixture apps must pass the gate (no group/other-writable directory): do not inherit a 0002 umask (CI runners).
process.umask(0o022);
const HOST = process.platform === 'darwin' ? 'Darwin' : 'Linux';

const MARKERS = {
  Linux: ["cat <<'LCU_STATIC_HELP_LINUX'\n", '\nLCU_STATIC_HELP_LINUX\n'],
  Darwin: ["cat <<'LCU_STATIC_HELP_DARWIN'\n", '\nLCU_STATIC_HELP_DARWIN\n'],
};

/** Help text argparse prints at the default width (COLUMNS unset, no terminal: 80 columns). */
async function generatedHelp(system) {
  const saved = process.env.COLUMNS;
  process.env.COLUMNS = '80';
  try {
    const setup = await import('../../lcu/setup.mjs');
    const previous = setup.impl.platform;
    setup.impl.platform = system === 'Linux' ? 'linux' : 'darwin';
    try {
      const module = system === 'Linux'
        ? await import('../../scripts/install.mjs') : await import('../../scripts/install_macos.mjs');
      return module.build_parser().format_help();
    } finally {
      setup.impl.platform = previous;
    }
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
  }
}

function staticHelp(text, system) {
  const [open, close] = MARKERS[system];
  const start = text.indexOf(open) + open.length;
  const end = text.indexOf(close, start);
  return text.slice(start, end + 1);
}

function replaceHelp(text, system, help) {
  const [open, close] = MARKERS[system];
  const start = text.indexOf(open) + open.length;
  const end = text.indexOf(close, start);
  return text.slice(0, start) + help.replace(/\n$/, '') + text.slice(end);
}

const COMMON = fs.readFileSync(path.join(ROOT, 'lcu/shim/common.sh'), 'utf8');
const BEGIN = '# BEGIN LCU COMMON';
const END = '# END LCU COMMON\n';
const commonBlock = (text) => text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length);

if (process.env.LCU_UPDATE_INSTALL_SH === '1' || process.env.LCU_UPDATE_STATIC_HELP === '1') {
  let text = fs.readFileSync(SCRIPT, 'utf8');
  for (const system of ['Linux', 'Darwin']) text = replaceHelp(text, system, await generatedHelp(system));
  text = text.replace(commonBlock(text), () => COMMON);
  fs.writeFileSync(SCRIPT, text);
}

test('the LCU COMMON block is lcu/shim/common.sh verbatim (no hand-copied gate)', () => {
  assert.equal(commonBlock(fs.readFileSync(SCRIPT, 'utf8')), COMMON);
});

test('the static help equals the argparse output of both installer parsers', async () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  for (const system of ['Linux', 'Darwin']) {
    assert.equal(staticHelp(text, system), await generatedHelp(system), system);
  }
});

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-sh-')));
  const archive = path.join(base, 'archive');
  fs.mkdirSync(path.join(archive, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(archive, 'scripts/install.sh'));
  return { base, archive, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const run = (archive, args, env = {}) => spawnSync('/bin/sh', [path.join(archive, 'scripts/install.sh'), ...args], {
  encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), ...env },
});

// A fake app whose "node" is a shell script that prints what it received (argv and the quarantined env).
function fakeApp(base, { mode = 0o755 } = {}) {
  const app = path.join(base, HOST === 'Linux' ? 'chatgpt' : 'ChatGPT.app');
  const node = path.join(app, HOST === 'Linux' ? 'resources/cua_node/bin/node' : 'Contents/Resources/cua_node/bin/node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$@"\nenv | grep -E "^(__LCU[A-Z_]*|NODE_OPTIONS|NODE_PATH|PATH)=" | sort\n');
  fs.chmodSync(node, mode);
  return { app, node };
}

test('--help is answered from the static text when the app (and so Node) is missing', async () => {
  const { archive, base, cleanup } = sandbox();
  try {
    for (const flag of ['--help', '-h', '--he']) {
      const result = run(archive, [flag, '--existing-app', path.join(base, 'missing')]);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, await generatedHelp(HOST));
      assert.equal(result.stderr, '');
    }
  } finally {
    cleanup();
  }
});

test('a missing app gives the pre-Node gate diagnostic before any Node runs', () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const missing = path.join(base, 'missing');
    const result = run(archive, ['--runtime-only', `--exi=${missing}`]);
    assert.equal(result.status, 1);
    const relative = HOST === 'Linux' ? 'resources/cua_node/bin/node' : 'Contents/Resources/cua_node/bin/node';
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${missing}/${relative}): it is missing. Repair the official app and rerun the LCU installer.\n`);
    assert.equal(result.stdout, '');
  } finally {
    cleanup();
  }
});

test('an app without an executable Node is refused with the bootstrap message', () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const { app, node } = fakeApp(base, { mode: 0o644 });
    const result = run(archive, ['--existing-app', app]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${node}): ${node} is not an executable file. Repair the official app and rerun the LCU installer.\n`);
    fs.rmSync(node);
    assert.equal(run(archive, ['--existing-app', app]).stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${node}): it is missing. Repair the official app and rerun the LCU installer.\n`);
  } finally {
    cleanup();
  }
});

test('--existing-app follows argparse rules: abbreviations, =value, last one wins, stops at --', { skip: HOST !== 'Linux' && 'the macOS gate requires an OpenAI signature' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const { app } = fakeApp(base);
    const other = path.join(base, 'other');
    for (const args of [['--existing-app', app], [`--existing-app=${app}`], ['--exist', app],
      ['--existing-app', other, '--exi', app], ['--existing-app', app, '--', '--existing-app', other]]) {
      const result = run(archive, args);
      assert.equal(result.status, 0, `${args}: ${result.stderr}`);
      assert.match(result.stdout, /^--disable-warning=ExperimentalWarning\n/);
    }
    // --ex is ambiguous (--export) and is not taken as --existing-app: the default location is used.
    const ambiguous = run(archive, ['--ex', app]);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /^LCU: Cannot run the ChatGPT app's bundled Node \(\/usr\/lib\/chatgpt\/resources\/cua_node\/bin\/node\): it is missing\./);
  } finally {
    cleanup();
  }
});

test('the gate refuses a Node in a group- or other-writable location', { skip: HOST !== 'Linux' && 'Linux gate' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const { app, node } = fakeApp(base);
    fs.chmodSync(path.dirname(node), 0o777);
    const result = run(archive, ['--existing-app', app]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${node}): ${path.dirname(node)} is writable by group or other accounts. Repair the official app and rerun the LCU installer.\n`);
    fs.chmodSync(path.dirname(node), 0o755);
    fs.chmodSync(node, 0o775);
    assert.match(run(archive, ['--existing-app', app]).stderr, /bin\/node is writable by group or other accounts/);
    // --help still works when the gate refuses Node.
    const help = run(archive, ['--existing-app', app, '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: install\.py /);
  } finally {
    cleanup();
  }
});

test('as root, the gate refuses a Node owned by another account (even the --user desktop account)', { skip: (HOST !== 'Linux' || process.getuid() !== 0) && 'Linux, root only' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const { app, node } = fakeApp(base);
    fs.chownSync(node, 1000, 1000);
    const result = run(archive, ['--existing-app', app, '--user', 'ubuntu', '--runtime-only']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${node}): ${node} is owned by uid 1000. Repair the official app and rerun the LCU installer.\n`);
    assert.equal(result.stdout, '');
  } finally {
    cleanup();
  }
});

test('the macOS gate requires the OpenAI code signature before Node runs', { skip: HOST !== 'Darwin' && 'macOS gate' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const { app, node } = fakeApp(base);
    const result = run(archive, ['--existing-app', app]);
    assert.equal(result.status, 1);
    // Round-2 F1: the selected bundle is validated first, in lcu/platforms.py's order (this fixture has no
    // Info.plist); the signature check of a correctly identified bundle is covered in tests/node/entry.test.mjs.
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${node}): Application bundle metadata is missing: ` +
      `${app}/Contents/Info.plist. Repair the official app and rerun the LCU installer.\n`);
    assert.equal(result.stdout, '');
  } finally {
    cleanup();
  }
});

test('review R1: as root, a Node reached through a link in another account\'s directory is refused', { skip: (HOST !== 'Linux' || process.getuid() !== 0) && 'Linux, root only' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    // <app>/resources/cua_node/bin/node -> <base>/controlled/hop -> <base>/trusted/node; controlled is uid 1000's.
    const { app, node } = fakeApp(base);
    const trusted = path.join(base, 'trusted');
    fs.mkdirSync(trusted);
    fs.renameSync(node, path.join(trusted, 'node'));
    const controlled = path.join(base, 'controlled');
    fs.mkdirSync(controlled);
    fs.symlinkSync(path.join(trusted, 'node'), path.join(controlled, 'hop'));
    fs.chownSync(controlled, 1000, 1000);
    fs.symlinkSync(path.join(controlled, 'hop'), node);
    const result = run(archive, ['--existing-app', app, '--user', 'ubuntu', '--runtime-only']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${node}): ${controlled} is owned by uid 1000. Repair the official app and rerun the LCU installer.\n`);
    assert.equal(result.stdout, '');
  } finally {
    cleanup();
  }
});

test('review R6: --existing-app is expanded like str(Path(arg).expanduser())', { skip: HOST !== 'Linux' && 'Linux gate' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    // Fixtures at <HOME> and at <cwd>/~: Python normalises './~' to '~' and expands HOME.
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    const node = path.join(home, 'resources/cua_node/bin/node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\nprintf "HOME_APP %s\\n" "$0"\n');
    fs.chmodSync(node, 0o755);
    const decoy = path.join(base, '~/resources/cua_node/bin/node');
    fs.mkdirSync(path.dirname(decoy), { recursive: true });
    fs.writeFileSync(decoy, '#!/bin/sh\necho DECOY\n');
    fs.chmodSync(decoy, 0o755);
    const result = spawnSync('/bin/sh', [path.join(archive, 'scripts/install.sh'), '--existing-app', './~'],
      { encoding: 'utf8', cwd: base, env: { PATH: '/usr/bin:/bin', HOME: home } });
    assert.equal(result.stdout, `HOME_APP ${node}\n`, result.stderr);
    // Python: Path('~x').expanduser() for an unknown account raises; the bootstrap reports it before any Node.
    const unknown = run(archive, ['--existing-app', '~no_such_account_zz']);
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stderr, 'LCU installer: Could not determine home directory.\n');
  } finally {
    cleanup();
  }
});

test('Node startup variables are quarantined and the caller PATH is left alone', { skip: HOST !== 'Linux' && 'Linux gate' }, () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const { app } = fakeApp(base);
    const result = run(archive, ['--existing-app', app, '--runtime-only'],
      { NODE_OPTIONS: '--require /evil.js', NODE_PATH: '', PATH: '/custom/bin:/usr/bin:/bin', OPENSSL_CONF: '/x.cnf' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [
      '--disable-warning=ExperimentalWarning', path.join(archive, 'scripts/install.mjs'), '--existing-app', app,
      '--runtime-only', 'PATH=/custom/bin:/usr/bin:/bin', '__LCU_Q=NODE_OPTIONS,NODE_PATH,OPENSSL_CONF',
      '__LCU_Q_NODE_OPTIONS=--require /evil.js', '__LCU_Q_NODE_PATH=', '__LCU_Q_OPENSSL_CONF=/x.cnf', '',
    ].join('\n'));
  } finally {
    cleanup();
  }
});

test('startup_env.mjs restores the quarantined variables and removes every __LCU_ key', () => {
  const env = { PATH: process.env.PATH, __LCU_Q: 'NODE_OPTIONS,NODE_PATH', __LCU_Q_NODE_OPTIONS: '--x y', __LCU_Q_NODE_PATH: '', __LCU_OTHER: '1' };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(path.join(ROOT, 'scripts/startup_env.mjs'))}); process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('NODE_') || k.startsWith('__LCU')))));`],
  { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { NODE_OPTIONS: '--x y', NODE_PATH: '' });
});

test('startup_env.mjs refuses non-UTF-8 environment bytes as lcu/entry.mjs does', () => {
  const entry = path.join(os.tmpdir(), `lcu-startup-${process.pid}`, 'install.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  try {
    fs.writeFileSync(entry, `import ${JSON.stringify(path.join(ROOT, 'scripts/startup_env.mjs'))};\nprocess.stdout.write('RAN\\n');\n`);
    // macOS: the shim's flag; Linux: the raw bytes in /proc/self/environ.
    const flagged = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', __LCU_ENV_INVALID: '1' } });
    assert.equal(flagged.status, 1);
    assert.equal(flagged.stderr, 'LCU installer: An argument or environment variable is not valid UTF-8; LCU cannot pass it on unchanged. Unset or re-encode it and retry.\n');
    if (process.platform === 'linux') {
      const raw = spawnSync('/bin/sh', ['-c', 'BAD=$(printf "a\\377") exec "$0" "$1"', process.execPath, entry], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      assert.equal(raw.status, 1);
      assert.equal(raw.stderr, 'LCU installer: The environment variable BAD is not valid UTF-8; LCU cannot pass it on unchanged. Unset or re-encode it and retry.\n');
    }
    assert.equal(spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout, 'RAN\n');
  } finally {
    fs.rmSync(path.dirname(entry), { recursive: true, force: true });
  }
});

test('unsupported platforms are refused before Node', () => {
  const { archive, base, cleanup } = sandbox();
  try {
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho FreeBSD\n');
    fs.chmodSync(path.join(bin, 'uname'), 0o755);
    // The script pins PATH for its tools, so emulate another system by editing a copy.
    const text = fs.readFileSync(SCRIPT, 'utf8').replace('__LCU_OS=$("$__LCU_T_UNAME" -s)', `__LCU_OS=$(${bin}/uname)`);
    fs.writeFileSync(path.join(archive, 'scripts/install.sh'), text);
    const result = run(archive, ['--help']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'LCU installation currently supports Linux and macOS.\n');
  } finally {
    cleanup();
  }
});

test('every installer/launcher copy of the startup-variable list equals lcu/startup_vars.mjs', async () => {
  const { QUARANTINED } = await import('../../lcu/startup_vars.mjs');
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const loop = /for __LCU_NAME in ([^;]*); do/.exec(text)[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(loop, QUARANTINED, 'install.sh (LCU COMMON)');
  assert.deepEqual((await import('../../scripts/startup_env.mjs')).QUARANTINED, QUARANTINED, 'startup_env.mjs');
  assert.deepEqual((await import('../../scripts/windows_launcher.mjs')).QUARANTINED, QUARANTINED, 'windows_launcher.mjs');
  for (const name of ['install_windows.py', 'windows_launcher.py']) {
    const python = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
    const listed = [.../^QUARANTINED = \(([^)]*)\)/m.exec(python)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(listed, QUARANTINED, name);
  }
});

test('the old updater trampolines exec /bin/sh install.sh with the same arguments', () => {
  for (const name of ['install.py', 'install_macos.py']) {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
    // '-p': an explicitly named shell ignores install.sh's '#!/bin/sh -p' (round-2 review F3).
    assert.match(text, /os\.execv\('\/bin\/sh', \['\/bin\/sh', '-p', script, \*sys\.argv\[1:\]\]\)/);
  }
  const { archive, cleanup } = sandbox();
  try {
    fs.copyFileSync(path.join(ROOT, 'scripts/install.py'), path.join(archive, 'scripts/install.py'));
    fs.writeFileSync(path.join(archive, 'scripts/install.sh'), 'printf "%s|" "$0" "$@"\n');
    const result = spawnSync('python3', ['-B', path.join(archive, 'scripts/install.py'), '--prefix', '/opt/x', 'a b'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${path.join(archive, 'scripts/install.sh')}|--prefix|/opt/x|a b|`);
  } finally {
    cleanup();
  }
});
