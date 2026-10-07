// Port of the lcu.session cases of tests/test_installation.py (discover) plus main()'s argument and account checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { discover } from '../../lcu/session.mjs';
import { preflight } from '../../lcu/compat/execve.mjs';
import { rejectsWith, tempDir } from './runtime_support.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { describe, it } = skippedOnWindows('lcu-session picks a Linux/macOS desktop session (/proc, getuid, XFCE); never runs on Windows');

const REPO = fileURLToPath(new URL('../..', import.meta.url));

describe('session.discover', () => {
  let temporary;
  let root;
  beforeEach(() => {
    temporary = tempDir();
    root = temporary.path;
  });
  afterEach(() => temporary.cleanup());

  const session = (pid, display = ':1') => {
    const process_ = join(root, String(pid));
    mkdirSync(process_);
    writeFileSync(join(process_, 'comm'), 'xfce4-session\n');
    writeFileSync(join(process_, 'environ'),
      `DISPLAY=${display}\0DBUS_SESSION_BUS_ADDRESS=unix:path=/run/test\0TOKEN=never-copy\0`);
  };

  it('test_discovery_copies_only_gui_environment', () => {
    session(123);
    assert.deepEqual(discover(root), { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test' });
  });

  it('test_ambiguous_desktop_is_rejected', async () => {
    session(123);
    session(124, ':2');
    await rejectsWith(assert, () => discover(root), 'ValueError', /found 2/);
  });

  it('identical sessions count once (Python set of tuples)', () => {
    session(123);
    session(124);
    assert.deepEqual(discover(root), { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test' });
  });

  it('test_another_users_desktop_is_rejected', async () => {
    session(123);
    await rejectsWith(assert, () => discover(root, process.getuid?.() + 1), 'ValueError',
      new RegExp(`^Expected one XFCE desktop for UID ${process.getuid?.() + 1}; found 0\\. Start a desktop, or use --session direct with an explicit GUI environment\\.$`));
  });

  it('non-numeric entries, other programs, vanished and undecodable entries are skipped', () => {
    session(123);
    mkdirSync(join(root, 'self'));
    mkdirSync(join(root, '200'));
    writeFileSync(join(root, '200/comm'), 'bash\n');
    mkdirSync(join(root, '201'));
    writeFileSync(join(root, '201/comm'), 'xfce4-session\n');
    writeFileSync(join(root, '201/environ'), Buffer.from([0x44, 0xff, 0]));
    mkdirSync(join(root, '202')); // no comm: FileNotFoundError
    assert.deepEqual(discover(root), { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test' });
  });
});

describe('session.main through the entry module', () => {
  const run = (args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    join(REPO, 'lcu/entry.mjs'), 'session', ...args], { encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', __LCU_ARGV0: '/x/bin/lcu-session' } });

  it('--user is required (argparse error, exit 2, prog lcu-session)', () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'usage: lcu-session [-h] --user USER ...\nlcu-session: error: the following arguments are required: --user\n');
  });

  it('an unknown account is a ValueError mapped to "LCU session:"', () => {
    const result = run(['--user', 'no-such-account-lcu-test', '--', 'true']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'LCU session: Unknown account: no-such-account-lcu-test\n');
  });

  it('another account is refused', () => {
    if (process.getuid?.() === 0) return;
    const result = run(['--user', 'root', '--', 'true']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'LCU session: Run the launcher as the selected desktop account.\n');
  });

  it('a missing command is a parser error', () => {
    const result = run(['--user', userInfo().username, '--']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /lcu-session: error: Provide a command after --\n$/);
  });
});

describe('exec preflight (session/runtime exec seam)', () => {
  it('review #8: a valid UTF-8 shebang interpreter path is executable (compat/execve request 7)', () => {
    const tmp = tempDir();
    try {
      const shell = join(tmp.path, 'café-shell');
      symlinkSync('/bin/sh', shell);
      const script = join(tmp.path, 'unicode-shebang');
      writeFileSync(script, `#!${shell}\necho UNICODE_OK\n`);
      chmodSync(script, 0o755);
      const predicted = preflight(script, [script], {});
      assert.equal(predicted, null);
    } finally {
      tmp.cleanup();
    }
  });
});
