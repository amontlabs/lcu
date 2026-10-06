// One PyOSError / ValueError hierarchy for the whole tree (compat consolidation, 2026-10-05) and the pathlib/pypath
// merge. The oracle for message texts is CPython 3.12 when a python3.12 is available.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import * as errors from '../../lcu/compat/errors.mjs';
import * as pathlib from '../../lcu/compat/pathlib.mjs';
import * as pyerr from '../../lcu/compat/pyerr.mjs';
import * as pyjson from '../../lcu/compat/pyjson.mjs';
import * as pypath from '../../lcu/compat/pypath.mjs';
import * as subprocess from '../../lcu/compat/subprocess.mjs';
import { InvalidFileException } from '../../lcu/compat/plist.mjs';
import { TOMLDecodeError } from '../../lcu/compat/toml.mjs';
import * as http from '../../lcu/compat/http.mjs';
import * as setup from '../../lcu/setup.mjs';
import { python312 } from './runtime_support.mjs';

const PYTHON = python312();

describe('one PyOSError', () => {
  it('errors.PyOSError is pyerr.PyOSError, and both constructor forms build the same text', () => {
    assert.equal(errors.PyOSError, pyerr.PyOSError);
    const byName = new errors.PyOSError('ENOENT', '/x', '/y');
    assert.ok(byName instanceof pyerr.PyOSError);
    assert.equal(byName.name, 'FileNotFoundError');
    assert.equal(byName.message, "[Errno 2] No such file or directory: '/x' -> '/y'");
    assert.equal(String(byName), byName.message);
    const unknown = new errors.PyOSError('EWHATEVER');
    assert.equal(unknown.name, 'OSError');
    assert.equal(unknown.message, 'EWHATEVER');
    const fields = new pyerr.PyOSError({ strerror: 'timed out', className: 'TimeoutError' });
    assert.equal(fields.message, 'timed out');
    for (const error of [byName, unknown, fields]) assert.equal(error.isOSError, true);
  });

  it('one isOSError classifier everywhere (instances, names, raw Node system errors; not ERR_* or other families)', () => {
    assert.equal(subprocess.isOSError, pyerr.isOSError);
    assert.equal(errors.isOSError, pyerr.isOSError);
    assert.equal(setup.isOSError, pyerr.isOSError);
    const raw = Object.assign(new Error('x'), { code: 'ENOENT', errno: -2 });
    const named = Object.assign(new Error('x'), { name: 'FileNotFoundError' });
    class ConnectionResetError extends Error {}
    for (const yes of [new errors.PyOSError('EPIPE'), raw, named, new ConnectionResetError('r'), { isOSError: true }]) {
      assert.equal(pyerr.isOSError(yes), true, String(yes));
    }
    const api = Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_VALUE' });
    for (const no of [api, new pyjson.ValueError('v'), new Error('plain'), null, undefined, 'ENOENT', 3]) {
      assert.equal(pyerr.isOSError(no), false, String(no));
    }
  });

  it('fromNodeError: undefined filename means Node\'s own path; null means none; toPyOSError never invents one', () => {
    const node = Object.assign(new Error('boom'), { code: 'ENOENT', errno: -2, path: '/node/path', dest: '/node/dest' });
    assert.equal(pyerr.fromNodeError(node).message, "[Errno 2] No such file or directory: '/node/path' -> '/node/dest'");
    assert.equal(pyerr.fromNodeError(node, { filename: null, filename2: null }).message, '[Errno 2] No such file or directory');
    assert.equal(errors.toPyOSError(node).message, '[Errno 2] No such file or directory');
    assert.equal(errors.toPyOSError(node, '/py/name').message, "[Errno 2] No such file or directory: '/py/name'");
    assert.throws(() => errors.pyfs(undefined, () => fs.readFileSync('/nonexistent/lcu-file')),
      (error) => error.message === '[Errno 2] No such file or directory' && error instanceof pyerr.PyOSError);
    assert.throws(() => errors.pyfs('/nonexistent/lcu-file', () => fs.readFileSync('/nonexistent/lcu-file')),
      (error) => error.message === "[Errno 2] No such file or directory: '/nonexistent/lcu-file'");
  });
});

describe('one ValueError', () => {
  it('every ValueError family member is an instance of pyjson.ValueError and carries isValueError', () => {
    const family = [new pyjson.ValueError('v'), new pyjson.JSONDecodeError('m', 'doc', 0),
      new pyjson.UnicodeDecodeError('utf-8', 0, 1, 'invalid start byte', Buffer.from([0xff])),
      new pyjson.UnicodeEncodeError('\ud800'), new TOMLDecodeError('t', '', 0), new InvalidFileException('p'),
      new http.UnicodeEncodeError('rendered'), new http.PyValueError('h'), new errors.ValueError('e'),
      new pathlib.PyValueError('p')];
    for (const error of family) {
      assert.ok(error instanceof pyjson.ValueError, error.name);
      assert.equal(error.isValueError, true, error.name);
      assert.equal(errors.isValueError(error), true, error.name);
      assert.equal(setup.isValueError(error), true, error.name);
    }
    for (const other of [new Error('x'), new TypeError('x'), new pyerr.PyOSError('ENOENT', 'f'), null, 'text']) {
      assert.equal(errors.isValueError(other), false, String(other));
    }
    assert.equal(new http.UnicodeEncodeError('rendered').message, 'rendered');
  });

  it('assigning isValueError on a subclass (TOMLDecodeError does) is allowed', () => {
    const error = new pyjson.ValueError('x');
    error.isValueError = true;
    assert.equal(error.isValueError, true);
  });
});

describe('UnicodeEncodeError reports surrogate runs like CPython', { skip: !PYTHON && 'needs python3.12' }, () => {
  const cases = [[0xd800], [0x41, 0xd800], [0xdc00, 0xdc01, 0xdc02], [0x41, 0xd800, 0x42, 0xdfff, 0xdfff],
    [0x1f600, 0x61, 0xdfff, 0xd801, 0x62, 0xd802], [0xdfff, 0x1f600, 0xd800]];
  const python = (list) => spawnSync(PYTHON, ['-c', `
import json, sys
for points in json.loads(sys.argv[1]):
    text = ''.join(chr(p) for p in points)
    try:
        text.encode('utf-8')
    except UnicodeEncodeError as exc:
        print(type(exc).__name__ + ': ' + str(exc))
`, JSON.stringify(list)], { encoding: 'utf8' }).stdout.trim().split('\n');

  it('constructor(text) and pyjson.dump to an fd', () => {
    const expected = python(cases);
    const texts = cases.map((points) => String.fromCodePoint(...points));
    assert.deepEqual(texts.map((text) => `${new pyjson.UnicodeEncodeError(text).name}: ${new pyjson.UnicodeEncodeError(text).message}`),
      expected);
    // json.dump(s, strict_utf8_file, ensure_ascii=False) writes the quoted string as one chunk: positions shift by 1.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-ue-'));
    try {
      const fd = fs.openSync(path.join(directory, 'out'), 'w');
      for (const [index, text] of texts.entries()) {
        const quoted = python([[0x22, ...cases[index], 0x22]])[0];
        assert.throws(() => pyjson.dump(text, fd, { ensure_ascii: false }),
          (error) => `${error.name}: ${error.message}` === quoted, text);
      }
      fs.closeSync(fd);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('pathlib.realpath / resolve (pypath delegates)', () => {
  it('pypath re-exports the pathlib primitives and realpath is the same function result', () => {
    assert.equal(pypath.fsPath, pathlib.fsPath);
    assert.equal(pypath.isabs, pathlib.isAbs);
    assert.equal(pypath.split, pathlib.split);
    assert.equal(pypath.realpath('/usr/../tmp/./x'), pathlib.realpath('/usr/../tmp/./x'));
  });

  it('a NUL byte is CPython\'s ValueError from the lstat of the component, in realpath and resolve', () => {
    for (const call of [() => pathlib.realpath('/tmp/a\0b'), () => pathlib.resolve('/tmp/a\0b'), () => pypath.realpath('/tmp/a\0b'),
      () => pathlib.realpath('/tmp/a\0b', { strict: true })]) {
      assert.throws(call, (error) => error instanceof pyjson.ValueError && error.message === 'lstat: embedded null character in path');
    }
    if (PYTHON) {
      // CPython 3.12.10's text (older 3.12.x print 'embedded null byte'; the oracle for LCU is 3.12.10)
      const python = spawnSync(PYTHON, ['-c', 'import os, sys\nif sys.version_info >= (3, 12, 10):\n try:\n  os.path.realpath("/tmp/a\\0b")\n except ValueError as e:\n  print(e)'], { encoding: 'utf8' });
      if (python.stdout.trim()) assert.equal(python.stdout.trim(), 'lstat: embedded null character in path');
    }
  });

  it('names that are not UTF-8 are looked up as raw bytes (surrogateescape)', { skip: process.platform !== 'linux' && 'needs a file system that accepts raw names' }, () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-raw-')));
    try {
      const target = path.join(directory, 'target');
      fs.mkdirSync(target);
      const link = Buffer.concat([Buffer.from(`${directory}/`), Buffer.from([0x6c, 0xff])]);
      fs.symlinkSync(target, link);
      const name = `${directory}/l\udcff`; // os.fsdecode of the raw name
      assert.equal(pathlib.realpath(name), target);
      assert.equal(pypath.realpath(name), target);
      assert.equal(pathlib.resolve(name), target);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
