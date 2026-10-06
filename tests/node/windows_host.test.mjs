// Port of tests/test_windows_host.py (structurally selected Windows host extraction from disposable ASAR
// fixtures) plus differential checks against lcu/windows_host.py.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PYTHON } from './python312.mjs';

import { internals } from '../../lcu/macos_host.mjs';
import { own, send as sendSignal, verify } from './process_guard.mjs';
import * as windows_host from '../../lcu/windows_host.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LCU = join(ROOT, 'lcu');
// SAFETY (.port/BRIEF.md): every process this file starts runs in its own session (detached => setsid), its
// identity is recorded at spawn, and it is only signalled through process_guard (verify, then its own handle).
internals.spawn_options = { detached: true };
internals.after_spawn = own;
internals.before_signal = (handle) => assert.ok(verify(handle), 'refusing to signal an unverified process');

const READY = `${JSON.stringify({ ready: true, pipePath: '\\\\.\\pipe\\lcu-wre-fixture', lifetimePath: '\\\\.\\pipe\\lcu-lifetime-fixture' })}\n`;

function minimal_env() {
  const env = { PATH: process.env.PATH ?? '' };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

function _asar(file, members) {
  const files = {};
  const payload = [];
  let size = 0;
  for (const [name, content] of Object.entries(members)) {
    let node = files;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} };
      node = node[part].files;
    }
    node[parts.at(-1)] = { offset: String(size), size: content.length };
    payload.push(content);
    size += content.length;
  }
  const header = Buffer.from(JSON.stringify({ files }));
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(8 + header.length, 4);
  preamble.writeUInt32LE(4 + header.length, 8);
  preamble.writeUInt32LE(header.length, 12);
  writeFileSync(file, Buffer.concat([preamble, header, ...payload]));
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const tree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full)] = readFileSync(full).toString('hex');
    }
  };
  walk(dir);
  return out;
};

describe('windows_host', () => {
  let base;
  let app;
  let archive;
  let main_name;
  let host;
  let main;
  let members;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lcu-wh-'));
    app = join(base, 'original');
    archive = join(app, 'app/resources/app.asar');
    mkdirSync(dirname(archive), { recursive: true });
    main_name = '.vite/build/main-current-hash.js';
    host = Buffer.from('function Wre(options) { return {closeActiveTurn(){}, ' +
      'nativePipeDirectory: options.nativePipeDirectory, ' +
      'probe:n.value+":"+r.ok+":"+typeof T.default.createServer}; }');
    main = Buffer.concat([Buffer.from("const n = require('./src-current-hash.js'); " +
      "const r = require('./logger-current-hash.js'); "), host]);
    members = {
      [main_name]: main,
      '.vite/build/src-current-hash.js': Buffer.from("const dependency=require('./src-next-hash.js'); " +
        'module.exports={value:dependency.value};'),
      '.vite/build/src-next-hash.js': Buffer.from("const tslib=require('../../node_modules/tslib/tslib.js'); " +
        "module.exports={value:'original:'+tslib.marker};"),
      '.vite/build/logger-current-hash.js': Buffer.from("module.exports={ok:'logger'};"),
      '.vite/build/rolldown-runtime-next-hash.js': Buffer.from('module.exports={};'),
      'node_modules/tslib/package.json': Buffer.from('{"main":"tslib.js"}'),
      'node_modules/tslib/tslib.js': Buffer.from("module.exports={marker:'tslib'};"),
    };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const _extract = () => {
    _asar(archive, members);
    return windows_host.materialize_original_host(app, join(base, 'derived'));
  };

  test('extracts unchanged host and rebased direct import', () => {
    const entry = _extract();
    const bytes = readFileSync(entry);
    assert.ok(bytes.includes(host));
    assert.ok(bytes.includes('const n = require("./.vite/build/src-current-hash.js");'));
    assert.ok(!bytes.includes('ORIGINAL_WINDOWS_PIPE_HOST'));
    for (const [name, content] of Object.entries(members)) {
      if (name === main_name) continue;
      assert.deepEqual(readFileSync(join(dirname(entry), name)), content);
    }
    const probe = join(dirname(entry), 'probe.cjs');
    const bootstrap = readFileSync(entry, 'utf8').split('\nasync function start()', 1)[0];
    writeFileSync(probe, `${bootstrap}\nprocess.stdout.write(Wre({nativePipeDirectory:'fixture'}).probe);\n`);
    const resolved = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout, 'original:tslib:logger:function');
    assert.ok(statSync(join(dirname(entry), 'windows-lifetime-host.cjs')).isFile());
    assert.ok(statSync(join(dirname(entry), 'windows-sky-service.mjs')).isFile());
    assert.deepEqual(readFileSync(join(dirname(entry), 'windows-lifetime-host.cjs')), readFileSync(join(LCU, 'windows_lifetime_host.cjs')));
    assert.deepEqual(readFileSync(join(dirname(entry), 'windows-sky-service.mjs')), readFileSync(join(LCU, 'windows_sky_service.mjs')));
  });

  test('materialized tree is byte-identical to the Python implementation', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const entry = _extract();
    const done = spawnSync(PYTHON, ['-B', '-c',
      'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lcu import windows_host; ' +
      'windows_host.materialize_original_host(Path(sys.argv[2]), Path(sys.argv[3]))', ORACLE_ROOT, app, join(base, 'py')],
    { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(tree(dirname(entry)), tree(join(base, 'py')));
  });

  test('destination must not exist (FileExistsError like Path.mkdir)', () => {
    _asar(archive, members);
    mkdirSync(join(base, 'derived'));
    assert.throws(() => windows_host.materialize_original_host(app, join(base, 'derived')),
      (error) => error.message === `[Errno 17] File exists: '${join(base, 'derived')}'`);
  });

  test('does not require a repository archive hash', () => {
    _extract();
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('tampered')]));
    const launcher = windows_host.materialize_original_host(app, join(base, 'derived-updated'));
    assert.ok(readFileSync(launcher).includes(host));
  });

  test('rejects missing source member before writing host', () => {
    delete members['.vite/build/logger-current-hash.js'];
    _asar(archive, members);
    assert.throws(() => windows_host.materialize_original_host(app, join(base, 'derived')),
      /Required Windows host layout is unavailable/);
    assert.equal(existsSync(join(base, 'derived')), false);
  });

  test('rejects ambiguous host layout', () => {
    members['.vite/build/main-another.js'] = main;
    _asar(archive, members);
    assert.throws(() => windows_host.materialize_original_host(app, join(base, 'derived')), /unique Wre host factory/);
    assert.equal(existsSync(join(base, 'derived')), false);
  });

  test('rejects redirected or missing app.asar', () => {
    assert.throws(() => windows_host.materialize_original_host(app, join(base, 'derived')),
      { message: 'Required Windows host layout is unavailable: app/resources/app.asar is missing or redirected' });
  });

  test('Wre lexer matches the Python implementation on tricky sources', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const body = 'nativePipeDirectory;closeActiveTurn;';
    const sources = [
      `function Wre(a) { ${body} }`,
      `function Wre(a = "(") { ${body} const s = '}'; }`,
      `function Wre(a /* ) */) { ${body} const t = \`\${ {a:1}.a } }\`; }`,
      `function Wre(a) { ${body} const r = /}[}]\\//g; return a / 2 / 3; }`,
      `function Wre(a) { ${body} return /}/.test(a); }`,
      `function Wre(a) { ${body} x = typeof /}/; y = a.return /2/ 1; }`,
      `function Wre(a) { ${body} // }\n }`,
      `function Wre(a) { ${body} /* } */ }`,
      `function Wre (a) { ${body} }`,
      `xfunction Wre(a) { ${body} }`,
      `éfunction Wre(a) { ${body} }`,
      `function Wre(a) { ${body}`,
      `function Wre(a) { ${body} "abc }`,
      `function Wre(a) { ${body} /abc }`,
      `function Wre(a) { ${body} /* }`,
      `function Wre(a) x`,
      `function Wre(a) { closeActiveTurn }`,
      `function Wre(a) { ${body} } function Wre(b) { ${body} }`,
      `function Wre(a) { ${body} const q = \`a\${\`b\${c}\`}\`; }`,
      `function Wre(a) { ${body} return 1 }/x/`,
      `function Wre(a) { ${body} if (x) /}/gimx.test(y) }`,
      `function Wre(a) { ${body} é /}/ }`,
      `function Wre(a) { ${body} return /}/ }`,
      `function Wre(a) { ${body} \u{1F600}return /}/ }`,
      `function Wre(a) { ${body} a = b\n/}/ }`,
    ];
    const results = (impl) => sources.map((source) => impl(source));
    const js = results((source) => {
      try {
        return `OK:${windows_host._wre_source(Buffer.from(source, 'utf8')).toString('hex')}`;
      } catch (error) {
        return `ERR:${error.message}`;
      }
    });
    const py = spawnSync(PYTHON, ['-B', '-c',
      'import json, sys; sys.path.insert(0, sys.argv[1]); from lcu import windows_host\n' +
      'out = []\n' +
      'for s in json.load(sys.stdin):\n' +
      '    try: out.append("OK:" + windows_host._wre_source(s.encode()).hex())\n' +
      '    except ValueError as e: out.append("ERR:" + str(e))\n' +
      'print(json.dumps(out))', ORACLE_ROOT], { input: JSON.stringify(sources), encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    assert.deepEqual(js, JSON.parse(py.stdout));
    assert.throws(() => windows_host._wre_source(Buffer.from([0x66, 0xff])),
      { message: 'Required Windows host layout is unavailable: main source is not UTF-8.' });
  });

  test('R12: import scanning uses Python 3.12 Unicode classes, not the running Node\'s', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const hosts = ['r.x; /* n\u1C89 */', 'r.x; /* n\u{105C0} */', 'r.x; n', 'r.x; /* n\u0661 */', 'r.x; /* \u2028n */',
      'r.x; /* n\u{10D40} */', 'r.x; /* \u00b5n */'];
    const main = Buffer.from("const r = require('./a.js');");
    const js = hosts.map((host) => {
      try {
        return JSON.stringify(windows_host._host_imports(main, Buffer.from(host)));
      } catch (error) {
        return `ERR:${error.message}`;
      }
    });
    const py = spawnSync(PYTHON, ['-B', '-c',
      'import json, sys; sys.path.insert(0, sys.argv[1]); from lcu import windows_host\n' +
      'out = []\n' +
      'for h in json.load(sys.stdin):\n' +
      '    try: out.append(json.dumps([list(x) for x in windows_host._host_imports(b"const r = require(\'./a.js\');", h.encode())], separators=(",", ":")))\n' +
      '    except ValueError as e: out.append("ERR:" + str(e))\n' +
      'print(json.dumps(out))', ORACLE_ROOT], { input: JSON.stringify(hosts), encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    assert.deepEqual(js, JSON.parse(py.stdout));
  });

  test('import bindings and direct members match Python rules', () => {
    const hostUsing = Buffer.from('function Wre(){ n.x; r.y; c.z; }');
    assert.deepEqual(windows_host._host_imports(Buffer.from("const r = require('./b.js');const n=require(\"node:fs\");const c = require('x');"), hostUsing),
      [['n', 'node:fs'], ['r', './b.js']]);
    assert.throws(() => windows_host._host_imports(Buffer.from("const q = require('./b.js');"), Buffer.from('q')),
      { message: 'Required Windows host layout is unavailable: unsupported original import binding q' });
    assert.throws(() => windows_host._host_imports(Buffer.from("const n = require('./a');const n = require('./b');"), Buffer.from('n')),
      { message: 'Required Windows host layout is unavailable: ambiguous imported binding n' });
    assert.throws(() => windows_host._host_imports(Buffer.from("const n = require('./a');"), Buffer.from('n r')),
      { message: 'Required Windows host layout is unavailable: original Wre import r is missing' });
    assert.throws(() => windows_host._host_imports(Buffer.from(''), Buffer.from('x')),
      { message: 'Required Windows host layout is unavailable: no supported original module import supplies Wre' });
    assert.equal(windows_host._referenced('n', Buffer.from('$n n$ né')), false);
    assert.equal(windows_host._referenced('n', Buffer.from('(n)')), true);
    const set = new Set(['.vite/a.js']);
    assert.equal(windows_host._direct_member('.vite/build/main.js', '../a.js', set), '.vite/a.js');
    assert.equal(windows_host._direct_member('.vite/build/main.js', 'node:fs', set), null);
    assert.throws(() => windows_host._direct_member('.vite/build/main.js', "x'y", set),
      { message: `Required Windows host layout is unavailable: unsupported non-relative original dependency "x'y"` });
    assert.throws(() => windows_host._direct_member('.vite/build/main.js', './b.js', set),
      { message: 'Required Windows host layout is unavailable: original dependency is missing: .vite/build/b.js' });
  });

  test('host ready handshake and owned child disposal', async () => {
    const entry = join(base, 'host.mjs');
    writeFileSync(entry, `process.stdout.write(${JSON.stringify(READY)}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n`);
    const helper = join(base, 'helper.exe');
    const transport = join(base, 'transport.js');
    writeFileSync(helper, '');
    writeFileSync(transport, '');
    const [proc, pipe, lifetime] = await windows_host.start_original_host({
      node: process.execPath, entry, helper, transport, env: {} });
    assert.equal(pipe, '\\\\.\\pipe\\lcu-wre-fixture');
    assert.equal(lifetime, '\\\\.\\pipe\\lcu-lifetime-fixture');
    await windows_host.stop_original_host(proc);
    assert.equal(proc.returncode, 0);
  });

  test('host receives helper/transport env and runs in the entry directory', async () => {
    const entry = join(base, 'env-host.mjs');
    const capture = join(base, 'env.json');
    writeFileSync(entry, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({cwd: process.cwd(), h: process.env.LCU_WRE_HELPER_PATH, t: process.env.LCU_WRE_TRANSPORT_PATH, x: process.env.X}));
process.stdout.write(${JSON.stringify(READY)}); process.stdin.resume(); process.stdin.on('end', () => process.exit(3));\n`);
    const helper = join(base, 'helper.exe');
    const transport = join(base, 'transport.js');
    writeFileSync(helper, '');
    writeFileSync(transport, '');
    const [proc] = await windows_host.start_original_host({
      node: process.execPath, entry, helper, transport, env: { X: 'y', PATH: process.env.PATH } });
    await assert.rejects(() => windows_host.stop_original_host(proc), { message: 'Original Windows native host exited with status 3.' });
    const seen = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(seen, { cwd: (await import('node:fs')).realpathSync(base), h: helper, t: transport, x: 'y' });
  });

  test('host early exit is an error', async () => {
    const entry = join(base, 'host.mjs');
    writeFileSync(entry, "console.log('not ready');\n");
    const helper = join(base, 'helper.exe');
    const transport = join(base, 'transport.js');
    writeFileSync(helper, '');
    writeFileSync(transport, '');
    await assert.rejects(() => windows_host.start_original_host({ node: process.execPath, entry, helper, transport, env: {} }),
      /failed to become ready/);
    await assert.rejects(() => windows_host.start_original_host({ node: process.execPath, entry: join(base, 'none'), helper, transport, env: {} }),
      { message: 'The selected original Windows native host is incomplete.' });
  });

  test('private lifetime transport forwards ids and survives disconnect', async (t) => {
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\lcu-lifetime-test-${randomUUID()}` : join(base, 'lifetime.sock');
    const module = join(LCU, 'windows_lifetime_host.cjs');
    const script = "const {startLifetimeSignal}=require(process.argv[1]); " +
      "let active='new'; " +
      'startLifetimeSignal(async ({sessionId,turnId})=>{ ' +
      "if(turnId==='disconnect'){await new Promise(r=>setTimeout(r,50)); return false;} " +
      "const matched=sessionId==='session'&&turnId===active; " +
      'if(matched)active=null; return matched; }, process.argv[2]) ' +
      ".then(signal=>{console.log('ready'); process.stdin.resume(); " +
      "process.stdin.once('end',()=>signal.dispose().then(()=>process.exit(0)));});";
    const child = own(spawn(process.execPath, ['-e', script, module, address], { env: minimal_env(), detached: true }));
    t.after(() => { sendSignal(child, 'SIGTERM'); });
    const ready = await new Promise((resolve) => {
      let out = '';
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out); });
      child.on('exit', () => resolve(`exit:${err}`));
    });
    if (ready.includes('listen EPERM')) { t.skip('Local sandbox denies Unix socket listening'); return; }
    assert.equal(ready, 'ready\n');
    const send = (turn, drop = false) => new Promise((resolve, reject) => {
      const client = net.createConnection(address);
      client.on('error', (e) => (drop ? resolve(null) : reject(e)));
      client.on('connect', () => {
        client.write(`${JSON.stringify({ session_id: 'session', turn_id: turn })}\n`);
        if (drop) { client.destroy(); resolve(null); } // unix sockets cannot RST from Node; an abrupt close
      });
      let buf = '';
      client.on('data', (d) => { buf += d; if (buf.includes('\n')) { client.destroy(); resolve(JSON.parse(buf)); } });
    });
    assert.deepEqual(await send('old'), { closed: false });
    await send('disconnect', true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(child.exitCode, null);
    assert.deepEqual(await send('new'), { closed: true });
    assert.deepEqual(await send('new'), { closed: false });
    child.stdin.end();
    const code = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on('exit', r)));
    assert.equal(code, 0);
  });

  test('sky wrapper registers once and forwards original service', () => {
    const original = join(base, 'original-sky.mjs');
    writeFileSync(original, 'export function handleRpc(request) { return request.type; }\n');
    const wrapper = join(LCU, 'windows_sky_service.mjs');
    const script = `import {pathToFileURL} from 'node:url';
let handlers = 0, ended = false, written, callback;
const listeners = {};
const socket = {
  on(name, fn) { listeners[name] = fn; return this; },
  write(bytes) {
    written = Buffer.from(bytes).toString('utf8');
    queueMicrotask(() => listeners.data(Buffer.from('{"closed":true}\\n')));
  },
  end() { ended = true; },
};
globalThis.nodeRepl = {
  env: {LCU_WRE_SKY_SERVICE_PATH: process.argv[2], LCU_WRE_LIFETIME_PIPE: 'fixture'},
  nativePipe: {createConnection: async () => socket},
  addTurnEndedHandler(handler) { handlers++; callback = handler.run; },
};
const service = await import(pathToFileURL(process.argv[1]).href);
const first = await service.handleRpc({type:'setup'});
const second = await service.handleRpc({type:'execute'});
await callback({session_id:'session', turn_id:'turn'});
console.log(JSON.stringify({first, second, handlers, ended, written}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, wrapper, original],
      { encoding: 'utf8', env: minimal_env() });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      first: 'setup', second: 'execute', handlers: 1, ended: true,
      written: '{"session_id":"session","turn_id":"turn"}\n' });
  });
});
