// OSError text on Windows (lcu/compat/pyerr.mjs, pyerr_win32.mjs): CPython prints `[WinError N] <message>: 'path'` for the
// calls that go through the Win32 API and `[Errno N] <strerror>: 'path'` for C-runtime calls (open()).  The unit cases run
// everywhere (Node error objects as libuv makes them on Windows); the differential cases run on a Windows host only and compare
// with the live CPython 3.12.10 (LCU_TEST_PYTHON) failing the same calls in a scratch directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fromNodeError, spawnErrorText } from '../../lcu/compat/pyerr.mjs';
import { win32 as table } from '../../lcu/compat/pyerr_win32.mjs';
import { python312 } from './runtime_support.mjs';

const nodeError = (code, syscall, path, dest) => Object.assign(new Error(`${code}: ${syscall}`), { code, syscall, path, dest, errno: -1 });
const show = (error, options = {}) => {
  const converted = fromNodeError(error, { platform: 'win32', ...options });
  return [converted.name, converted.errno, converted.winerror, converted.message];
};
const present = () => true;
const absent = () => false;

describe('Windows OSError text (unit)', () => {
  it('Win32 API calls print [WinError N] with the FormatMessage text and the mapped errno class', () => {
    assert.deepEqual(show(nodeError('ENOENT', 'stat', 'C:\\t\\x'), { parentExists: present }),
      ['FileNotFoundError', 2, 2, "[WinError 2] The system cannot find the file specified: 'C:\\\\t\\\\x'"]);
    assert.deepEqual(show(nodeError('ENOENT', 'stat', 'C:\\none\\x'), { parentExists: absent }),
      ['FileNotFoundError', 2, 3, "[WinError 3] The system cannot find the path specified: 'C:\\\\none\\\\x'"]);
    assert.deepEqual(show(nodeError('ENOENT', 'scandir', 'C:\\t\\d'), { parentExists: present }),
      ['FileNotFoundError', 2, 3, "[WinError 3] The system cannot find the path specified: 'C:\\\\t\\\\d'"]);
    assert.deepEqual(show(nodeError('EEXIST', 'mkdir', 'C:\\t')),
      ['FileExistsError', 17, 183, "[WinError 183] Cannot create a file when that file already exists: 'C:\\\\t'"]);
    assert.deepEqual(show(nodeError('ENOTEMPTY', 'rmdir', 'C:\\t')),
      ['OSError', 41, 145, "[WinError 145] The directory is not empty: 'C:\\\\t'"]);
    assert.deepEqual(show(nodeError('EPERM', 'unlink', 'C:\\t')),
      ['PermissionError', 13, 5, "[WinError 5] Access is denied: 'C:\\\\t'"]);
    assert.deepEqual(show(nodeError('EBUSY', 'rename', 'C:\\a', 'C:\\b'), { parentExists: present }),
      ['PermissionError', 13, 32, "[WinError 32] The process cannot access the file because it is being used by another process: 'C:\\\\a' -> 'C:\\\\b'"]);
    assert.deepEqual(show(nodeError('ENOENT', 'spawn C:\\x.exe', 'C:\\x.exe')),
      ['FileNotFoundError', 2, 2, "[WinError 2] The system cannot find the file specified: 'C:\\\\x.exe'"]);
  });

  it('C-runtime calls (open, read, write) keep [Errno N] with the Microsoft strerror text', () => {
    assert.deepEqual(show(nodeError('ENOENT', 'open', 'C:\\t\\f')),
      ['FileNotFoundError', 2, null, "[Errno 2] No such file or directory: 'C:\\\\t\\\\f'"]);
    assert.deepEqual(show(nodeError('EEXIST', 'open', 'C:\\t\\f')),
      ['FileExistsError', 17, null, "[Errno 17] File exists: 'C:\\\\t\\\\f'"]);
    assert.deepEqual(show(nodeError('EISDIR', 'read', 'C:\\t')),
      ['PermissionError', 13, null, "[Errno 13] Permission denied: 'C:\\\\t'"]);
    assert.deepEqual(show(nodeError('EPIPE', 'write')), ['BrokenPipeError', 32, null, '[Errno 32] Broken pipe']);
  });

  it('a spawn with an unusable cwd is NotADirectoryError [WinError 267]', () => {
    assert.equal(spawnErrorText(nodeError('ENOENT', 'spawn x', 'x'), { cwd: 'C:\\no\\such\\dir', platform: 'win32' }),
      "[WinError 267] The directory name is invalid: 'C:\\\\no\\\\such\\\\dir'");
  });

  it('the CRT table is complete for the names LCU uses', () => {
    for (const name of ['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'EPIPE', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENOTEMPTY', 'EAGAIN', 'EINTR']) {
      assert.equal(typeof table.errno[name], 'number', name);
    }
  });
});

const PYTHON = process.platform === 'win32' ? python312() : null;
const python = (code) => {
  const done = spawnSync(PYTHON, ['-X', 'utf8', '-c', code], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
};
const skipDifferential = process.platform !== 'win32' ? 'compares with CPython on Windows (CRT and Win32 error wording); runs on the Windows runner'
  : (!PYTHON && 'needs CPython 3.12.10 (LCU_TEST_PYTHON)');

describe('Windows OSError text against CPython 3.12.10', { skip: skipDifferential }, () => {
  const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'lcu-pyerr-')));
  mkdirSync(join(scratch, 'full'));
  writeFileSync(join(scratch, 'full', 'file'), 'x');
  mkdirSync(join(scratch, 'empty'));
  writeFileSync(join(scratch, 'file'), 'x');
  const S = (...parts) => join(scratch, ...parts);

  // [label, Node call, Python statement(s) raising the same failure; `p(...)` joins onto the scratch directory]
  const cases = [
    ['stat of a missing file', () => statSync(S('missing')), "os.stat(p('missing'))"],
    ['stat below a missing directory', () => statSync(S('nodir', 'x')), "os.stat(p('nodir', 'x'))"],
    ['listdir of a missing directory', () => readdirSync(S('nodir')), "os.listdir(p('nodir'))"],
    ['mkdir over an existing directory', () => mkdirSync(S('empty')), "os.mkdir(p('empty'))"],
    ['mkdir below a missing directory', () => mkdirSync(S('nodir', 'sub')), "os.mkdir(p('nodir', 'sub'))"],
    ['rmdir of a non-empty directory', () => rmdirSync(S('full')), "os.rmdir(p('full'))"],
    ['rmdir of a missing directory', () => rmdirSync(S('missing')), "os.rmdir(p('missing'))"],
    ['unlink of a missing file', () => unlinkSync(S('missing')), "os.unlink(p('missing'))"],
    ['unlink of a directory', () => unlinkSync(S('empty')), "os.unlink(p('empty'))"],
    ['rename of a missing file', () => renameSync(S('missing'), S('other')), "os.rename(p('missing'), p('other'))"],
    ['open of a missing file', () => openSync(S('missing'), 'r'), "open(p('missing'))"],
    ['open of an existing file with O_EXCL', () => closeSync(openSync(S('file'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)),
      "os.open(p('file'), os.O_CREAT | os.O_EXCL | os.O_RDWR)"],
    ['read of a directory as a file', () => readFileSync(S('empty')), "open(p('empty')).read()"],
  ];

  it('every failing call renders like CPython', () => {
    const script = `
import json, os
base = ${JSON.stringify(scratch)}
p = lambda *parts: os.path.join(base, *parts)
out = []
for statement in json.loads(${JSON.stringify(JSON.stringify(cases.map((c) => c[2])))}):
    try:
        exec(statement)
        out.append(None)
    except OSError as exc:
        out.append([type(exc).__name__, exc.errno, getattr(exc, 'winerror', None), str(exc)])
print(json.dumps(out))`;
    const expected = python(script);
    const got = cases.map(([, call]) => {
      try { call(); return null; } catch (error) { return show(error); }
    });
    for (const [index, [label]] of cases.entries()) assert.deepEqual(got[index], expected[index], label);
  });

  it('a spawn of a missing program and of a program in a missing directory render like CPython', () => {
    const missing = S('nope.exe');
    const script = `
import json, subprocess
out = []
for kwargs in ({'args': [${JSON.stringify(missing)}]}, {'args': ['cmd.exe', '/c', 'exit 0'], 'cwd': ${JSON.stringify(S('nodir'))}}):
    try:
        subprocess.run(**kwargs)
        out.append(None)
    except OSError as exc:
        out.append([type(exc).__name__, exc.errno, getattr(exc, 'winerror', None), str(exc)])
print(json.dumps(out))`;
    const expected = python(script);
    const run = (file, args, cwd) => {
      const done = spawnSync(file, args, { cwd, stdio: 'ignore' });
      const rendered = fromNodeError(done.error, { platform: 'win32', filename: file });
      return rendered && [rendered.name, rendered.errno, rendered.winerror, rendered.message];
    };
    assert.deepEqual(run(missing, []), expected[0]);
    const cwd = S('nodir');
    const text = spawnErrorText(spawnSync('cmd.exe', ['/c', 'exit 0'], { cwd, stdio: 'ignore' }).error, { cwd, platform: 'win32' });
    assert.equal(text, expected[1][3]);
  });

  it('errno numbers and os.strerror() of the CRT table match the interpreter', () => {
    const names = Object.keys(table.errno);
    const expected = python(`
import errno, json, os
names = json.loads(${JSON.stringify(JSON.stringify(names))})
print(json.dumps({n: [getattr(errno, n, None), os.strerror(getattr(errno, n))] if hasattr(errno, n) else None for n in names}))`);
    for (const name of names) {
      assert.deepEqual(expected[name], [table.errno[name], table.strerror[table.errno[name]]], name);
    }
  });

  it('cleanup', () => { rmSync(scratch, { recursive: true, force: true }); });
});
