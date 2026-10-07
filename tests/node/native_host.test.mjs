// Port of tests/test_native_host.py plus end-to-end relay tests against a fake original host, each compared with the
// Python relay when CPython 3.12 is available. tests/native_pipe.py does not target the relay (it drives the original
// app's nativePipe bridge) and is not ported. Run with `node --test tests/node/native_host.test.mjs`.
import { python312 } from './runtime_support.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { machine, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as relay from '../../lcu/native_host.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PYTHON = python312();
const WINDOWS = process.platform === 'win32'; // the pinned CPython 3.12.10 oracle (never a PATH python3)
const temporaries = [];
after(() => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-relay-')));
  temporaries.push(dir);
  return dir;
};

const frame = (payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
};
const frames = (...payloads) => Buffer.concat(payloads.map(frame));
const readableOf = (buffer, chunk = 7) => Readable.from((function* split() {
  for (let i = 0; i < buffer.length; i += chunk) yield buffer.subarray(i, i + chunk);
}()));
const collector = () => {
  const parts = [];
  const stream = new Writable({ write(chunk, _enc, done) { parts.push(Buffer.from(chunk)); done(); } });
  stream.bytes = () => Buffer.concat(parts);
  return stream;
};

describe('NativeHostRelayTests', () => {
  it('fresh extension reply enables labeled agent requests', () => {
    const original = {
      jsonrpc: '2.0', id: 7,
      result: { type: 'extension', agentRequestHeaderEnabled: false, otherCapability: { nested: true } },
    };
    const result = JSON.parse(relay._enable_agent_header(Buffer.from(JSON.stringify(original))));
    assert.deepEqual(result, { ...original, result: { ...original.result, agentRequestHeaderEnabled: true } });
  });

  it('other native messages remain byte identical', () => {
    const messages = [
      '{ "result": {"type":"extension", "agentRequestHeaderEnabled":true} }',
      '{ "result": {"type":"other", "agentRequestHeaderEnabled":false} }',
      '{ "method":"event", "params":{"agentRequestHeaderEnabled":false} }',
      'not json',
    ].map((text) => Buffer.from(text));
    for (const message of messages) assert.deepEqual(relay._enable_agent_header(message), message, message.toString());
  });

  it('framed stream preserves multiple native messages', async () => {
    const messages = [
      Buffer.from('{"id":1,"result":{"type":"extension","agentRequestHeaderEnabled":false}}'),
      Buffer.from('{"id":2,"result":{"type":"other"}}'),
    ];
    const destination = collector();
    await relay._relay(readableOf(frames(...messages)), destination, relay._enable_agent_header);
    const reader = relay.frameReader(Readable.from([destination.bytes()]));
    assert.equal(JSON.parse(await relay._read_frame(reader)).result.agentRequestHeaderEnabled, true);
    assert.deepEqual(await relay._read_frame(reader), messages[1]);
    assert.equal(await relay._read_frame(reader), null);
  });

  it('truncated native message fails closed', async () => {
    const stream = Readable.from([Buffer.concat([frame(Buffer.alloc(0)).subarray(0, 0), Buffer.from([20, 0, 0, 0]), Buffer.from('partial')])]);
    await assert.rejects(relay._read_frame(stream), (e) => e.name === 'ValueError' && /Short native-message body/.test(e.message));
  });

  it('original host selects installed platform binary', () => {
    const dir = scratch();
    const file = join(dir, 'lcu-native-host');
    writeFileSync(file, 'fixture');
    const real = { ...relay.hooks };
    try {
      for (const [system, arch, segment, name] of [
        ['Linux', 'x86_64', 'linux/x64', 'extension-host'],
        ['Linux', 'aarch64', 'linux/arm64', 'extension-host'],
        ['Darwin', 'arm64', 'macos/arm64', 'ChatGPT for Chrome'],
        ['Darwin', 'x86_64', 'macos/x64', 'ChatGPT for Chrome'],
        ['Windows', 'AMD64', 'windows/x64', 'extension-host.exe'],
      ]) {
        const expected = join(dir, 'chrome/extension-host', segment, name);
        mkdirSync(dirname(expected), { recursive: true });
        writeFileSync(expected, 'fixture');
        Object.assign(relay.hooks, { file, system: () => system, machine: () => arch });
        assert.equal(relay._original_host(), expected, `${system} ${arch}`);
      }
    } finally { Object.assign(relay.hooks, real); }
  });

  it('missing original host fails closed', () => {
    const dir = scratch();
    const real = { ...relay.hooks };
    Object.assign(relay.hooks, { file: join(dir, 'relay'), system: () => 'Darwin', machine: () => 'arm64' });
    try {
      assert.throws(() => relay._original_host(), (e) => e.name === 'ValueError' && /original Chrome native host is missing/.test(e.message));
    } finally { Object.assign(relay.hooks, real); }
  });

  // ---- cases that Python's suite did not cover (see .port/notes/native_host.md) ----
  it('unsupported systems and architectures fail closed', () => {
    const real = { ...relay.hooks };
    try {
      for (const [system, arch] of [['FreeBSD', 'x86_64'], ['Linux', 'riscv64'], ['Windows', 'arm64']]) {
        Object.assign(relay.hooks, { system: () => system, machine: () => arch });
        assert.throws(() => relay._original_host(), (e) => e.message === 'The original Chrome native host is available only for supported Linux, macOS, or Windows architectures');
      }
    } finally { Object.assign(relay.hooks, real); }
  });

  it('frame edge cases: empty frame, clean EOF, short length prefix, 64 MiB ceiling', async () => {
    assert.deepEqual(await relay._read_frame(readableOf(frame(Buffer.alloc(0)))), Buffer.alloc(0));
    assert.equal(await relay._read_frame(readableOf(Buffer.alloc(0))), null);
    await assert.rejects(relay._read_frame(readableOf(Buffer.from([1, 0]))), /Short native-message length/);
    const limit = Buffer.alloc(4);
    limit.writeUInt32LE(64 * 1024 * 1024 + 1);
    await assert.rejects(relay._read_frame(readableOf(limit)), /Native message exceeds the supported size/);
    const exact = Buffer.alloc(4);
    exact.writeUInt32LE(64 * 1024 * 1024);
    await assert.rejects(relay._read_frame(readableOf(exact)), /Short native-message body/); // accepted size, but no body
  });

  it('rewriting matches json.dumps(ensure_ascii=False, separators=(",", ":")) for integers, floats, unicode and key order', { skip: !PYTHON }, () => {
    const payloads = [
      '{"result":{"agentRequestHeaderEnabled":false,"type":"extension","big":12345678901234567890123,"f":1.0,"e":1e300,"neg":-0.0,"s":"é\\u00e9\\ud83d\\ude00\\n\\u0001","n":null,"a":[1,2.50,{"x":1e-7}]},"9":1,"id":3,"id":4}',
      '  {"result" : {"type":"extension","agentRequestHeaderEnabled":false,"nan":NaN,"inf":-Infinity}}  ',
      '{"result":{"type":"extension","agentRequestHeaderEnabled":false,"k":"\\ud800"}}',
    ];
    const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(ORACLE_ROOT)})
from lcu.native_host import _enable_agent_header
for payload in json.loads(sys.stdin.read()):
    try:
        out = _enable_agent_header(payload.encode('utf-8', 'surrogatepass')).hex()
    except Exception as exc:
        out = 'ERR ' + type(exc).__name__ + ': ' + str(exc)
    print(out)`;
    const python = spawnSync(PYTHON, ['-c', script], { input: JSON.stringify(payloads), encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    const got = payloads.map((text) => {
      try { return relay._enable_agent_header(Buffer.from(text)).toString('hex'); } catch (e) { return `ERR ${e.name}: ${e.message}`; }
    });
    assert.deepEqual(got, python.stdout.trim().split(/\r?\n/)); // incl. 'ERR UnicodeEncodeError: ...' (class name and text)
  });

  // ---- end to end through the real script, original host replaced by a fake ----
  describe('end to end', () => {
    let dir; let hostDir; let log;
    const system = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
    const arch = { arm64: 'arm64', aarch64: 'arm64', x86_64: 'x64', amd64: 'x64' }[machine().toLowerCase()];
    const hostName = { macos: 'ChatGPT for Chrome', linux: 'extension-host', windows: 'extension-host.exe' }[system];
    const hello = Buffer.from('{"id":1,"result":{"type":"extension","agentRequestHeaderEnabled":false}}');
    const hello2 = Buffer.from('{"id":1,"result":{"type":"extension","agentRequestHeaderEnabled":true}}');

    // The fake original host: writes `hello` as a frame, then copies stdin to $LCU_FAKE_LOG until EOF, then exits
    // with $LCU_FAKE_EXIT. It also records its argv.
    const fakeHost = (script) => `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"
`;
    const fakeScript = `
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
const prefix = Buffer.alloc(4);
const hello = Buffer.from(process.env.LCU_FAKE_HELLO ?? '');
if (hello.length) { prefix.writeUInt32LE(hello.length); writeSync(1, Buffer.concat([prefix, hello])); }
if (process.env.LCU_FAKE_RAW) { const raw = readFileSync(process.env.LCU_FAKE_RAW); for (let o = 0; o < raw.length;) { try { o += writeSync(1, raw, o); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } }
writeFileSync(process.env.LCU_FAKE_LOG + '.argv', JSON.stringify(process.argv.slice(2)));
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  writeFileSync(process.env.LCU_FAKE_LOG, Buffer.concat(chunks));
  process.exit(Number(process.env.LCU_FAKE_EXIT ?? 0));
});`;

    beforeEach(() => {
      dir = scratch();
      log = join(dir, 'host.log');
      hostDir = join(dir, 'chrome/extension-host', system, arch);
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(join(dir, 'fake-host.mjs'), fakeScript);
      if (WINDOWS) {
        // No #! on Windows: the "host" is a copy of this Node whose NODE_OPTIONS preload plays the fake (and does
        // nothing in any other process, the relay included).
        copyFileSync(process.execPath, join(hostDir, hostName));
        writeFileSync(join(dir, 'fake-host.cjs'), `if (!/extension-host\\.exe$/i.test(process.execPath)) return;\n`
          + fakeScript.replace("import { readFileSync, writeFileSync, writeSync } from 'node:fs';",
            "const { readFileSync, writeFileSync, writeSync } = require('node:fs');"));
      } else {
        writeFileSync(join(hostDir, hostName), fakeHost(join(dir, 'fake-host.mjs')));
        chmodSync(join(hostDir, hostName), 0o755);
      }
    });
    const fakeEnv = () => (WINDOWS ? { NODE_OPTIONS: `--require=${JSON.stringify(join(dir, 'fake-host.cjs').replaceAll('\\', '/'))}` } : {});

    // What `lcu browser __native-host <dir> ARGS` does once the stable launcher has run: native_host.run(dir, ARGS).
    const DRIVER = `const m = await import(${JSON.stringify(new URL('../../lcu/native_host.mjs', import.meta.url).href)});`
      + 'const [dir, ...rest] = process.argv.slice(1); const status = await m.run(dir, rest); process.exit(status);';
    const relayArgs = (target, args = []) => ['--input-type=module', '-e', DRIVER, target, ...args];

    function launch(command, args, input, env = {}, { end = true } = {}) {
      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LCU_FAKE_LOG: log, ...env } });
        const out = []; const err = [];
        child.stdout.on('data', (c) => out.push(c));
        child.stderr.on('data', (c) => err.push(c));
        child.stdin.on('error', () => {});
        child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
        // Written in slow pieces so frames arrive split across reads.
        let offset = 0;
        const pump = () => {
          if (offset >= input.length) { if (end) child.stdin.end(); return; }
          const step = offset < 64 ? 5 : 65536;
          child.stdin.write(input.subarray(offset, offset + step));
          offset += step;
          setTimeout(pump, 1);
        };
        pump();
      });
    }

    const run = async (input, env = {}, args = []) => {
      const target = join(dir, 'private');
      mkdirSync(target, { recursive: true });
      // The relay finds the original host next to itself.
      rmSync(join(target, 'chrome'), { recursive: true, force: true });
      mkdirSync(join(target, 'chrome/extension-host'), { recursive: true });
      const tree = join(dir, 'chrome/extension-host', system);
      cpSync(tree, join(target, 'chrome/extension-host', system), { recursive: true });
      env = { ...fakeEnv(), ...env };
      const node = await launch(process.execPath, relayArgs(target, args), input, env);
      const result = { node, nodeLog: readOptional(log), nodeArgv: readOptional(`${log}.argv`)?.toString() };
      if (PYTHON) {
        const py = join(dir, 'python');
        mkdirSync(join(py, 'chrome/extension-host'), { recursive: true });
        cpSync(tree, join(py, 'chrome/extension-host', system), { recursive: true });
        copyFileSync(join(ORACLE_ROOT, 'lcu/native_host.py'), join(py, 'native_host.py'));
        rmSync(log, { force: true });
        rmSync(`${log}.argv`, { force: true });
        const python = await launch(PYTHON, [join(py, 'native_host.py'), ...args], input, env);
        result.python = python;
        result.pythonLog = readOptional(log);
        result.pythonArgv = readOptional(`${log}.argv`)?.toString();
      }
      return result;
    };
    const readOptional = (path) => { try { return readFileSync(path); } catch { return undefined; } };
    const same = (result) => {
      if (!PYTHON) return;
      assert.deepEqual(result.node.stdout, result.python.stdout, 'stdout bytes');
      assert.equal(result.node.code, result.python.code, 'exit status');
      assert.equal(result.node.signal, result.python.signal, 'signal');
      assert.equal(result.node.stderr, result.python.stderr.replace(/\r\n/g, '\n'), 'stderr'); // CPython text mode writes CRLF on Windows
      assert.deepEqual(result.nodeLog, result.pythonLog, 'bytes the host received');
      assert.equal(result.nodeArgv, result.pythonArgv, 'host argv');
    };

    it('rewrites only the extension header reply (browser to host), forwards everything else and the arguments, exits with the host status', async () => {
      const tail = [Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.alloc(0), Buffer.alloc(300_000, 0x61)];
      const inbound = frames('{"a":1}', hello, ...tail);
      // On Windows the fake host is node.exe itself: the first argument is taken for a script path (resolved), the rest is kept.
      const hostArgs = WINDOWS ? ['host-arg', '--flag'] : ['chrome-extension://x/', '--flag'];
      const result = await run(inbound, { LCU_FAKE_HELLO: hello.toString(), LCU_FAKE_EXIT: '3' }, hostArgs);
      assert.deepEqual(result.node.stdout, frame(hello)); // host to browser is never transformed
      assert.equal(result.node.code, 3, result.node.stderr);
      assert.deepEqual(result.nodeLog, frames('{"a":1}', hello2, ...tail));
      assert.equal(result.nodeArgv, WINDOWS ? '["--flag"]' : '["chrome-extension://x/","--flag"]');
      same(result);
    });

    it('relays binary host output that is not valid UTF-8 and large frames unchanged', async () => {
      const raw = frames(Buffer.from([0xc3, 0x28, 0xa0, 0xa1]), Buffer.alloc(2_000_000, 0x7a));
      writeFileSync(join(dir, 'raw.bin'), raw);
      const result = await run(Buffer.alloc(0), { LCU_FAKE_RAW: join(dir, 'raw.bin') });
      assert.deepEqual(result.node.stdout, raw);
      assert.equal(result.node.code, 0);
      same(result);
    });

    it('a truncated frame from the browser fails closed with exit 1 and the message', async () => {
      const result = await run(Buffer.concat([frame('{"a":1}'), Buffer.from([20, 0, 0, 0]), Buffer.from('partial')]), { LCU_FAKE_HELLO: '' });
      assert.equal(result.node.code, 1);
      assert.equal(result.node.stderr, 'LCU Chrome native-host relay failed: Short native-message body\n');
      same(result);
    });

    it('a length prefix above the ceiling terminates the host and fails', async () => {
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(0x7fffffff);
      const result = await run(prefix, {});
      assert.equal(result.node.code, 1);
      assert.equal(result.node.stderr, 'LCU Chrome native-host relay failed: Native message exceeds the supported size\n');
      same(result);
    });

    it('a short length prefix fails closed', async () => {
      const result = await run(Buffer.from([1, 2]), {});
      assert.equal(result.node.stderr, 'LCU Chrome native-host relay failed: Short native-message length\n');
      same(result);
    });

    it('a missing original host is reported without a traceback', async () => {
      const target = join(dir, 'lonely');
      mkdirSync(target, { recursive: true });
      const node = await launch(process.execPath, relayArgs(target), Buffer.alloc(0));
      assert.equal(node.code, 1);
      assert.match(node.stderr, /^LCU Chrome native-host relay failed: The original Chrome native host is missing: .*\n$/);
    });
  });
});
