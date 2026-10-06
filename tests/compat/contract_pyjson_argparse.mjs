// Caller-boundary contract of lcu/compat/pyjson.mjs and argparse.mjs (review findings 7-12). Run by
// test_compat_contract.py; exits non-zero with the assertion message on failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as j from '../../lcu/compat/pyjson.mjs';
import * as a from '../../lcu/compat/argparse.mjs';

a.io.stderr = () => {};
a.io.exit = (status) => { throw new a.PySystemExit(status); };

// 7. int type: the same JS type (Number) for every safe integer, whatever its provenance.
{
  const p = new a.ArgumentParser({ prog: 'lcu prune' });
  p.add_argument('--keep', { type: a.types.int, default: 2 });
  for (const argv of [[], ['--keep=2'], ['--keep', '٣'], ['--keep', '-5'], ['--keep', '9007199254740991']]) {
    const keep = p.parse_args(argv).keep;
    assert.equal(typeof keep, 'number', JSON.stringify(argv));
    assert.equal(Math.max(keep, 1) - 1, Math.max(keep - 1, 0));
  }
  assert.equal(p.parse_args(['--keep=2']).keep === p.parse_args([]).keep, true);
  // beyond the safe range: BigInt, exact
  assert.equal(p.parse_args(['--keep=9007199254740993']).keep, 9007199254740993n);
  assert.equal(typeof p.parse_args(['--keep=-9007199254740992']).keep, 'bigint');
  assert.equal(a.types.int('9007199254740991'), 9007199254740991);
  assert.equal(a.types.int('-0'), 0);
  assert.ok(!Object.is(a.types.int('-0'), -0));
  // JSON ints behave the same way, so timestamp arithmetic never mixes BigInt and Number for normal values.
  const doc = j.loads('{"checked_at": 1700000000, "f": 1.5, "big": 9007199254740993, "neg0": -0}');
  assert.equal(typeof doc.get('checked_at'), 'number');
  assert.equal(100 - doc.get('checked_at'), -1699999900);
  assert.equal(100 - doc.get('f'), 98.5); // PyFloat coerces through valueOf
  assert.equal(doc.get('big'), 9007199254740993n);
  assert.equal(doc.get('neg0'), 0);
  assert.ok(j.isInt(doc.get('checked_at')) && j.isInt(doc.get('big')) && !j.isInt(doc.get('f')));
  assert.equal(j.normInt(5n), 5);
  assert.equal(j.normInt(2n ** 60n), 2n ** 60n);
  assert.equal(j.dumps(j.pyfloat(3)), '3.0');
  assert.equal(j.dumps(3), '3');
  assert.equal(j.dumps(new Map([['n', 5n], ['m', 5]])), '{"n": 5, "m": 5}');
}

// 8/9. toPlain refuses silent damage; the Map from loads() round-trips byte for byte.
{
  const text = '{"10": 1, "2": 2, "name": "original", "checked_at": 1.0, "n": 1}';
  const doc = j.loads(text);
  assert.throws(() => j.toPlain(doc), /reorder/);
  doc.set('enabled', true);
  assert.equal(j.dumps(doc, { indent: 1 }),
    '{\n "10": 1,\n "2": 2,\n "name": "original",\n "checked_at": 1.0,\n "n": 1,\n "enabled": true\n}');
  assert.deepEqual([...doc.keys()], ['10', '2', 'name', 'checked_at', 'n', 'enabled']);
  const plain = j.toPlain(j.loads('{"checked_at": 1.0, "n": 1, "x": 1.5, "name": "a"}'));
  assert.equal(j.dumps(plain), '{"checked_at": 1.0, "n": 1, "x": 1.5, "name": "a"}');
  assert.equal(j.dumps(j.toPlain(j.loads('{"c": 1.0}'), { floats: 'number' })), '{"c": 1}');
  assert.equal(j.dumps(j.toPlain(j.loads('{"2": 1, "10": 2}'))), '{"2": 1, "10": 2}'); // order unchanged -> allowed
  assert.equal(j.dumps(j.toPlain(j.loads('{"10": 1, "2": 2}'), { allowReorder: true })), '{"2": 2, "10": 1}');
  const copy = j.deepcopy(j.loads('{"a": [1, {"b": NaN}]}'));
  assert.ok(j.equal(copy, j.loads('{"a": [1, {"b": NaN}]}')));
}

// 10. Namespace: attribute access works and shares storage with the Map methods.
{
  const p = new a.ArgumentParser();
  p.add_argument('--yes', { action: 'store_true' });
  p.add_argument('--keep', { type: a.types.int, default: 2 });
  p.add_argument('--get');
  const args = p.parse_args(['--yes', '--get', 'v']);
  assert.equal(args.yes, true);
  assert.equal(args.keep, 2);
  assert.equal(args.get('get'), 'v'); // methods win over a dest named `get`
  assert.equal(args.has('yes'), true);
  assert.ok('yes' in args && !('nope' in args));
  args.keep = 5;
  assert.equal(args.get('keep'), 5);
  args.set('keep', 6);
  assert.equal(args.keep, 6);
  assert.deepEqual(Object.keys(args), ['yes', 'keep', 'get']);
  delete args.keep;
  assert.equal(args.has('keep'), false);
  assert.equal(args.keep, undefined);
  assert.equal(j.dumps(args.vars()), '{"yes": true, "get": "v"}');
  assert.throws(() => j.dumps(args), /not JSON serializable/);
  assert.equal(new a.Namespace({ x: 1 }).x, 1);
}

// 11. dump(value, fp, opts) writes to a stream or fd and never mistakes the stream for options.
{
  let written = '';
  assert.equal(j.dump({ a: 1 }, { write: (t) => { written += t; } }, { indent: 2 }), undefined);
  assert.equal(written, '{\n  "a": 1\n}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  const file = path.join(dir, 'x.json');
  const fd = fs.openSync(file, 'w');
  j.dump(new Map([['k', [1, 2n, j.pyfloat(2)]]]), fd);
  fs.closeSync(fd);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"k": [1, 2, 2.0]}');
  fs.rmSync(dir, { recursive: true });
  assert.throws(() => j.dump({ a: 1 }), /no attribute 'write'/);
  assert.throws(() => j.dump({ a: 1 }, { indent: 2 }), /no attribute 'write'/);
  assert.throws(() => j.dump({ a: 1 }, 'text'), /no attribute 'write'/);
}

// 12. Bytes decoding stays linear in time and memory (bounds are generous; the old per-byte path took ~150 ms and
// ~100 MiB more for 8 MiB, this runs in a few tens of ms). Output and errors are checked by the differential suite.
{
  const n = 8 << 20;
  const ascii = Buffer.from(`"${'x'.repeat(n)}"`);
  const mixed = Buffer.from(`["${'é'.repeat(n / 8)}", "${'x'.repeat(n / 2)}", "\\ud83d\\ude00"]`);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`"${'x'.repeat(n / 2)}"`, 'utf16le')]);
  const before = process.memoryUsage().rss;
  for (const payload of [ascii, mixed, utf16]) {
    const start = performance.now();
    const value = j.loads(payload);
    const ms = performance.now() - start;
    assert.ok(ms < 1500, `loads of ${payload.length} bytes took ${ms} ms`);
    assert.ok(value.length > 0);
  }
  const grown = (process.memoryUsage().rss - before) / 1048576;
  assert.ok(grown < 400, `rss grew by ${grown} MiB`);
}
console.log('ok');
