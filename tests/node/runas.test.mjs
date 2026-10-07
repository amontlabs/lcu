// lcu/compat/runas.mjs: synchronous subprocess.run, optionally as another account (root only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findpwuid } from '../../lcu/compat/accounts.mjs';
import { runProcess } from '../../lcu/compat/runas.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { test } = skippedOnWindows('become-another-account (setuid, supplementary groups, /bin/sh); never runs on Windows');

test('capture, check and the Python error texts', () => {
  assert.deepEqual(runProcess(['/bin/sh', '-c', 'echo out; echo err >&2'], { capture: true }),
    { args: ['/bin/sh', '-c', 'echo out; echo err >&2'], returncode: 0, stdout: 'out\n', stderr: 'err\n' });
  assert.throws(() => runProcess(['/bin/sh', '-c', 'exit 3'], { check: true }),
    { name: 'CalledProcessError', message: "Command '['/bin/sh', '-c', 'exit 3']' returned non-zero exit status 3." });
  assert.equal(runProcess(['/bin/sh', '-c', 'exit 3']).returncode, 3);
  assert.throws(() => runProcess(['/bin/sleep', '5'], { timeout: 200 }),
    { name: 'TimeoutExpired', message: "Command '['/bin/sleep', '5']' timed out after 0.2 seconds" });
  assert.throws(() => runProcess(['/bin/sleep', '5'], { timeout: 200, stdout: 'devnull' }), { name: 'TimeoutExpired' });
  assert.throws(() => runProcess(['/nonexistent/tool']), { message: "[Errno 2] No such file or directory: '/nonexistent/tool'" });
  assert.throws(() => runProcess(['/nonexistent/tool'], { stdout: 'devnull' }), { message: "[Errno 2] No such file or directory: '/nonexistent/tool'" });
  assert.equal(runProcess(['/bin/sh', '-c', 'echo hidden'], { stdout: 'devnull' }).returncode, 0);
  assert.equal(runProcess(['/bin/sh', '-c', 'printf %s "$X"; pwd'], { capture: true, env: { X: 'y' }, cwd: '/' }).stdout, 'y/\n');
});

test('as root, drops to the account with its supplementary groups, env and cwd', { skip: process.getuid?.() !== 0 && 'root only' }, () => {
  const account = findpwuid(1000);
  assert.ok(account, 'fixture account uid 1000');
  const result = runProcess(['/bin/sh', '-c', 'id -u; id -g; id -G; pwd; printf %s "$HOME"'],
    { capture: true, account, cwd: '/tmp', env: { HOME: account.pw_dir, PATH: '/usr/bin:/bin' } });
  const [uid, gid, groups, cwd, home] = result.stdout.split('\n');
  assert.equal(uid, '1000');
  assert.equal(gid, String(account.pw_gid));
  assert.ok(!groups.split(' ').includes('0'), `root's groups were dropped: ${groups}`);
  assert.equal(cwd, '/tmp');
  assert.equal(home, account.pw_dir);
  assert.throws(() => runProcess(['/nonexistent/tool'], { account }), { message: "[Errno 2] No such file or directory: '/nonexistent/tool'" });
  assert.throws(() => runProcess(['/bin/sh', '-c', 'exit 4'], { account, check: true, stdout: 'devnull' }),
    { name: 'CalledProcessError', message: "Command '['/bin/sh', '-c', 'exit 4']' returned non-zero exit status 4." });
});

// Review R8: the same Python subprocess contracts on every branch (plain, DEVNULL, as another account).
function fixtures() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-runas-')));
  fs.chmodSync(base, 0o755);
  const write = (name, text) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o755);
    return file;
  };
  return {
    base,
    noShebang: write('no-shebang', 'echo NO_SHEBANG_TEXT_EXECUTED\n'),
    newlines: write('newlines', "#!/bin/sh\nprintf 'one\\r\\ntwo\\rthree\\n'\n"),
    invalid: write('invalid', "#!/bin/sh\nprintf '\\377'\n"),
  };
}

const cases = (account) => {
  const { base, noShebang, newlines, invalid } = fixtures();
  try {
    const extra = account ? { account, cwd: '/tmp' } : {};
    for (const options of [{ capture: true }, { stdout: 'devnull' }, {}]) {
      assert.throws(() => runProcess([noShebang], { ...options, ...extra }),
        { message: `[Errno 8] Exec format error: '${noShebang}'` });
    }
    assert.equal(runProcess([newlines], { capture: true, ...extra }).stdout, 'one\ntwo\nthree\n');
    assert.throws(() => runProcess([invalid], { capture: true, ...extra }), { name: 'UnicodeDecodeError' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
};

test('exec format, universal newlines and strict decoding as Python (no account)', () => cases(null));
test('exec format, universal newlines and strict decoding as Python (as another account)',
  { skip: process.getuid?.() !== 0 && 'root only' }, () => cases(findpwuid(1000)));
