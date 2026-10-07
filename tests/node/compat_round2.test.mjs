// Round-2 compat review regressions (.port/reviews/round2-compat.md): R01 account rows fail closed, and the other
// findings below as they are fixed. Oracles are CPython 3.12.10 (python312()) where a differential makes sense.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';

import * as accounts from '../../lcu/compat/accounts.mjs';
import * as acl from '../../lcu/compat/acl.mjs';
import { CURL_MISSING_MESSAGE, curl, fetchBytes, fetchToFile } from '../../lcu/compat/http.mjs';
import * as inflate from '../../lcu/compat/inflate.mjs';
import { rmtree } from '../../lcu/compat/shutil.mjs';
import * as systool from '../../lcu/compat/systool.mjs';
import { TarArchive } from '../../lcu/compat/tar.mjs';
import { extractLcuZip } from '../../lcu/compat/zip.mjs';
import { skipOnWindows } from './windows_skip.mjs';

function fakeTool(body) {
  const dir = mkdtempSync(join(tmpdir(), 'lcu-r2-'));
  const path = join(dir, 'tool');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

describe('R01 malformed account rows fail closed', () => {
  const linux = process.platform !== 'darwin';
  const cases = linux
    ? {
        'bad gid in passwd': "case \"$1\" in passwd) printf '%s\\n' 'root:x:0:0:root:/root:/bin/sh' 'r2unsafe:x:123456:garbage:Unsafe:/tmp:/bin/sh';; group) echo 'r2writers:x:7777:';; esac",
        'short passwd row': "case \"$1\" in passwd) printf '%s\\n' 'root:x:0:0:root:/root:/bin/sh' 'short:x:5';; group) echo 'g:x:0:';; esac",
        'extra field': "case \"$1\" in passwd) printf '%s\\n' 'root:x:0:0:root:/root:/bin/sh:extra';; group) echo 'g:x:0:';; esac",
        'oversized uid': "case \"$1\" in passwd) printf '%s\\n' 'root:x:0:0:root:/root:/bin/sh' 'big:x:99999999999:5:::/bin/sh';; group) echo 'g:x:0:';; esac",
        'bad group row': "case \"$1\" in passwd) echo 'root:x:0:0:root:/root:/bin/sh';; group) printf '%s\\n' 'g:x:0:' 'broken:x:abc:root';; esac",
        'empty member': "case \"$1\" in passwd) echo 'root:x:0:0:root:/root:/bin/sh';; group) echo 'g:x:0:a,,b';; esac",
      }
    : {
        'record without uid': "printf 'name: root\\nuid: 0\\ngid: 0\\n\\nname: bad\\ngid: 7777\\n\\n'",
        'non-numeric gid': "printf 'name: root\\nuid: 0\\ngid: 0\\n\\nname: bad\\nuid: 5\\ngid: x\\n\\n'",
      };
  for (const [label, body] of Object.entries(cases)) {
    it(label, () => {
      const tool = fakeTool(body);
      try {
        systool._testing.override(linux ? 'getent' : 'dscacheutil', tool.path);
        const throwsLookup = (fn) => assert.throws(fn, (e) => e.name === 'AccountLookupError');
        throwsLookup(() => accounts.groupMembers(7777));
        throwsLookup(() => (label.includes('group') || label.includes('member') ? accounts.getgrall() : accounts.getpwall()));
        throwsLookup(() => acl.untrustedEntry('/unused', { uid: 0, gid: 7777, mode: 0o100660 }, new Set([0]), accounts.groupMembers, new Map()));
      } finally {
        systool._testing.reset?.();
        tool.cleanup();
      }
    });
  }

  it('well-formed answers still parse', { skip: process.platform === 'darwin' || skipOnWindows('getent and the shell-script fake tool are POSIX; Windows has no account database lookups') }, () => {
    const tool = fakeTool(`case "$1" in
  passwd) if [ "$3" = u ]; then echo 'u:x:5:7777:U:/home/u:/bin/sh'; elif [ -n "$3" ]; then exit 2; else printf '%s\\n' 'root:x:0:0:root:/root:/bin/sh' 'u:x:5:7777:U:/home/u:/bin/sh'; fi;;
  group) if [ "$3" = 7777 ]; then echo 'w:x:7777:u,root'; elif [ -n "$3" ]; then exit 2; else printf '%s\\n' 'g:x:0:' 'w:x:7777:u,root'; fi;;
esac`);
    try {
      systool._testing.override('getent', tool.path);
      assert.deepEqual([...accounts.groupMembers(7777)].sort(), [5]);
    } finally {
      systool._testing.reset?.();
      tool.cleanup();
    }
  });
});

// ------------------------------------------------------------------------------------------------ R05 / R06 (inflate fallback)
function tarBlock(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header[156] = 0x30;
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function zipOf(name, content, { crcOf = content } = {}) {
  const compressed = zlib.deflateRawSync(content);
  const crc = zlib.crc32(crcOf);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, Buffer.from(name), compressed]);
  const directory = Buffer.concat([central, Buffer.from(name)]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

describe('R05 the zip fallback never turns its output limit into a successful end of member', () => {
  it('a member whose declared bytes cannot be supplied is rejected, on the fallback as on the primary path', () => {
    const content = Buffer.alloc(65536, 0x78);
    const bounded = inflate.inflateBounded(zlib.deflateRawSync(content), 8192);
    assert.equal(bounded.status, 'limit');
    // central and local CRC are those of the recovered prefix, the declared size stays 65536 (the review's forgery)
    const archive = zipOf('f', content, { crcOf: bounded.out });
    const directory = mkdtempSync(join(tmpdir(), 'lcu-r5-'));
    const file = join(directory, 'a.zip');
    writeFileSync(file, archive);
    const previous = { ...inflate.inflateConfig };
    try {
      for (const forceFallback of [false, true]) {
        Object.assign(inflate.inflateConfig, { forceFallback, maxOutput: 8192 });
        const target = join(directory, `out-${forceFallback}`);
        assert.throws(() => extractLcuZip(file, target), (error) => /Bad CRC-32|exceeds the LCU decompression limit/.test(error.message),
          `forceFallback=${forceFallback}`);
      }
    } finally {
      Object.assign(inflate.inflateConfig, previous);
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('an honest member under the limit still extracts', () => {
    const content = Buffer.alloc(5000, 0x41);
    const directory = mkdtempSync(join(tmpdir(), 'lcu-r5-'));
    const file = join(directory, 'a.zip');
    writeFileSync(file, zipOf('f', content));
    const previous = { ...inflate.inflateConfig };
    try {
      Object.assign(inflate.inflateConfig, { forceFallback: true, maxOutput: 8192 });
      extractLcuZip(file, join(directory, 'out'));
      assert.equal(readFileSync(join(directory, 'out', 'f')).length, 5000);
    } finally {
      Object.assign(inflate.inflateConfig, previous);
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

describe('R06 the gzip fallback does not read the compressed tail', () => {
  it('largest source read stays near the primary path\'s with 32 MiB of padding behind the stream', () => {
    const tar = Buffer.concat([tarBlock('f', Buffer.from('hello')), Buffer.alloc(1024)]);
    const file = Buffer.concat([zlib.gzipSync(tar), Buffer.alloc(32 * 1024 * 1024)]);
    const largest = {};
    const previous = { ...inflate.inflateConfig };
    try {
      for (const forceFallback of [false, true]) {
        Object.assign(inflate.inflateConfig, { forceFallback });
        let max = 0;
        const source = { size: file.length, read: (position, length) => { max = Math.max(max, length); return file.subarray(position, position + length); }, close() {} };
        const archive = new TarArchive(new inflate.GzipFile(source));
        assert.deepEqual(archive.getmembers().map((member) => member.name), ['f']);
        largest[forceFallback] = max;
      }
    } finally {
      Object.assign(inflate.inflateConfig, previous);
    }
    assert.ok(largest[false] <= 131072, `primary ${largest[false]}`);
    assert.ok(largest[true] <= 4 * 131072, `fallback ${largest[true]}`);
  });

  it('a stream longer than the input bound is refused, not read without limit', () => {
    const big = zlib.gzipSync(Buffer.concat([tarBlock('f', crypto.randomBytes(300000)), Buffer.alloc(1024)]));
    const previous = { ...inflate.inflateConfig };
    try {
      Object.assign(inflate.inflateConfig, { forceFallback: true, maxInput: 131072 });
      const source = new inflate.BufferSource(big);
      assert.throws(() => new TarArchive(new inflate.GzipFile(source)).getmembers(), (error) => /decompression limit/.test(error.message));
    } finally {
      Object.assign(inflate.inflateConfig, previous);
    }
  });
});

// ------------------------------------------------------------------------------------------------ R08 rmtree raw names
describe('R08 rmtree removes names that are not UTF-8', () => {
  it('raw byte names (Linux), nested and as the top', { skip: process.platform !== 'linux' && 'needs a file system that accepts raw names' }, () => {
    const base = mkdtempSync(join(tmpdir(), 'lcu-r8-'));
    try {
      const top = Buffer.concat([Buffer.from(`${base}/`), Buffer.from('tree')]);
      mkdirSync(top);
      const rawDir = Buffer.concat([top, Buffer.from([0x2f, 0x72, 0x61, 0x77, 0xff])]);
      mkdirSync(rawDir);
      writeFileSync(Buffer.concat([rawDir, Buffer.from([0x2f, 0x66, 0xfe])]), 'x');
      writeFileSync(Buffer.concat([top, Buffer.from([0x2f, 0x6f, 0xfd])]), 'y');
      symlinkSync('/nonexistent', Buffer.concat([top, Buffer.from([0x2f, 0x6c, 0xfc])]));
      rmtree(top);
      assert.equal(existsSync(top), false);
      // the same through the str form os.fsdecode gives (surrogate escapes)
      const second = Buffer.concat([Buffer.from(`${base}/`), Buffer.from([0x72, 0xff])]);
      mkdirSync(second);
      writeFileSync(Buffer.concat([second, Buffer.from('/a')]), 'z');
      rmtree(`${base}/r\udcff`);
      assert.equal(existsSync(second), false);
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('ordinary trees, symlink top refused, first failure names the failing entry', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'lcu-r8-'));
    try {
      mkdirSync(join(base, 'a/b'), { recursive: true });
      writeFileSync(join(base, 'a/b/f'), 'x');
      rmtree(join(base, 'a'));
      assert.equal(existsSync(join(base, 'a')), false);
      mkdirSync(join(base, 'real'));
      symlinkSync(join(base, 'real'), join(base, 'link'));
      assert.throws(() => rmtree(join(base, 'link')), /Cannot call rmtree on a symbolic link/);
      if (process.platform !== 'win32' && process.getuid?.() !== 0) { // chmod 0 does not lock a directory on Windows
        mkdirSync(join(base, 'locked/inner'), { recursive: true });
        chmodSync(join(base, 'locked'), 0);
        assert.throws(() => rmtree(join(base, 'locked')), (error) => error.code === 'EACCES' && String(error.path ?? error.message).includes('locked'));
        chmodSync(join(base, 'locked'), 0o700);
      } else t.diagnostic('root: the unreadable-directory case is skipped');
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});

// ------------------------------------------------------------------------------------------------ http: AbortSignal, curl wording
describe('http AbortSignal and the curl-missing wording', () => {
  const listen = (handler) => new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1', () => resolve({ server, sockets, url: `http://127.0.0.1:${server.address().port}/f` }));
  });
  const stop = ({ server, sockets }) => { for (const socket of sockets) socket.destroy(); server.close(); };

  it('aborting a stalled download closes the socket at once and rejects with the signal reason', async () => {
    let serverSide;
    const fixture = await listen((request, response) => {
      serverSide = request.socket;
      response.writeHead(200, { 'Content-Length': '1000000' });
      response.write('x'.repeat(1000)); // then stall
    });
    const directory = mkdtempSync(join(tmpdir(), 'lcu-abort-'));
    try {
      const controller = new AbortController();
      const started = fetchToFile(fixture.url, join(directory, 'out'), { env: { PATH: process.env.PATH }, timeout: 30, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = performance.now();
      controller.abort();
      await assert.rejects(started, (error) => error.name === 'AbortError');
      assert.ok(performance.now() - before < 1000, 'rejected promptly, not after the 30 s timeout');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(serverSide.destroyed, true, 'the server saw the connection close');
    } finally {
      stop(fixture);
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('abort before the request, and while the head is awaited (fetchBytes, urlopen)', async () => {
    const fixture = await listen(() => { /* never answers */ });
    try {
      const done = new AbortController();
      done.abort(new Error('already'));
      await assert.rejects(fetchBytes(fixture.url, { env: { PATH: process.env.PATH }, signal: done.signal }), /already/);
      const controller = new AbortController();
      const pending = fetchBytes(fixture.url, { env: { PATH: process.env.PATH }, timeout: 30, signal: controller.signal });
      setTimeout(() => controller.abort(), 200);
      await assert.rejects(pending, (error) => error.name === 'AbortError');
    } finally {
      stop(fixture);
    }
  });

  it('CURL_MISSING_MESSAGE says LCU, and curl() without a curl on PATH raises it', () => {
    assert.equal(CURL_MISSING_MESSAGE, 'LCU cannot verify HTTPS certificates and curl is not installed.');
    assert.throws(() => curl(['https://example.invalid/'], { env: { PATH: '/nonexistent' } }), (error) => error.message === CURL_MISSING_MESSAGE);
  });
});
