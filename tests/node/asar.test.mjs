// lcu/asar.mjs. There is no tests/test_asar.py: the Python module is exercised through the Linux version read in
// test_installation (`_write_asar`) and test_windows_host (`_asar`); those fixtures are reproduced here, plus
// the bounds/validation branches, whose messages are compared with lcu/asar.py run by python3 when available.
import { python312 } from './runtime_support.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { list_asar_members, read_asar_members } from '../../lcu/asar.mjs';
import { rejectsWith, tempDir, writeAsar } from './runtime_support.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

function rawAsar(path, headerText, payload = Buffer.alloc(0), overrides = {}) {
  const header = Buffer.from(headerText);
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(overrides.size_payload ?? 4, 0);
  preamble.writeUInt32LE(overrides.header_size ?? 8 + header.length, 4);
  preamble.writeUInt32LE(overrides.header_payload ?? 4 + header.length, 8);
  preamble.writeUInt32LE(overrides.json_size ?? header.length, 12);
  writeFileSync(path, Buffer.concat([preamble, header, payload]));
}

// What lcu/asar.py does with the same file: ['ok', ...] or ['error', 'ValueError', message].
function python(archive, names) {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu.asar import list_asar_members, read_asar_members
try:
    if ${names === null ? 'True' : 'False'}:
        print(json.dumps(['ok', list(list_asar_members(sys.argv[1]))]))
    else:
        print(json.dumps(['ok', {k: v.decode('latin-1') for k, v in read_asar_members(sys.argv[1], json.loads(sys.argv[2])).items()}]))
except Exception as exc:
    print(json.dumps(['error', type(exc).__name__, str(exc)]))
`;
  const oracle = python312();
  if (!oracle) return null;
  const result = spawnSync(oracle, ['-c', code, archive, JSON.stringify(names ?? [])], { encoding: 'utf8' });
  if (result.error) return null;
  return JSON.parse(result.stdout);
}

function node(archive, names) {
  try {
    if (names === null) return ['ok', list_asar_members(archive)];
    const out = read_asar_members(archive, names);
    return ['ok', Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toString('latin1')]))];
  } catch (exc) {
    return ['error', exc.name, exc.message];
  }
}

describe('asar', () => {
  let temporary;
  let archive;
  beforeEach(() => {
    temporary = tempDir();
    archive = join(temporary.path, 'app.asar');
  });
  afterEach(() => temporary.cleanup());

  it('reads a member written like test_installation._write_asar', () => {
    writeAsar(archive, { 'package.json': JSON.stringify({ name: 'chatgpt', version: '26.924.22138' }),
      '.vite/build/main.js': 'main', 'node_modules/tslib/tslib.js': 'tslib' });
    const members = read_asar_members(archive, ['package.json', '.vite/build/main.js']);
    assert.equal(JSON.parse(members['package.json'].toString()).version, '26.924.22138');
    assert.equal(members['.vite/build/main.js'].toString(), 'main');
    assert.deepEqual(list_asar_members(archive), ['.vite/build/main.js', 'node_modules/tslib/tslib.js', 'package.json']);
  });

  it('a missing member, an invalid name and a truncated header are ValueErrors', async () => {
    writeAsar(archive, { 'package.json': '{}' });
    await rejectsWith(assert, () => read_asar_members(archive, ['nope.json']), 'ValueError', /^ASAR member is missing: nope.json$/);
    await rejectsWith(assert, () => read_asar_members(archive, ['../x']), 'ValueError', /^Invalid ASAR member path: '..\/x'$/);
    await rejectsWith(assert, () => read_asar_members(archive, ['/abs']), 'ValueError', /^Invalid ASAR member path: '\/abs'$/);
    writeFileSync(archive, Buffer.alloc(8));
    await rejectsWith(assert, () => read_asar_members(archive, ['x']), 'ValueError', /^ASAR header is truncated\.$/);
  });

  it('a missing archive is an OSError with Python text', () => {
    assert.throws(() => list_asar_members(join(temporary.path, 'none.asar')),
      (error) => /^(\[Errno 2\] No such file or directory|\[WinError 2\] The system cannot find the file specified): '.*none\.asar'$/.test(error.message)); // stat() first: WinError on Windows
  });

  it('matches lcu/asar.py on valid and invalid archives (differential)', (t) => {
    const cases = [
      ['valid', () => writeAsar(archive, { 'a/b.txt': 'bee', 'c.txt': 'see', 'é.txt': 'e' }), null],
      ['valid read', () => writeAsar(archive, { 'a/b.txt': 'bee', 'c.txt': 'see' }), ['a/b.txt', 'a/./b.txt', 'a//b.txt', 'c.txt']],
      ['string offset with spaces', () => rawAsar(archive, '{"files":{"x":{"offset":" 0 ","size":2}}}', Buffer.from('hi')), ['x']],
      ['bad string offset', () => rawAsar(archive, '{"files":{"x":{"offset":"z","size":2}}}', Buffer.from('hi')), ['x']],
      ['float size', () => rawAsar(archive, '{"files":{"x":{"offset":"0","size":2.0}}}', Buffer.from('hi')), ['x']],
      ['bool size', () => rawAsar(archive, '{"files":{"x":{"offset":"0","size":true}}}', Buffer.from('hi')), ['x']],
      ['out of bounds', () => rawAsar(archive, '{"files":{"x":{"offset":"0","size":3}}}', Buffer.from('hi')), ['x']],
      ['unpacked', () => rawAsar(archive, '{"files":{"x":{"offset":"0","size":2,"unpacked":true}}}', Buffer.from('hi')), ['x']],
      ['unpacked false', () => rawAsar(archive, '{"files":{"x":{"offset":"0","size":2,"unpacked":0}}}', Buffer.from('hi')), ['x']],
      ['link', () => rawAsar(archive, '{"files":{"x":{"link":"y"}}}'), ['x']],
      ['directory read', () => rawAsar(archive, '{"files":{"d":{"files":{}}}}'), ['d']],
      ['non-dict entry', () => rawAsar(archive, '{"files":{"x":1}}'), ['x']],
      ['through non-dict', () => rawAsar(archive, '{"files":{"x":"s"}}'), ['x/y']],
      ['dot name', () => rawAsar(archive, '{"files":{}}'), ['.']],
      ['invalid json', () => rawAsar(archive, '{"files":'), ['x']],
      ['no tree', () => rawAsar(archive, '{"nofiles":{}}'), ['x']],
      ['list tree bad name', () => rawAsar(archive, '{"files":{"a/b":{"size":1}}}'), null],
      ['bad preamble', () => rawAsar(archive, '{"files":{}}', Buffer.alloc(0), { size_payload: 5 }), null],
      ['json larger than payload', () => rawAsar(archive, '{"files":{}}', Buffer.alloc(0), { json_size: 400 }), null],
      ['bad utf8', () => rawAsar(archive, '{"files":{"\xff":{}}}'.replace('\xff', 'ÿ'), Buffer.alloc(0)), null],
    ];
    let compared = 0;
    for (const [name, make, names] of cases) {
      make();
      const expected = python(archive, names);
      if (expected === null) {
        t.skip('python3 is not available');
        return;
      }
      assert.deepEqual(node(archive, names), expected, name);
      compared += 1;
    }
    assert.equal(compared, cases.length);
  });
});
