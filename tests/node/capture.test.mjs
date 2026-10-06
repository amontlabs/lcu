// lcu/capture.mjs. Port of tests/test_browser_setup.py::test_large_diagnostic_output_survives_node_exit (the only
// case that targets capture.run directly; the others patch it) plus the subprocess.run semantics it keeps.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { run } from '../../lcu/capture.mjs';
import { tempDir } from './runtime_support.mjs';

describe('capture.run', () => {
  let temporary;
  beforeEach(() => { temporary = tempDir(); });
  afterEach(() => temporary.cleanup());

  it('test_large_diagnostic_output_survives_node_exit', () => {
    const script = join(temporary.path, 'big.js');
    writeFileSync(script, "console.log(JSON.stringify({installed:true,enabled:true,pad:'x'.repeat(200000)}));process.exit(0);");
    const result = run([process.execPath, script], { timeout: 20 });
    assert.ok(result.stdout.length > 65536);
    assert.equal(JSON.parse(result.stdout).enabled, true);
  });

  it('returns args, returncode, stdout and stderr as text; stdin is /dev/null', () => {
    const result = run(['/bin/sh', '-c', 'cat; printf out; printf err >&2; exit 3'], { cwd: temporary.path });
    assert.deepEqual(result, { args: ['/bin/sh', '-c', 'cat; printf out; printf err >&2; exit 3'], returncode: 3,
      stdout: 'out', stderr: 'err' });
  });

  it('invalid UTF-8 is replaced, env and cwd are passed', () => {
    const result = run(['/bin/sh', '-c', 'printf "\\377%s" "$X"; pwd'], { env: { X: 'v', PATH: '/usr/bin:/bin' }, cwd: '/' });
    assert.equal(result.stdout, '�v/\n');
  });

  it('a timeout kills the child and raises TimeoutExpired with Python text', () => {
    assert.throws(() => run(['/bin/sleep', '5'], { timeout: 0.2 }),
      (error) => error.name === 'TimeoutExpired' && error.message === "Command '['/bin/sleep', '5']' timed out after 0.2 seconds");
  });

  it('a missing program is FileNotFoundError text', () => {
    assert.throws(() => run(['/nonexistent/tool']),
      (error) => error.message === "[Errno 2] No such file or directory: '/nonexistent/tool'");
  });

  it('review #9: a cwd that cannot be entered is reported against the cwd, as Python does', () => {
    const blocked = join(temporary.path, 'blocked');
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    const file = join(temporary.path, 'not-directory');
    writeFileSync(file, 'x');
    const loop = join(temporary.path, 'loop');
    symlinkSync(loop, loop);
    const cases = [[join(temporary.path, 'missing'), 2, 'No such file or directory'], [file, 20, 'Not a directory'],
      [loop, process.platform === 'darwin' ? 62 : 40, 'Too many levels of symbolic links']];
    if (process.getuid() !== 0) cases.push([blocked, 13, 'Permission denied']);
    try {
      for (const [cwd, errno, text] of cases) {
        assert.throws(() => run(['/bin/sh', '-c', 'exit 0'], { cwd }),
          (error) => error.message === `[Errno ${errno}] ${text}: '${cwd}'`, cwd);
      }
    } finally {
      chmodSync(blocked, 0o755);
    }
  });

  it('review #10: timeout=0 is an expired deadline (the child is killed), not "no timeout"', () => {
    const started = Date.now();
    assert.throws(() => run(['/bin/sleep', '2'], { timeout: 0 }), (error) => error.name === 'TimeoutExpired' &&
      error.message === "Command '['/bin/sleep', '2']' timed out after 0.0 seconds");
    assert.ok(Date.now() - started < 1500, 'the child must not run to completion');
  });
});
