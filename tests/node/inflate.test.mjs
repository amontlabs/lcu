// compat/inflate.mjs: the documented-API fallback is selected when the undocumented zlib handle is absent, and it is
// bounded. (Differential corpora against CPython: tests/compat/test_inflate_fallback.py.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

const INFLATE = new URL('../../lcu/compat/inflate.mjs', import.meta.url).href;

function child(code) {
  const done = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

describe('inflate fallback', () => {
  it('is selected when the zlib handle interface is absent, and stays bounded', () => {
    const result = child(`
      import zlib from 'node:zlib';
      const Original = zlib.InflateRaw;
      zlib.InflateRaw = class extends Original { constructor(o) { super(o); this._handle = undefined; } };
      const { usesFallback, inflateBounded, inflateStats } = await import(${JSON.stringify(INFLATE)});
      const bomb = zlib.deflateRawSync(Buffer.alloc(32 << 20), { level: 9 });
      const bounded = inflateBounded(bomb, 1 + 1 + 2048);
      process.stdout.write(JSON.stringify({ fallback: usesFallback(), status: bounded.status, out: bounded.out.length,
        peak: inflateStats.peak }));
    `);
    assert.equal(result.fallback, true);
    assert.equal(result.status, 'limit');
    assert.ok(result.out >= 2 && result.out <= 2050, `output ${result.out}`);
    assert.ok(result.peak <= 2050, `peak ${result.peak}`);
  });

  it('uses the handle path when it exists', () => {
    const result = child(`
      const { usesFallback } = await import(${JSON.stringify(INFLATE)});
      process.stdout.write(JSON.stringify({ fallback: usesFallback() }));
    `);
    assert.equal(result.fallback, false);
  });

  it('classifies success, truncation, data errors and the limit like the handle path', async () => {
    const { inflateBounded, ZlibError } = await import(INFLATE);
    const data = Buffer.from('hello world '.repeat(500));
    const raw = zlib.deflateRawSync(data);
    const whole = inflateBounded(Buffer.concat([raw, Buffer.from('trailing')]), 1 << 20);
    assert.equal(whole.status, 'end');
    assert.equal(whole.consumed, raw.length);
    assert.deepEqual(whole.out, data);

    const cut = inflateBounded(raw.subarray(0, raw.length - 4), 1 << 20);
    assert.equal(cut.status, 'truncated');
    assert.ok(data.subarray(0, cut.out.length).equals(cut.out));

    const bad = inflateBounded(Buffer.alloc(40, 0xff), 1 << 20);
    assert.equal(bad.status, 'error');
    assert.ok(bad.error instanceof ZlibError);
    assert.match(bad.error.message, /^Error -3 while decompressing data: /);

    const limited = inflateBounded(raw, 1000);
    assert.equal(limited.status, 'limit');
    assert.ok(limited.out.length <= 1000 && limited.out.length > 1000 - 1032);
  });
});
