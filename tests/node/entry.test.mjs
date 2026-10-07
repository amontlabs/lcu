// lcu/entry.mjs, lcu/startup_vars.mjs, lcu/shim/common.sh and the POSIX launchers in bin/ (design addendum
// A/B/C of .port/BRIEF.md; findings of .port/reviews/port-runtime.md and the gate findings R1/R2/R6 of
// .port/reviews/port-installers.md). Replaces tests/test_interpreter.py: interpreter selection is gone by design.
//
// Fixture releases live under the test's own temporary directory. On macOS the release Node links to the real
// ChatGPT app's signed Node (executed read-only; skipped when the app is absent); on Linux to the Node running
// this test. SAFETY RULE (.port/BRIEF.md): no test here sends a signal to any process; ignored-signal cases only
// start children with a disposition already set to SIG_IGN by their own (spawned) parent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exit_status } from '../../lcu/entry.mjs';
import { QUARANTINED, quarantine_environment, restore_environment } from '../../lcu/startup_vars.mjs';
import { HELP_SUFFIX, USAGE } from '../../lcu/runtime.mjs';
import { hostileEnvironments, standIns } from './path_hijack.mjs';
import { DISPOSITION_SCRIPT, python312, tempDir } from './runtime_support.mjs';

const PYTHON = python312();

// The gate refuses a Node whose directories or file are group/other-writable. Fixtures must not inherit the caller's
// umask (Ubuntu users, CI runners: 0002 makes every created directory group-writable) nor the mode of the Node they
// copy (hosted toolcache Nodes are 0775).
process.umask(0o022);

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SHIMS = ['lcu', 'lcu-session', 'lcu-codex-sandbox'];
const APP_NODE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const COMMON = readFileSync(join(REPO, 'lcu/shim/common.sh'), 'utf8');
const shimText = (name) => readFileSync(join(REPO, 'bin', name), 'utf8');
const BEGIN = '# BEGIN LCU COMMON';
const END = '# END LCU COMMON\n';
const block = (text) => (text.includes(BEGIN) ? text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length) : null);
// What the host's /bin/sh adds to an environment it did not receive (documented residual, notes/entry.md).
// IFS: every POSIX shell resets an inherited IFS to <space><tab><newline> (the value is lost before line 1).
const SHELL_ADDED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING']); // the last: macOS adds it to any process (Python too)
// bash (macOS /bin/sh) also rewrites an inherited SHELLOPTS/BASHOPTS to its own options (-p keeps them inert).
const SHELL_RESET = new Set(['IFS', 'SHELLOPTS', 'BASHOPTS']);

// Linux: an app laid out like the official one, whose bundled Node is a copy of the Node running this test
// (the gate requires the physical Node to be <selected app>/resources/cua_node/bin/node). Made once per file.
let linuxApp = null;
const NODE_IN_APP = process.platform === 'darwin' ? '/Contents/Resources/cua_node/bin/node' : '/resources/cua_node/bin/node';
function trustedNode() {
  if (process.platform === 'darwin') return existsSync(APP_NODE) ? APP_NODE : null;
  if (linuxApp === null) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-entry-app-')));
    process.on('exit', () => rmSync(base, { recursive: true, force: true }));
    linuxApp = join(base, 'chatgpt');
    mkdirSync(join(linuxApp, 'resources/cua_node/bin'), { recursive: true });
    cpSync(process.execPath, join(linuxApp, NODE_IN_APP));
    chmodSync(join(linuxApp, NODE_IN_APP), 0o755);
  }
  return join(linuxApp, NODE_IN_APP);
}
const appOf = (node) => (node && node.endsWith(NODE_IN_APP) ? node.slice(0, -NODE_IN_APP.length) : null);

// A release laid out like an installed one: bin/ (the launchers), lcu/, agent-tools/node/bin/node -> node, and the
// `app` link to the selected application (default: the app enclosing `node`).
function release(base, node, { entry = null, name = 'release with space', app = undefined } = {}) {
  const root = join(base, name);
  mkdirSync(join(root, 'bin'), { recursive: true });
  for (const shim of SHIMS) {
    cpSync(join(REPO, 'bin', shim), join(root, 'bin', shim));
    chmodSync(join(root, 'bin', shim), 0o755);
  }
  if (entry === null) cpSync(join(REPO, 'lcu'), join(root, 'lcu'), { recursive: true, filter: (src) => !src.includes('__pycache__') });
  else {
    mkdirSync(join(root, 'lcu'));
    writeFileSync(join(root, 'lcu/entry.mjs'), entry);
  }
  mkdirSync(join(root, 'agent-tools/node/bin'), { recursive: true });
  if (node !== null) symlinkSync(node, join(root, 'agent-tools/node/bin/node'));
  const selected = app === undefined ? appOf(node) : app;
  if (selected) symlinkSync(selected, join(root, 'app'));
  return root;
}

// A task-created macOS bundle: Info.plist identifiers (null: no plist) and a node (a script unless `node` is given).
function plist(identifier) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key>' +
    `<string>${identifier}</string></dict></plist>\n`;
}
function fixtureBundle(base, { app = 'com.openai.codex', helper = 'com.openai.sky.CUAService', node = null, marker } = {}) {
  const bundle = join(base, 'fixture-apps', 'ChatGPT.app');
  const bin = join(bundle, 'Contents/Resources/cua_node/bin');
  mkdirSync(bin, { recursive: true });
  if (app !== null) writeFileSync(join(bundle, 'Contents/Info.plist'), plist(app));
  const helperContents = join(bundle, 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents');
  mkdirSync(helperContents, { recursive: true });
  if (helper !== null) writeFileSync(join(helperContents, 'Info.plist'), plist(helper));
  if (node) symlinkSync(node, join(bin, 'node'));
  else {
    writeFileSync(join(bin, 'node'), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(bin, 'node'), 0o755);
  }
  return bundle;
}

// An entry module that reports what it received, then restores the environment exactly like lcu/entry.mjs.
const PROBE = `
  const before = Object.keys(process.env).filter((k) => k.startsWith('__LCU_')).sort();
  const raw = { sigign: process.env.__LCU_SIGIGN ?? null, invalid: process.env.__LCU_ENV_INVALID ?? null };
  const { restore_environment } = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
  const restored = restore_environment();
  process.stdout.write(JSON.stringify({ before, raw, restored, argv: process.argv.slice(2), execArgv: process.execArgv,
    execPath: process.execPath, env: process.env }));
`;

const run = (file, args, env = {}, options = {}) => spawnSync(file, args, {
  encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent-home', ...env }, ...options });

describe('shim sources', () => {
  it('every LCU COMMON block in the repository is lcu/shim/common.sh verbatim, and the launchers are generated', () => {
    assert.ok(COMMON.startsWith(BEGIN) && COMMON.endsWith(END));
    for (const shim of SHIMS) assert.equal(block(shimText(shim)), COMMON, shim);
    const installer = join(REPO, 'scripts/install.sh');
    if (existsSync(installer) && block(readFileSync(installer, 'utf8')) !== null) {
      assert.equal(block(readFileSync(installer, 'utf8')), COMMON, 'scripts/install.sh');
    }
    const check = spawnSync('python3', [join(REPO, 'tests/node/generate_shims.py'), '--check'], { encoding: 'utf8' });
    if (!check.error) assert.equal(check.status, 0, check.stderr);
  });

  it('the shell quarantine list is startup_vars.mjs QUARANTINED (entry.mjs re-exports it)', async () => {
    const loop = COMMON.match(/for __LCU_NAME in ([\s\S]*?); do/)[1];
    assert.deepEqual(loop.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean), QUARANTINED);
    assert.deepEqual((await import('../../lcu/entry.mjs')).QUARANTINED, QUARANTINED);
    for (const name of ['OPENSSL_CONF', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_OPTIONS']) assert.ok(QUARANTINED.includes(name), name);
  });

  it('launchers: `#!/bin/sh -p`, noglob, a CLI selector, valid syntax, never a PATH lookup for node', () => {
    for (const [shim, cli] of [['lcu', 'lcu'], ['lcu-session', 'session'], ['lcu-codex-sandbox', 'sandbox']]) {
      const text = shimText(shim);
      assert.ok(text.startsWith('#!/bin/sh -p\n'), shim);
      assert.ok(text.includes('\nset -f\n'), shim);
      assert.ok(text.includes(`\n__LCU_CLI=${cli}\n`), shim);
      assert.equal(run('/bin/sh', ['-n', join(REPO, 'bin', shim)]).status, 0, shim);
      assert.ok(!/command -v|which node|env node/.test(text), shim);
    }
  });

  it('review #14: system tools only by absolute path (no PATH lookup anywhere in the common code)', () => {
    const code = COMMON.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    // Every external command is "$__LCU_T_*", /usr/bin/..., /bin/...; the rest are shell builtins.
    for (const tool of ['readlink', 'uname', 'find', 'ls', 'id', 'tr', 'cut', 'sed', 'grep', 'env ', 'codesign', 'iconv', 'bash']) {
      const bare = new RegExp(`(^|[;|&(\`]|\\$\\()\\s*${tool}\\b`, 'm');
      assert.ok(!bare.test(code), `bare ${tool}`);
    }
    // A launcher runs with an empty and a hostile PATH.
    const tmp = tempDir();
    try {
      const root = release(tmp.path, null);
      for (const PATH of ['/nonexistent', '']) {
        const result = run(join(root, 'bin/lcu'), ['--help'], { PATH });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${USAGE}${HELP_SUFFIX}\n`);
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('static help when Node is unusable', () => {
  let temporary;
  let root;
  beforeEach(() => {
    temporary = tempDir();
    root = release(temporary.path, null);
  });
  afterEach(() => temporary.cleanup());

  it('--help, -h and the registration-probe forms print runtime.mjs USAGE + HELP_SUFFIX', () => {
    for (const args of [['--help'], ['-h'], ['--chrome', '--help'], ['--audio', '--chrome', '-h'], ['--help', 'EXTRA']]) {
      const result = run(join(root, 'bin/lcu'), args);
      assert.equal(result.status, 0, args.join(' '));
      assert.equal(result.stdout, `${USAGE}${HELP_SUFFIX}\n`, args.join(' '));
      assert.equal(result.stderr, '');
    }
  });

  it('everything else names the missing Node, exit 1, empty stdout', () => {
    const node = join(root, 'agent-tools/node/bin/node');
    for (const [shim, prefix, args] of [['lcu', 'LCU: ', ['--version']], ['lcu', 'LCU: ', ['--chrome', '--help', 'EXTRA']],
      ['lcu', 'LCU: ', ['--audio', '--audio', '--help']], ['lcu', 'LCU: ', []], ['lcu-session', 'LCU session: ', ['--help']],
      ['lcu-codex-sandbox', 'LCU: ', ['sandbox']]]) {
      const result = run(join(root, 'bin', shim), args);
      assert.equal(result.status, 1, `${shim} ${args}`);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${prefix}Cannot run the ChatGPT app's bundled Node (${node}): it is missing. ` +
        'Repair the official app and rerun the LCU installer.\n');
    }
  });

  it('a non-executable Node is refused the same way', () => {
    const node = join(root, 'agent-tools/node/bin/node');
    writeFileSync(node, '#!/bin/sh\n');
    chmodSync(node, 0o644);
    const result = run(join(root, 'bin/lcu'), ['status']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: .*node is not an executable file\. Repair the official app/);
  });
});

describe('pre-Node gate', () => {
  let temporary;
  beforeEach(() => { temporary = tempDir(); });
  afterEach(() => temporary.cleanup());

  it('macOS: a Node that is not the selected app\'s is refused before it runs', {
    skip: process.platform !== 'darwin' ? 'macOS gate' : !existsSync('/Applications/ChatGPT.app') ? 'the ChatGPT app is not installed (the selected app must be a real bundle for this refusal)' : false,
  }, () => {
    const marker = join(temporary.path, 'ran');
    const fake = join(temporary.path, 'fake-node');
    writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(fake, 0o755);
    const root = release(temporary.path, fake, { app: '/Applications/ChatGPT.app' });
    const result = run(join(root, 'bin/lcu'), ['--version']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^LCU: Cannot run the ChatGPT app's bundled Node \(.*\): .*fake-node is not the bundled Node of the selected application /);
    assert.ok(!existsSync(marker), 'the foreign Node must not run');
  });

  // Round-2 review F1: the selected app is validated before any Node runs (task-created fixture bundles only).
  for (const [label, options, expected] of [
    ['an incomplete bundle linking to the real signed Node', { app: null, helper: null, node: APP_NODE },
      /Application bundle metadata is missing: .*fixture-apps\/ChatGPT\.app\/Contents\/Info\.plist/],
    ['a correctly identified bundle whose Node links to another app', { node: APP_NODE },
      /fixture-apps\/ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node resolves outside the application \(\/Applications\/ChatGPT\.app/],
    ['a bundle without Info.plist', { app: null }, /Application bundle metadata is missing: .*ChatGPT\.app\/Contents\/Info\.plist/],
    ['a bundle with another identifier', { app: 'com.example.other' }, /Unexpected application bundle identifier: .*fixture-apps\/ChatGPT\.app\. Repair/],
    ['a bundle whose Sky helper has another identifier', { helper: 'com.example.helper' },
      /Unexpected application bundle identifier: .*Codex Computer Use\.app/],
    ['a correctly identified bundle with an unsigned Node', {}, /its code signature does not verify as OpenAI's/],
  ]) {
    it(`F1 (macOS): ${label} is refused by the launcher and by scripts/install.sh before Node runs`, (t) => {
      if (process.platform !== 'darwin') return t.skip('macOS gate');
      if (options.node && !existsSync(APP_NODE)) return t.skip('the ChatGPT app is not installed');
      const marker = join(temporary.path, 'ran');
      const bundle = fixtureBundle(temporary.path, { ...options, marker });
      const root = release(temporary.path, join(bundle, 'Contents/Resources/cua_node/bin/node'), { app: bundle });
      const launched = run(join(root, 'bin/lcu'), ['--version']);
      assert.equal(launched.status, 1, launched.stderr);
      assert.equal(launched.stdout, '');
      assert.match(launched.stderr, expected);
      const installed = run('/bin/sh', ['-p', join(REPO, 'scripts/install.sh'), '--existing-app', bundle, '--runtime-only']);
      assert.equal(installed.status, 1, installed.stderr);
      assert.match(installed.stderr, expected);
      assert.ok(!existsSync(marker), 'no Node may run for an invalid selected app');
    });
  }

  // Containment, as lcu/platforms.py: links inside the app may point anywhere inside it; a link leaving it is refused.
  it('F1: an in-app link (cua_node/bin -> another directory inside the app) is accepted', (t) => {
    const marker = join(temporary.path, 'ran');
    let app;
    let binParent;
    if (process.platform === 'darwin') {
      app = fixtureBundle(temporary.path, { marker });
      binParent = join(app, 'Contents/Resources/cua_node');
    } else {
      app = join(temporary.path, 'chatgpt');
      binParent = join(app, 'resources/cua_node');
      mkdirSync(binParent, { recursive: true });
    }
    // Move the real bin directory elsewhere inside the app and link it back.
    const moved = join(app, process.platform === 'darwin' ? 'Contents/Resources/relocated-bin' : 'resources/relocated-bin');
    mkdirSync(moved, { recursive: true });
    const node = join(moved, 'node');
    rmSync(join(binParent, 'bin'), { recursive: true, force: true });
    writeFileSync(node, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(node, 0o755);
    symlinkSync('../relocated-bin', join(binParent, 'bin'));
    const root = release(temporary.path, join(binParent, 'bin/node'), { app });
    const result = run(join(root, 'bin/lcu'), ['--version']);
    if (process.platform === 'darwin') {
      // Accepted by the location checks; refused only later by codesign (the fixture Node is a script).
      assert.equal(result.status, 1);
      assert.match(result.stderr, /its code signature does not verify as OpenAI's/);
      assert.ok(!existsSync(marker));
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(marker), 'the in-app Node ran');
    }
  });

  it('F1: a link inside the app that leaves it is refused; one whose final target is back inside is judged by that target', (t) => {
    const marker = join(temporary.path, 'ran');
    const outside = join(temporary.path, 'outside');
    mkdirSync(outside);
    let app;
    let binParent;
    if (process.platform === 'darwin') {
      app = fixtureBundle(temporary.path, { marker });
      binParent = join(app, 'Contents/Resources/cua_node');
    } else {
      app = join(temporary.path, 'chatgpt');
      binParent = join(app, 'resources/cua_node');
      mkdirSync(join(binParent, 'bin'), { recursive: true });
      writeFileSync(join(binParent, 'bin/node'), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(binParent, 'bin/node'), 0o755);
    }
    // Case 1: bin -> a directory outside the app.
    cpSync(join(binParent, 'bin'), join(outside, 'bin'), { recursive: true });
    rmSync(join(binParent, 'bin'), { recursive: true, force: true });
    symlinkSync(join(outside, 'bin'), join(binParent, 'bin'));
    let root = release(temporary.path, join(binParent, 'bin/node'), { app, name: 'r1' });
    let result = run(join(root, 'bin/lcu'), ['--version']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resolves outside the application|links outside the application/);
    assert.ok(!existsSync(marker), 'no Node may run');
    // Case 2: bin -> <outside>/back -> the real directory inside the app. lcu/platforms.py resolves a link fully
    // (Path.resolve) and judges where it ends: inside, so accepted (the intermediate's ownership is still checked
    // by the gate's walk on Linux).
    unlinkSync(join(binParent, 'bin'));
    const inside = join(binParent, 'real-bin');
    cpSync(join(outside, 'bin'), inside, { recursive: true });
    symlinkSync(inside, join(outside, 'back'));
    symlinkSync(join(outside, 'back'), join(binParent, 'bin'));
    root = release(temporary.path, join(binParent, 'bin/node'), { app, name: 'r2' });
    result = run(join(root, 'bin/lcu'), ['--version']);
    if (process.platform === 'darwin') assert.match(result.stderr, /its code signature does not verify as OpenAI's/);
    else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(marker));
    }
  });

  it('F1 (macOS): a symlinked --existing-app is refused like resolve_installed_mac_app', (t) => {
    if (process.platform !== 'darwin' || !existsSync(APP_NODE)) return t.skip('needs the macOS app');
    const link = join(temporary.path, 'ChatGPT.app');
    symlinkSync('/Applications/ChatGPT.app', link);
    const installed = run('/bin/sh', ['-p', join(REPO, 'scripts/install.sh'), '--existing-app', link, '--runtime-only']);
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, new RegExp(`Expected a local ChatGPT\\.app directory: ${link}`));
  });

  it('Linux: a Node in a group/other-writable directory is refused before it runs', { skip: process.platform !== 'linux' }, () => {
    const shared = join(temporary.path, 'shared');
    mkdirSync(join(shared, 'chatgpt/resources/cua_node/bin'), { recursive: true });
    const marker = join(temporary.path, 'ran');
    const fake = join(shared, 'chatgpt/resources/cua_node/bin/node');
    writeFileSync(fake, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(fake, 0o755);
    chmodSync(shared, 0o777);
    const root = release(temporary.path, fake);
    let result = run(join(root, 'bin/lcu'), ['--version']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `LCU: Cannot run the ChatGPT app's bundled Node (${join(root, 'agent-tools/node/bin/node')}): ` +
      `${shared} is writable by group or other accounts. Repair the official app and rerun the LCU installer.\n`);
    assert.ok(!existsSync(marker));
    chmodSync(shared, 0o1777); // sticky: accepted, like platforms.py
    chmodSync(fake, 0o757);
    result = run(join(root, 'bin/lcu'), ['--version']);
    assert.match(result.stderr, /bin\/node is writable by group or other accounts/);
    chmodSync(fake, 0o755);
    result = run(join(root, 'bin/lcu'), ['--version']);
    assert.equal(result.status, 0);
    assert.ok(existsSync(marker));
  });

  it('installer review R1 (Linux): an intermediate link target in a writable directory is refused', { skip: process.platform !== 'linux' }, () => {
    // node -> <tmp>/hops/hop (hops is 0777, not sticky) -> trusted real binary
    const trusted = join(temporary.path, 'trusted');
    mkdirSync(trusted);
    const real = join(trusted, 'node');
    const marker = join(temporary.path, 'ran');
    writeFileSync(real, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(real, 0o755);
    const hops = join(temporary.path, 'hops');
    mkdirSync(hops);
    symlinkSync(real, join(hops, 'hop'));
    chmodSync(hops, 0o777);
    const root = release(temporary.path, join(hops, 'hop'));
    const result = run(join(root, 'bin/lcu'), ['--version']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${hops} is writable by group or other accounts`));
    assert.ok(!existsSync(marker));
  });
});

describe('launch (real or probe entry)', () => {
  let temporary;
  beforeEach(() => { temporary = tempDir(); });
  afterEach(() => temporary.cleanup());

  const probeRelease = (t) => {
    const node = trustedNode();
    if (!node) {
      t.skip('the ChatGPT app is not installed');
      return null;
    }
    return release(temporary.path, node, { entry: PROBE });
  };

  it('review #1: the gate-verified physical path is executed, never the release alias again', (t) => {
    const root = probeRelease(t);
    if (!root) return;
    const seen = JSON.parse(run(join(root, 'bin/lcu'), ['--version']).stdout);
    assert.equal(seen.execPath, realpathSync(join(root, 'agent-tools/node/bin/node')));
    assert.notEqual(seen.execPath, join(root, 'agent-tools/node/bin/node'));
  });

  it('review #4/#6/addendum B: children receive the caller environment byte for byte (whole environment)', (t) => {
    const root = probeRelease(t);
    if (!root) return;
    const link = join(temporary.path, 'lcu-link');
    symlinkSync(join(root, 'bin/lcu'), link);
    const caller = {
      PATH: '/usr/bin:/bin', HOME: '/nonexistent-home', NODE_OPTIONS: '--require /nonexistent/hijack.js',
      NODE_NO_WARNINGS: '', NODE_PATH: 'a b\nc', UV_THREADPOOL_SIZE: '3', OPENSSL_CONF: join(temporary.path, 'bad.cnf'),
      SSL_CERT_FILE: '/x', FOO: 'bar', NODE_REPL_X: 'kept', _lcu_cli: 'caller-cli', _lcu_node: 'caller-node',
      lcu_root: 'caller', CDPATH: '/', IFS: ':', SHELLOPTS: 'xtrace', BASH_ENV: '/nonexistent', ENV: '/nonexistent',
      PWD: realpathSync(temporary.path),
    };
    writeFileSync(caller.OPENSSL_CONF, 'this is not = a valid [ openssl config\n');
    const result = run(link, ['--chrome', '', 'two words'], caller, { cwd: temporary.path, env: caller });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'SHELLOPTS=xtrace / BASH_ENV / ENV must not affect the launcher (review #5)');
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.execArgv, ['--disable-warning=ExperimentalWarning']);
    assert.deepEqual(seen.argv, ['lcu', '--chrome', '', 'two words']);
    assert.equal(seen.restored.argv0, link);
    for (const [key, value] of Object.entries(caller)) {
      if (!SHELL_RESET.has(key)) assert.equal(seen.env[key], value, key);
    }
    assert.equal(seen.env.IFS, ' \t\n', 'documented residual: the shell resets IFS');
    const extra = Object.keys(seen.env).filter((key) => !(key in caller));
    assert.deepEqual(extra.filter((key) => !SHELL_ADDED.has(key)), [], 'only the shell\'s own documented additions');
    assert.ok(!extra.includes('PWD'), 'PWD given by the caller is kept as given');
    assert.deepEqual(seen.before.filter((k) => k.startsWith('__LCU_Q_')).sort(),
      ['NODE_NO_WARNINGS', 'NODE_OPTIONS', 'NODE_PATH', 'OPENSSL_CONF', 'SSL_CERT_FILE', 'UV_THREADPOOL_SIZE'].map((n) => `__LCU_Q_${n}`));
    assert.ok(!Object.keys(seen.env).some((key) => key.startsWith('__LCU_')));
  });

  it('round-2 F10: link targets ending in (or containing) LF are followed byte for byte', (t) => {
    const node = trustedNode();
    if (!node) return t.skip('the ChatGPT app is not installed');
    for (const hop of ['hop\n', 'a b\nc\n', 'plain hop']) {
      const dir = join(temporary.path, `case-${hop.length}`);
      mkdirSync(dir, { recursive: true });
      symlinkSync(node, join(dir, hop));
      const root = release(dir, join(dir, hop), { entry: PROBE, app: appOf(node) });
      const result = run(join(root, 'bin/lcu'), ['--version']);
      assert.equal(result.status, 0, `${JSON.stringify(hop)}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).execPath, realpathSync(node));
    }
  });

  it('review #3: CDPATH never changes which release is resolved (relative invocation)', (t) => {
    const root = probeRelease(t);
    if (!root) return;
    const decoy = join(temporary.path, 'decoy/bin');
    mkdirSync(decoy, { recursive: true });
    for (const CDPATH of ['.', join(temporary.path, 'decoy'), ':']) {
      const result = run('bin/lcu', ['--version'], { CDPATH }, { cwd: root });
      assert.equal(result.status, 0, `${CDPATH}: ${result.stderr}`);
      const seen = JSON.parse(result.stdout);
      assert.equal(seen.env.CDPATH, CDPATH);
      assert.equal(seen.restored.argv0, 'bin/lcu');
    }
  });

  it('the launchers also run under /bin/dash (darwin archive option; Debian/Ubuntu /bin/sh)', (t) => {
    if (!existsSync('/bin/dash')) return t.skip('no /bin/dash');
    const root = probeRelease(t);
    if (!root) return;
    const result = run('/bin/dash', [join(root, 'bin/lcu'), '--version'], { SHELLOPTS: 'xtrace' });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.argv, ['lcu', '--version']);
    assert.equal(seen.env.SHELLOPTS, 'xtrace');
    assert.ok(!('SHLVL' in seen.env) && !('_' in seen.env), 'dash adds neither SHLVL nor _');
  });

  it('review #6: a malformed OPENSSL_CONF does not stop LCU (it is restored for children)', (t) => {
    const node = trustedNode();
    if (!node) return t.skip('the ChatGPT app is not installed');
    const root = release(temporary.path, node);
    const conf = join(temporary.path, 'bad.cnf');
    writeFileSync(conf, '[ broken\nno equal sign here\n');
    const result = run(join(root, 'bin/lcu'), ['--version'], { OPENSSL_CONF: conf });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'lcu source-checkout (ChatGPT linux app not selected)\n');
  });

  it('review #7: signals the caller ignored are reported to Node and re-ignored for children', (t) => {
    const root = probeRelease(t);
    if (!root) return;
    // python3 starts the launcher with SIGINT and SIGHUP set to SIG_IGN (no signal is ever sent).
    const code = `import signal, subprocess, sys
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
sys.exit(subprocess.run([sys.argv[1], '--version']).returncode)`;
    const result = spawnSync('python3', ['-c', code, join(root, 'bin/lcu')], { encoding: 'utf8' });
    if (result.error) return t.skip('python3 is not available');
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen.restored.ignored.sort(), ['HUP', 'INT']);
    const plain = JSON.parse(run(join(root, 'bin/lcu'), ['--version']).stdout);
    assert.deepEqual(plain.restored.ignored, []);
  });

  it('review #7: reignore() hands the ignored disposition to the exec\'d program (pid kept)', (t) => {
    if (!existsSync('/bin/bash')) return t.skip('needs /bin/bash to report dispositions');
    const script = `
      const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
      sv.restore_environment({ __LCU_SIGIGN: 'INT' });
      const [file, argv] = sv.reignore('/bin/bash', ['/bin/bash', '-p', '-c', ${JSON.stringify(DISPOSITION_SCRIPT)}], { PATH: '/usr/bin:/bin' });
      process.stdout.write('node=' + process.pid + '\\n');
      process.execve(file, argv, { PATH: '/usr/bin:/bin' });`;
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /INT=1 TERM=0/, 'INT stays ignored, TERM keeps the default');
    const node = result.stdout.match(/node=(\d+)/)[1];
    assert.equal(result.stdout.match(/pid=(\d+)/)[1], node, 'the program replaces the Node process (same pid)');
    // No PWD is invented when the environment had none.
    const env = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      const sv = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
      sv.restore_environment({ __LCU_SIGIGN: 'HUP' });
      const [file, argv] = sv.reignore('/usr/bin/env', ['/usr/bin/env'], { A: '1' });
      process.execve(file, argv, { A: '1' });`], { encoding: 'utf8' });
    assert.deepEqual(env.stdout.trim().split('\n').filter((line) => !/^(SHLVL|_)=/.test(line)), ['A=1']);
  });

  it('review #11: argument or environment bytes that are not UTF-8 are refused, not replaced', (t) => {
    const node = trustedNode();
    if (!node) return t.skip('the ChatGPT app is not installed');
    const root = release(temporary.path, node);
    const code = `import os, subprocess, sys
env = {b'PATH': b'/usr/bin:/bin', b'RAW_VALUE': b'\\xff'}
r = subprocess.run([os.fsencode(sys.argv[1]), b'--version'], env=env, capture_output=True)
sys.stdout.write(str(r.returncode) + '\\n' + r.stderr.decode() + r.stdout.decode())`;
    const result = spawnSync('python3', ['-c', code, join(root, 'bin/lcu')], { encoding: 'utf8' });
    if (result.error) return t.skip('python3 is not available');
    const [status, ...rest] = result.stdout.split('\n');
    assert.equal(status, '1');
    assert.match(rest.join('\n'), process.platform === 'linux'
      ? /^LCU: The environment variable RAW_VALUE is not valid UTF-8; LCU cannot pass it on unchanged\./
      : /^LCU: An argument or environment variable is not valid UTF-8; LCU cannot pass it on unchanged\./);
  });
});

describe('round-2 F3: update paths name the shell explicitly, with -p', () => {
  it('old-release trampolines and the new updater command start install.sh with -p (no xtrace leak)', (t) => {
    if (!PYTHON) return t.skip('python3.12 is not available');
    const missing = join(REPO, 'no-such-app.app');
    const env = { SHELLOPTS: 'xtrace', NODE_OPTIONS: '--no-warnings', ENV: '/nonexistent', BASH_ENV: '/nonexistent' };
    const forms = [
      ['install.py trampoline', [PYTHON, '-B', join(REPO, 'scripts/install.py')]],
      ['install_macos.py trampoline', [PYTHON, '-B', join(REPO, 'scripts/install_macos.py')]],
      ['new updater (update_apply.installer_command)', ['/bin/sh', '-p', join(REPO, 'scripts/install.sh')]],
    ];
    for (const [label, command] of forms) {
      // An app that does not exist: install.sh answers itself (static refusal), with no Node involved.
      const result = run(command[0], [...command.slice(1), '--existing-app', missing, '--runtime-only'], env);
      assert.equal(result.status, 1, label);
      assert.ok(!result.stderr.includes('+ '), `${label}: shell trace leaked: ${result.stderr.slice(0, 200)}`);
      assert.ok(!result.stderr.includes('__LCU_Q'), label);
    }
    for (const file of ['scripts/install.py', 'scripts/install_macos.py']) {
      assert.match(readFileSync(join(REPO, file), 'utf8'), /os\.execv\('\/bin\/sh', \['\/bin\/sh', '-p', script, \*sys\.argv\[1:\]\]\)/);
    }
  });

  it('update_apply.installer_command passes -p', async () => {
    const apply = await import('../../lcu/update_apply.mjs');
    assert.deepEqual(apply.installer_command('linux', '/p', {}, '/s').slice(0, 3), ['/bin/sh', '-p', '/s/scripts/install.sh']);
  });
});

describe('startup_vars', () => {
  it('restore_environment restores only listed, known names and removes the whole __LCU_* channel', () => {
    const env = { __LCU_Q: 'NODE_OPTIONS,NODE_PATH,EVIL', __LCU_Q_NODE_OPTIONS: '--x', __LCU_Q_EVIL: 'y',
      __LCU_ARGV0: '/a/lcu', __LCU_Q_NODE_DEBUG: 'stale', __LCU_SIGIGN: 'INT,BOGUS', __LCU_SCRATCH: 'z', OTHER: '1' };
    assert.deepEqual(restore_environment(env), { argv0: '/a/lcu', ignored: ['INT'], invalid: false });
    assert.deepEqual(env, { OTHER: '1', NODE_OPTIONS: '--x' });
    restore_environment({});
  });

  it('quarantine_environment moves startup variables into the channel for an LCU-owned Node (review #2)', () => {
    const out = quarantine_environment({ NODE_OPTIONS: '--require x', OPENSSL_CONF: '', A: 'b' });
    assert.deepEqual(out, { A: 'b', __LCU_Q_NODE_OPTIONS: '--require x', __LCU_Q_OPENSSL_CONF: '', __LCU_Q: 'NODE_OPTIONS,OPENSSL_CONF' });
    const back = { ...out };
    restore_environment(back);
    assert.deepEqual(back, { A: 'b', NODE_OPTIONS: '--require x', OPENSSL_CONF: '' });
  });

  it('review #2: the macOS lifecycle host started through entry.mjs never runs a caller preload', () => {
    const tmp = tempDir();
    try {
      const marker = join(tmp.path, 'preloaded');
      const preload = join(tmp.path, 'preload.cjs');
      writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(43);`);
      const env = quarantine_environment({ PATH: '/usr/bin:/bin', NODE_OPTIONS: `--require ${preload}` });
      // `macos-host` with arguments serve_main ignores: entry restores, imports the host module, exits 0.
      const result = spawnSync(process.execPath, [join(REPO, 'lcu/entry.mjs'), 'macos-host', 'not-serve'], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!existsSync(marker), 'the preload must not run in LCU\'s own Node');
      // The same variable is still caller data for the host's children.
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { restore_environment } = await import(${JSON.stringify(join(REPO, 'lcu/startup_vars.mjs'))});
        restore_environment(); process.stdout.write(process.env.NODE_OPTIONS);`], { encoding: 'utf8', env });
      assert.equal(child.stdout, `--require ${preload}`);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('installer review R6: __lcu_python_path is str(Path(x).expanduser())', () => {
  const cases = ['', '.', './', 'a//b/./c/', '//x//y', '///x', '/a/../b', '~', '~/', './~', '~/x/', '~root/y', '~nosuchuser-lcu/x',
    'rel/~', 'a b/c', '~/.', '..//x'];
  const python = (homeMode) => `import os, sys
from pathlib import Path
${homeMode === 'unset' ? "os.environ.pop('HOME', None)" : homeMode === 'empty' ? "os.environ['HOME'] = ''" : "os.environ['HOME'] = '/home/fixture/'"}
for arg in sys.argv[1:]:
    try:
        print('OK', str(Path(arg).expanduser()))
    except RuntimeError as exc:
        print('ERR', exc)`;
  const shell = `. ${JSON.stringify(join(REPO, 'lcu/shim/common.sh'))}
__lcu_tools || exit 9
for arg in "$@"; do
  if __lcu_python_path "$arg"; then printf 'OK %s\\n' "$__LCU_PATH"; else printf 'ERR %s\\n' "$__LCU_REASON"; fi
done`;
  for (const mode of ['set', 'empty', 'unset']) {
    it(`HOME ${mode}`, (t) => {
      const env = { PATH: '/usr/bin:/bin', ...(mode === 'set' ? { HOME: '/home/fixture/' } : mode === 'empty' ? { HOME: '' } : {}) };
      if (!PYTHON) return t.skip('python3.12 is not available');
      const expected = spawnSync(PYTHON, ['-c', python(mode), ...cases], { encoding: 'utf8', env });
      const actual = spawnSync('/bin/sh', ['-p', '-c', shell, 'sh', ...cases], { encoding: 'utf8', env });
      assert.equal(actual.status, 0, actual.stderr);
      assert.deepEqual(actual.stdout.split('\n'), expected.stdout.split('\n'));
    });
  }
});

describe('round-3 N-1: links whose path contains LF inside the selected app', () => {
  const walk = (script) => spawnSync('/bin/sh', ['-p', '-c', `. ${JSON.stringify(join(REPO, 'lcu/shim/common.sh'))}\n__lcu_tools || exit 9\n${script}`],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });

  it('__lcu_walk records every link under ROOT, newlines included', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-lf-walk-')));
    try {
      mkdirSync(join(base, 'app/a\nb'), { recursive: true });
      writeFileSync(join(base, 'app/real'), '');
      symlinkSync('../real', join(base, 'app/a\nb/l\n'));
      symlinkSync('a\nb/l\n', join(base, 'app/top'));
      const result = walk(`__lcu_walk ${JSON.stringify(join(base, 'app/top'))} 0 ${JSON.stringify(join(base, 'app'))} || { printf 'FAIL %s' "$__LCU_REASON"; exit 1; }
printf '%s' "$__LCU_LN" ; printf '|'; printf '%s' "$__LCU_L1"; printf '|'; printf '%s' "$__LCU_L2"; printf '|%s' "$__LCU_REAL"`);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, `2|${join(base, 'app/top')}|${join(base, 'app/a\nb/l\n')}|${join(base, 'app/real')}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('the Linux gate accepts a Node reached through links with LF in their path (as Python does)', (t) => {
    if (process.platform !== 'linux') return t.skip('Linux gate');
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-lf-gate-')));
    try {
      const bin = join(base, 'app/resources/cua_node/bin');
      mkdirSync(join(bin, 'a\nb'), { recursive: true });
      cpSync(process.execPath, join(bin, 'nodereal'));
      chmodSync(join(bin, 'nodereal'), 0o755);
      symlinkSync('../nodereal', join(bin, 'a\nb/node'));
      symlinkSync('a\nb/node', join(bin, 'node'));
      const result = walk(`__lcu_gate ${JSON.stringify(join(bin, 'node'))} ${JSON.stringify(join(base, 'app'))} 0 || { printf 'FAIL %s' "$__LCU_REASON"; exit 1; }
printf '%s' "$__LCU_REAL"`);
      assert.equal(result.stdout, join(bin, 'nodereal'), result.stderr);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('lcu/shim/common.sh under `set -eu` (as scripts/install.sh sources it)', () => {
  it('tools, gate, quarantine, signals, byte check and path helper all succeed', (t) => {
    const node = trustedNode();
    if (!node) return t.skip('the ChatGPT app is not installed');
    const script = `set -eu
. ${JSON.stringify(join(REPO, 'lcu/shim/common.sh'))}
__lcu_tools
__lcu_gate ${JSON.stringify(node)}
__lcu_quarantine
__lcu_signals
__lcu_bytes_check a b
__lcu_python_path '~/x'
printf '%s|%s|%s|%s\\n' "$__LCU_REAL" "$__LCU_PATH" "\${__LCU_SIGIGN-none}" "\${__LCU_Q-none}"`;
    const result = spawnSync('/bin/sh', ['-p', '-c', script], { encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: '/h', NODE_OPTIONS: '--x' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${realpathSync(node)}|/h/x|none|NODE_OPTIONS\n`);
  });
});

describe('entry error mapping and exit statuses', () => {
  const entry = (cli, args, env = {}) => run(process.execPath, ['--disable-warning=ExperimentalWarning',
    join(REPO, 'lcu/entry.mjs'), cli, ...args], { __LCU_ARGV0: '/x/bin/lcu', ...env });

  it('SystemExit(n) gives the status CPython gives', (t) => {
    for (const code of [0, 1, 2, 3, 70, 255, 256, 300, -1, -9, -15, -130]) {
      const python = spawnSync('python3', ['-c', `import sys; sys.exit(${code})`]);
      if (python.error) return t.skip('python3 is not available');
      assert.equal(exit_status(code, () => {}), python.status, String(code));
    }
    let printed = '';
    assert.equal(exit_status('boom', (text) => { printed += text; }), 1);
    assert.equal(printed, 'boom\n');
    assert.equal(exit_status(null, () => {}), 0);
  });

  it('ValueError from runtime.main is "LCU: <message>", exit 1', () => {
    const result = entry('lcu', ['--with-browser-host']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'LCU: --with-browser-host was removed with the embedded browser. ' +
      'Run lcu browser install and enable the official Chrome extension.\n');
    assert.equal(result.stdout, '');
  });

  it('an unknown CLI selector is refused', () => {
    const result = entry('nope', []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /entry\.mjs lcu\|session\|sandbox\|macos-host/);
  });

  it('OSError text is Python\'s (missing installation.json in a release without one)', (t) => {
    const temporary = tempDir();
    try {
      const node = trustedNode();
      if (!node) return t.skip('the ChatGPT app is not installed');
      const root = release(temporary.path, node);
      const result = run(join(root, 'bin/lcu'), [], {}, { input: '' });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, `LCU: [Errno 2] No such file or directory: '${join(root, 'installation.json')}'\n`);
    } finally {
      temporary.cleanup();
    }
  });
});

// Greptile P1 (security): everything the pre-Node shell code runs must be a builtin or an absolute system path. A root
// installer or launcher inheriting a PATH with an untrusted directory must never run that directory's `cat`, `ls`...
describe('PATH hijack: the pre-Node shell code never looks a command up through PATH', () => {
  let temporary;
  let hijack;
  beforeEach(() => {
    temporary = tempDir();
    hijack = standIns(temporary.path);
  });
  afterEach(() => temporary.cleanup());

  const environments = (extra = {}) => hostileEnvironments(hijack.dir, extra);
  const launch = (file, args, env, options = {}) => spawnSync(file, args, { encoding: 'utf8', env, cwd: temporary.path, ...options });
  const noHits = (label) => assert.deepEqual(hijack.hits(), [], `${label}: a PATH stand-in ran`);

  it('the stand-ins themselves are found through PATH (the harness can see a hijack)', () => {
    const result = spawnSync('/bin/sh', ['-c', 'cat; ls'], { env: { PATH: hijack.dir }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(hijack.hits().length, 2);
  });

  it('--help, -h and the registration forms with a missing Node: static help, no stand-in runs', () => {
    const root = release(temporary.path, null);
    for (const env of environments()) {
      for (const args of [['--help'], ['-h'], ['--chrome', '--help'], ['--audio', '--chrome', '-h']]) {
        const result = launch(join(root, 'bin/lcu'), args, env);
        assert.equal(result.status, 0, `${env.PATH} ${args}: ${result.stderr}`);
        assert.equal(result.stdout, `${USAGE}${HELP_SUFFIX}\n`);
      }
      noHits(`missing Node, PATH=${env.PATH}`);
    }
  });

  it('every launcher with a missing, non-executable or refused Node: the diagnostic, no stand-in runs', () => {
    const missing = release(temporary.path, null, { name: 'missing' });
    const plain = release(temporary.path, null, { name: 'plain' });
    writeFileSync(join(plain, 'agent-tools/node/bin/node'), '#!/bin/sh\n');
    chmodSync(join(plain, 'agent-tools/node/bin/node'), 0o644);
    const writable = release(temporary.path, null, { name: 'writable' });
    writeFileSync(join(writable, 'agent-tools/node/bin/node'), '#!/bin/sh\n');
    chmodSync(join(writable, 'agent-tools/node/bin/node'), 0o755);
    chmodSync(join(writable, 'agent-tools/node'), 0o777);
    const loop = release(temporary.path, null, { name: 'loop' });
    symlinkSync(join(loop, 'agent-tools/node/bin/node'), join(loop, 'agent-tools/node/bin/node'));
    for (const env of environments()) {
      for (const root of [missing, plain, writable, loop]) {
        for (const shim of SHIMS) {
          for (const args of [[], ['--version'], ['--help'], ['sandbox']]) {
            const result = launch(join(root, 'bin', shim), args, env);
            assert.ok([0, 1].includes(result.status), `${shim} ${args}: ${result.stderr}`);
            if (result.status === 1) assert.match(result.stderr, /Cannot run the ChatGPT app's bundled Node|cannot be read|too many levels/);
          }
        }
      }
      noHits(`refused Node, PATH=${env.PATH}`);
    }
    // Invoked through a symlink and by a bare relative name (the self-location code).
    const link = join(temporary.path, 'lcu-link');
    symlinkSync(join(missing, 'bin/lcu'), link);
    for (const env of environments()) {
      assert.equal(launch(link, ['--help'], env).status, 0);
      assert.equal(launch('bin/lcu', ['--version'], env, { cwd: missing }).status, 1);
    }
    noHits('symlinked and relative invocation');
  });

  it('a normal launch (real Node, probe entry) runs no stand-in, and the children keep the caller PATH', (t) => {
    const node = trustedNode();
    if (!node) return t.skip('the ChatGPT app is not installed');
    const root = release(temporary.path, node, { entry: PROBE });
    for (const env of environments({ NODE_OPTIONS: '--no-warnings', CDPATH: '/' })) {
      for (const shim of SHIMS) {
        const result = launch(join(root, 'bin', shim), ['--version'], env);
        assert.equal(result.status, 0, `${shim} PATH=${env.PATH}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).env.PATH, env.PATH, 'the caller PATH is passed on untouched');
      }
      noHits(`normal launch, PATH=${env.PATH}`);
    }
  });

  it('the Chrome relay launcher template (browser.mjs) runs no stand-in', async () => {
    const { _relay_launcher } = await import('../../lcu/browser.mjs');
    const lcu = join(temporary.path, 'stable lcu');
    const relay = join(temporary.path, 'lcu-native-host');
    writeFileSync(relay, _relay_launcher(lcu, temporary.path, 'Linux'));
    chmodSync(relay, 0o700);
    for (const env of environments()) {
      const refused = launch(relay, ['chrome-extension://x/'], env);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /is missing; reinstall LCU/);
      assert.equal(refused.stdout, '');
    }
    writeFileSync(lcu, '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(lcu, 0o755);
    for (const env of environments()) {
      const ok = launch(relay, ['origin'], env);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(ok.stdout, `browser|__native-host|${temporary.path}|origin|`);
    }
    noHits('relay launcher');
  });

  it('adapters/claude-plugin/scripts/ensure-lcu.sh: every early exit runs no stand-in', () => {
    const hook = join(REPO, 'adapters/claude-plugin/scripts/ensure-lcu.sh');
    assert.equal(run('/bin/sh', ['-n', hook]).status, 0);
    const home = join(temporary.path, 'home');
    mkdirSync(home);
    mkdirSync(join(temporary.path, 'app-without-node'));
    const cases = [
      { LCU_APP: join(temporary.path, 'no-app') }, // never the default app: that would reach the network
      { CLAUDE_CONFIG_DIR: '/somewhere', LCU_APP: join(temporary.path, 'no-app') },
      { LCU_APP: join(temporary.path, 'app-without-node') },
    ];
    let n = 0;
    for (const extra of cases) {
      for (const env of environments({ HOME: home, ...extra })) {
        n += 1;
        const state = join(temporary.path, `state-${n}`);
        const full = { ...env, CLAUDE_PLUGIN_DATA: state, TMPDIR: temporary.path };
        const result = launch('/bin/sh', [hook], full);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^\{"systemMessage": "LCU plugin: /);
        // A stale lock (older than the hook's timeout) is taken over with find/rmdir/mkdir.
        mkdirSync(join(state, 'lock'), { recursive: true });
        utimesSync(join(state, 'lock'), new Date(0), new Date(0));
        assert.equal(launch('/bin/sh', [hook], full).status, 0);
      }
    }
    noHits('plugin hook');
  });

  it('the Python trampolines hand over to an absolute /bin/sh and read no PATH', () => {
    for (const name of ['install.py', 'install_macos.py']) {
      const text = readFileSync(join(REPO, 'scripts', name), 'utf8');
      assert.match(text, /os\.execv\('\/bin\/sh', \['\/bin\/sh', '-p', script, \*sys\.argv\[1:\]\]\)/, name);
      assert.ok(!/subprocess|os\.system|os\.exec[lv]p|shutil\.which|os\.environ/.test(text), name);
    }
  });

  it('the Windows launcher templates only use cmd builtins or absolute paths', async () => {
    const { command_file_text } = await import('../../scripts/install_windows.mjs');
    const text = command_file_text({ prefix: 'C:\\p', generation: 'C:\\p\\apps\\g', node: 'C:\\p\\apps\\g\\app\\n.exe', sha256: 'a'.repeat(64) });
    // Programs started by the template: the private node.exe by absolute (%LCU_NODE%) path, certutil under %SystemRoot%.
    assert.match(text, /^"%LCU_NODE%" /m);
    assert.match(text, /"%SystemRoot%\\System32\\certutil\.exe"/);
    const bare = text.split('\r\n').filter((line) => /(^|[(&|] *)(certutil|powershell|pwsh|where|findstr|find|sort|more|type|node|python)(\.exe)?\b/i
      .test(line.replace(/%SystemRoot%\\System32\\certutil\.exe/i, '')));
    assert.deepEqual(bare, [], 'no bare command name is looked up through PATH');
    assert.match(readFileSync(join(REPO, 'bin/lcu.cmd'), 'utf8'), /^call "%~dp0\.\.\\\.\.\\\.\.\\lcu\.cmd" %\*$/m);
  });
});
