// Port of tests/test_windows_host.py at LCU 0.9.6 (structurally selected Windows host extraction from disposable
// ASAR fixtures; #20) plus differential checks against the Python oracle (tests/blackbox/BASE).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PYTHON } from './python312.mjs';

import { internals } from '../../lcu/macos_host.mjs';
import { own, send as sendSignal, verify } from './process_guard.mjs';
import * as windows_host from '../../lcu/windows_host.mjs';
import { TimeoutExpired } from '../../lcu/compat/subprocess.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';
import { reprStr } from '../../lcu/compat/pyerr.mjs';

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

const NODE = process.execPath;
const OPTIONS = '{codexCliPath,nativePipeDirectory,windowsHelperPath,windowsHelperTransportModulePath}';
const LOCATION = '.vite/build/';
const GENERATED = `${LOCATION}lcu-original-pipe-host.cjs`;
const B = (text) => Buffer.from(text, 'utf8');

// Hand-written stand-ins for the structures of the app's bundle; none is OpenAI code.
const OLD_MAIN = B(
  "const n = require('./src-current-hash.js'); const r = require('./logger-current-hash.js'); " +
  `function Zed(${OPTIONS}) { return {pipePath: nativePipeDirectory, ` +
  'closeActiveTurn() { return false; }, probe: n.value + ":" + r.ok}; }');

const SPLIT_MAIN = B(
  '"use strict";\n' +
  'const e=require("./rolldown-runtime-h.js"),t=require("./src-h.js"),zz=require("./unreached-h.js");\n' +
  'let g=require("electron");g=e.a(g);\n' +
  'let v=require("node:path"),y=e.a(v,1);v=e.a(v);\n' +
  'let k=require("node:os");k=e.a(k);\n' +
  'const LIMIT=3;\n' +
  'var cache=new Map();\n' +
  'class Counter{constructor(){this.n=0}bump(){return this.n+=LIMIT}}\n' +
  'function helper(a,b){return a+b+LIMIT}\n' +
  'function unrelated(){return g.app+zz.value}\n' +
  'var schema=t.build({lead:1});\n' +
  'async function Kne({codexCliPath:g,nativePipeDirectory:e,onAnalyticsEvent:t,windowsHelperPath:i,' +
  'windowsHelperTransportModulePath:a}){\n' +
  '  const count=new Counter();count.bump();cache.set("k",helper(e.length,1));\n' +
  '  const load=async p=>(await import(p)).value;\n' +
  '  return {pipePath:e,closeActiveTurn:async()=>false,hasActiveTurn:()=>false,dispose:async()=>{},\n' +
  '    probe:[v.basename("x/y.txt"),typeof k.platform,count.n,cache.get("k"),schema,g,typeof t,' +
  'typeof load].join("|")};\n' +
  '}\n' +
  'console.log("bundle bootstrap must not run");\n');

const SPLIT_PROBE = 'y.txt|function|3|13|built:1|cli|undefined|function';

const SPLIT_MEMBERS = {
  'src-h.js': B('const core=require("./core-h.js");\n' +
    'module.exports={build:o=>"built:"+o.lead+core.suffix};'),
  'core-h.js': B('const dep=require("../../node_modules/dep/index.js");module.exports={suffix:dep.suffix};'),
  'rolldown-runtime-h.js': B('module.exports={a:m=>m};'),
  'unreached-h.js': B('require("electron");module.exports={value:1};'),
  'logger-h.js': B('module.exports={ok:"logger"};'),
};

const factory = (body, { prelude = '' } = {}) =>
  `${prelude}\nfunction Kne(${OPTIONS}){${body};return {closeActiveTurn(){},nativePipeDirectory}}\n`;

/** The Python oracle (lcu/windows_host.py at tests/blackbox/BASE) on the same archive: plan or error text. */
function pythonPlan(appDir) {
  const done = spawnSync(PYTHON, ['-B', '-c',
    'import json, sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lcu import windows_host\n' +
    'try:\n' +
    '    p = windows_host.plan_original_host(Path(sys.argv[2]), node=Path(sys.argv[3]))\n' +
    '    print(json.dumps({"main": p.main, "factory": p.factory, "module": p.module, "uncarried": p.uncarried,\n' +
    '                      "contents": {k: v.hex() for k, v in p.contents.items()}}))\n' +
    'except ValueError as e:\n' +
    '    print(json.dumps({"error": str(e)}))', ORACLE_ROOT, appDir, NODE], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

function nodePlan(appDir) {
  try {
    const p = windows_host.plan_original_host(appDir, { node: NODE });
    return { main: p.main, factory: p.factory, module: p.module, uncarried: p.uncarried,
      contents: Object.fromEntries([...p.contents].map(([k, v]) => [k, Buffer.from(v).toString('hex')])) };
  } catch (error) {
    if (error.name !== 'ValueError') throw error;
    return { error: error.message };
  }
}

describe('windows_host (structural extraction)', () => {
  let base;
  let app;
  let archive;
  const main_name = `${LOCATION}main-current-hash.js`;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lcu-wh-'));
    app = join(base, 'original');
    archive = join(app, 'app/resources/app.asar');
    mkdirSync(dirname(archive), { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const members = (mainSource, extra = {}) => {
    const out = { [main_name]: Buffer.isBuffer(mainSource) ? mainSource : B(mainSource) };
    for (const [name, content] of Object.entries(extra)) out[name.includes('/') ? name : LOCATION + name] = content;
    return out;
  };
  const split = (mainSource = SPLIT_MAIN) => {
    const out = members(mainSource, SPLIT_MEMBERS);
    out['node_modules/dep/index.js'] = B('module.exports={suffix:""};');
    return out;
  };
  const plan = (m) => {
    _asar(archive, m);
    return windows_host.plan_original_host(app, { node: NODE });
  };
  const extract = (m, name = 'derived') => {
    _asar(archive, m);
    return windows_host.materialize_original_host(app, join(base, name), { node: NODE });
  };
  const assertLayoutError = (m, pattern) => {
    _asar(archive, m);
    assert.throws(() => windows_host.materialize_original_host(app, join(base, 'derived'), { node: NODE }),
      (error) => error.name === 'ValueError' &&
        new RegExp(`Required Windows host layout is unavailable: .*${pattern}`).test(error.message),
      pattern);
    assert.equal(existsSync(join(base, 'derived')), false);
  };
  /** Load the generated module in plain Node with Electron unavailable and call the factory. */
  const run_factory = (entry) => {
    const script = join(base, 'probe.cjs');
    writeFileSync(script,
      "const Module=require('node:module');const resolve=Module._resolveFilename;\n" +
      'Module._resolveFilename=function(request,...rest){\n' +
      "  if(request==='electron'||request.startsWith('electron/'))throw new Error('blocked electron');\n" +
      '  return resolve.call(this,request,...rest);};\n' +
      'const factory=require(process.argv[2]);\n' +
      "(async()=>{const host=await factory({codexCliPath:'cli',nativePipeDirectory:'/pipe-dir',\n" +
      "  windowsHelperPath:'helper',windowsHelperTransportModulePath:process.argv[3]});\n" +
      '  const result={keys:Object.keys(host).sort(),probe:host.probe,\n' +
      "    closed:await host.closeActiveTurn({sessionId:'s',turnId:'t'})};\n" +
      "  if(typeof host.dispose==='function')await host.dispose();console.log(JSON.stringify(result));})()" +
      '.catch(e=>{console.error(e);process.exit(1)});\n');
    const transport = join(base, 'transport.mjs');
    writeFileSync(transport, 'export const value = "transport";\n');
    const result = spawnSync(NODE, [script, join(dirname(entry), GENERATED), transport],
      { encoding: 'utf8', env: minimal_env() });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const analyzed_requires = (source) => {
    const response = windows_host._analyze(NODE, new Map([['op', 'host'], ['source', source]]));
    return new Set(response.get('requires').map((item) => item.get('spec')));
  };

  test('old self-contained layout extracts unchanged host', () => {
    const m = members(OLD_MAIN, {
      'src-current-hash.js': B("const dependency=require('./src-next-hash.js'); " +
        'module.exports={value:dependency.value};'),
      'src-next-hash.js': B("const tslib=require('../../node_modules/tslib/tslib.js'); " +
        "module.exports={value:'original:'+tslib.marker};"),
      'logger-current-hash.js': B("module.exports={ok:'logger'};"),
      'rolldown-runtime-unused.js': B('module.exports={};'),
      'node_modules/tslib/tslib.js': B("module.exports={marker:'tslib'};"),
    });
    const entry = extract(m);
    const generated = readFileSync(join(dirname(entry), GENERATED), 'utf8');
    assert.ok(generated.includes(OLD_MAIN.subarray(OLD_MAIN.indexOf('function Zed')).toString()));
    assert.ok(generated.includes('module.exports = Zed;'));
    for (const [name, content] of Object.entries(m)) {
      if (name === main_name || name.endsWith('rolldown-runtime-unused.js')) {
        assert.equal(existsSync(join(dirname(entry), name)), false, name);
      } else {
        assert.deepEqual(readFileSync(join(dirname(entry), name)), content);
      }
    }
    assert.ok(!readFileSync(entry).includes('ORIGINAL_WINDOWS_PIPE_HOST'));
    assert.ok(readFileSync(entry).includes('require("./.vite/build/lcu-original-pipe-host.cjs")'));
    assert.equal(run_factory(entry).probe, 'original:tslib:logger');
    assert.ok(statSync(join(dirname(entry), 'windows-lifetime-host.cjs')).isFile());
    assert.ok(statSync(join(dirname(entry), 'windows-sky-service.mjs')).isFile());
  });

  test('split layout extracts scope-correct closure and only reachable chunks', () => {
    const entry = extract(split());
    const generated = readFileSync(join(dirname(entry), GENERATED), 'utf8');
    // Needed declarations are copied verbatim, in their original order.
    const text = SPLIT_MAIN.toString();
    const wanted = ['const e=require("./rolldown-runtime-h.js")', 'let v=require("node:path")',
      'v=e.a(v);', 'let k=require("node:os")', 'const LIMIT=3;', 'var cache=new Map();',
      'class Counter{', 'function helper(a,b){return a+b+LIMIT}', 'var schema=t.build({lead:1});',
      'async function Kne('];
    const positions = wanted.map((piece) => generated.indexOf(piece));
    assert.ok(positions.every((p) => p >= 0));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.ok(generated.includes(text.slice(text.indexOf('class Counter'), text.indexOf('\nfunction helper'))));
    // Electron, the unrelated function and the bundle's own bootstrap are not pulled in.
    for (const absent of ['electron', 'unrelated', 'zz', 'bundle bootstrap']) assert.ok(!generated.includes(absent), absent);
    assert.ok(generated.startsWith('// Generated by LCU'));
    assert.ok(generated.includes('"use strict";'));
    assert.ok(generated.trimEnd().endsWith('module.exports = Kne;'));
    // Only the relative-require graph is copied; sibling chunks nothing reaches are not.
    const copied = Object.keys(tree(dirname(entry))).map((name) => name.split('\\').join('/'));
    assert.deepEqual(new Set(copied.filter((name) => (name.endsWith('.js') || name.endsWith('.cjs')) && !name.includes('windows-'))),
      new Set([GENERATED, `${LOCATION}rolldown-runtime-h.js`, `${LOCATION}src-h.js`, `${LOCATION}core-h.js`,
        'node_modules/dep/index.js']));
    const result = run_factory(entry);
    assert.equal(result.probe, SPLIT_PROBE);
    assert.deepEqual(result.keys, ['closeActiveTurn', 'dispose', 'hasActiveTurn', 'pipePath', 'probe']);
    assert.equal(result.closed, false);
  });

  test('alias letters follow the bundle instead of a fixed map', () => {
    // The old entry bound c, T, p, v, _ and R to fixed modules. Here other modules own those letters.
    const mainSource = 'const c=require("node:path"),T=require("node:os"),p=require("node:fs"),' +
      'v=require("node:url"),_=require("node:util"),R=require("node:crypto");\n' +
      `function Kne(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory,` +
      'probe:[c.basename("a/b.txt"),typeof T.platform,typeof p.readFileSync,' +
      'typeof v.pathToFileURL,typeof _.inspect,typeof R.randomUUID].join("|")}}\n';
    assert.equal(run_factory(extract(members(mainSource))).probe, 'b.txt|function|function|function|function|function');
  });

  test('wrongly bound alias fails closed', () => {
    // c is bound to Electron here; the host uses it, so extraction must refuse instead of guessing.
    assertLayoutError(members(factory('const u=c.app', { prelude: 'const c=require("electron");' })), 'depends on Electron');
  });

  test('property initialisation of a dependency travels with it', () => {
    const prelude = 'const state={};state.value=42;const tally={n:1};tally.n+=2;tally.n++;';
    const module = plan(members(factory('const u=state.value+tally.n', { prelude }))).module;
    assert.ok(module.includes('state.value=42;'));
    assert.ok(module.includes('tally.n+=2;'));
    assert.ok(module.includes('tally.n++;'));
    // The statement drags its own dependencies along, so Electron is refused rather than dropped.
    assertLayoutError(members(factory('const u=state.value', { prelude: `${prelude}state.unused=require("electron");` })),
      'depends on Electron');
  });

  test('comma sequences of initialisation travel with their bindings', () => {
    const prelude = 'const state={},tally={n:0};state.value=41,state.value++,tally.n+=2;';
    const module = plan(members(factory('const u=state.value', { prelude }))).module;
    assert.ok(module.includes('state.value=41,state.value++,tally.n+=2;'));
    assert.ok(module.includes('const tally={n:0};')); // the sequence also needs tally's declaration
    // Mixed sequences, deletes and destructuring writes are other top-level statements: carried too.
    for (const [p, expected] of [
      ['const state={};state.value=41,register(state);function register(){}', 'register(state);'],
      ['const state={};register(),state.value=41;function register(){}', 'register(),state.value=41;'],
      ['const state={};delete state.value;', 'delete state.value;'],
      ['const state={};({a:state.value}={a:1});', '({a:state.value}={a:1});'],
      ['const state={};[state.value]=[1];', '[state.value]=[1];']]) {
      assert.ok(plan(members(factory('const u=state', { prelude: p }))).module.includes(expected), p);
    }
    // Writes inside a function that is not part of the dependencies run later, not at load.
    assert.ok(plan(members(factory('const u=state', { prelude: 'const state={};function later(){state.value=1}' })))
      .module.includes('const state={};'));
  });

  test('call-based initialisation of app state is carried with its dependencies', () => {
    const prelude = 'const registry=new Map();function handler(){return 7}' +
      'const unrelated=new Map();unrelated.set("x",1);' +
      'registry.set("h",handler);if(registry.size){registry.set("g",handler)}';
    const module = plan(members(factory('const u=registry', { prelude }))).module;
    assert.ok(module.includes('registry.set("h",handler);'));
    assert.ok(module.includes('if(registry.size){registry.set("g",handler)}'));
    assert.ok(module.includes('function handler(){return 7}'));
    assert.ok(!module.includes('unrelated'));
    // The carried statement is checked like any dependency and refused when it cannot be carried.
    for (const [p, pattern] of [
      ['const registry=new Map();registry.set("h",mystery);', 'unresolved identifiers'],
      ['const registry=new Map(),gui=require("electron");registry.set("h",gui);', 'depends on Electron'],
      ['const registry=new Map();registry.set("h",eval("1"));', 'unsupported eval']]) {
      assertLayoutError(members(factory('const u=registry', { prelude: p })), pattern);
    }
  });

  test('calls that only touch imported modules are left out and counted', () => {
    const prelude = 'const lib=require("./src-h.js"),fs=require("node:fs");const schema=lib.build({lead:1});' +
      'lib.build({lead:2});fs.existsSync("x");';
    const m = members(factory('const u=[schema,fs]', { prelude }), SPLIT_MEMBERS);
    m['node_modules/dep/index.js'] = B('module.exports={suffix:""};');
    const result = plan(m);
    assert.equal(result.uncarried, 2); // lib.build({lead:2}) and fs.existsSync("x")
    assert.ok(result.module.includes('2 top-level statement(s) that only call into imported modules were not carried'));
    assert.ok(!result.module.includes('lead:2'));
  });

  test('fails closed on hidden require bindings', () => {
    for (const prelude of ['var require;const state=require("electron");',
      'function require(){}const state=require("./x.js");',
      'const state=((require)=>require("electron"))(x=>x);',
      'const state=function eval(){};']) {
      assertLayoutError(members(factory('const u=state', { prelude })), 'unsupported a binding named require or eval');
    }
    const mainSource = factory('const u=a.x', { prelude: 'const a=require("./src-h.js");' });
    for (const chunk of ['var require;module.exports=require("electron");',
      'function f(require){return require("electron")}module.exports=f;',
      'try{}catch(eval){}']) {
      assertLayoutError(members(mainSource, { 'src-h.js': B(chunk) }), 'unsupported');
    }
  });

  test('trailing slash names a directory only', () => {
    const mainSource = factory('const u=a.x', { prelude: 'const a=require("./dir/");' });
    const m = members(mainSource, { 'dir.js': B('module.exports={x:1};'), [`${LOCATION}dir/index.js`]: B('module.exports={x:3};') });
    assert.deepEqual([...plan(m).contents.keys()], [`${LOCATION}dir/index.js`]);
    assertLayoutError(members(mainSource, { 'dir.js': B('module.exports={x:1};') }), 'original dependency is missing');
  });

  test('loop and block writes to a dependency are carried', () => {
    for (const source of ['var state=1;for(var state of [42]){}', 'var state=1;for(var state in {a:1}){}',
      'var state=1;if(1){var state=2}']) {
      assert.ok(plan(members(factory('const u=state', { prelude: source }))).module.includes(source.split(/;(.*)/s)[1]), source);
    }
  });

  test('fails closed on state written by a function that is not a dependency', () => {
    assertLayoutError(members(factory('const u=mode', { prelude: 'let mode=1;function setMode(v){mode=v}' })),
      'binding mode is reassigned');
  });

  test('fails closed on requires the analysis cannot see', () => {
    for (const prelude of ['const load=require;const state=load("electron");',
      'const state=require.resolve("electron");', 'const state=typeof require;',
      'const state=[require][0]("electron");']) {
      assertLayoutError(members(factory('const u=state', { prelude })), 'unsupported a reference to require');
    }
    const mainSource = factory('const u=a.x', { prelude: 'const a=require("./src-h.js");' });
    for (const chunk of ['eval("require(\\"electron\\")");', 'const load=require;load("electron");']) {
      assertLayoutError(members(mainSource, { 'src-h.js': B(chunk) }), 'unsupported');
    }
  });

  test('relative requires resolve like node', () => {
    const mainSource = factory('const u=a.x+b.x', { prelude: 'const a=require("./cfg"),b=require("./dir");' });
    const m = members(mainSource, { 'cfg.cjs': B('module.exports={x:1};'), 'cfg.json': B('{"x":2}'),
      [`${LOCATION}dir/index.js`]: B('module.exports={x:3};') });
    assert.deepEqual(new Set(plan(m).contents.keys()), new Set([`${LOCATION}cfg.json`, `${LOCATION}dir/index.js`]));
    // Node does not try .cjs for an extensionless specifier.
    assertLayoutError(members(mainSource, { 'cfg.cjs': B('module.exports={x:1};'),
      [`${LOCATION}dir/index.js`]: B('module.exports={x:3};') }), 'original dependency is missing');
    // A package directory needs main-field resolution, which is not supported.
    assertLayoutError(members(mainSource, { 'cfg.json': B('{}'), [`${LOCATION}dir/package.json`]: B('{"main":"x.js"}'),
      [`${LOCATION}dir/x.js`]: B('module.exports={};') }), 'package directory');
  });

  test('plan is read-only and needs no repository hash', () => {
    const first = plan(split());
    assert.deepEqual([first.main, first.factory], [main_name, 'Kne']);
    assert.equal(existsSync(join(base, 'derived')), false);
    writeFileSync(archive, Buffer.concat([readFileSync(archive), B('tampered')]));
    assert.equal(windows_host.plan_original_host(app, { node: NODE }).module, first.module);
  });

  test('fails closed without a matching factory', () => {
    for (const source of [
      'function Kne({codexCliPath,nativePipeDirectory,windowsHelperPath}){return {closeActiveTurn(){}}}',
      `const Kne=(${OPTIONS})=>1;`,
      'function Kne(options){return {closeActiveTurn(){},nativePipeDirectory:options.nativePipeDirectory}}',
      `if(1){function Kne(${OPTIONS}){return {closeActiveTurn(){}}}}`,
      `const decoy="function Wre(${OPTIONS}){}";`]) {
      assertLayoutError(members(source), 'no main bundle has a top-level native-pipe host factory');
    }
  });

  test('fails closed on several matching factories', () => {
    const one = `function A(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory}}\n`;
    const two = `async function B(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory}}\n`;
    assertLayoutError(members(one + two), 'more than one top-level native-pipe host factory');
    const m = members(one);
    m[`${LOCATION}main-another.js`] = B(two);
    assertLayoutError(m, 'more than one top-level native-pipe host factory');
  });

  test('fails closed without the turn cleanup interface', () => {
    assertLayoutError(members(`function Kne(${OPTIONS}){return {nativePipeDirectory}}`), 'no longer exposes closeActiveTurn');
  });

  test('fails closed when the factory depends on electron', () => {
    for (const binding of ['let c=require("electron");', 'const c=require("electron"),d=1;',
      'let c=require("electron");c=require("./rolldown-runtime-h.js").a(c);']) {
      assertLayoutError(members(factory('const u=c.app', { prelude: binding }), SPLIT_MEMBERS), 'depends on Electron');
    }
  });

  test('fails closed on unresolved identifiers', () => {
    for (const body of ['const u=mystery()', 'const u=__dirname', 'const u=exports.x']) {
      assertLayoutError(members(factory(body)), 'unresolved identifiers');
    }
    assertLayoutError(members(factory('const u=eval("1")')), 'unsupported eval');
  });

  test('fails closed on state changed outside the dependencies', () => {
    assertLayoutError(members(factory('const u=mode', { prelude: 'let mode=1;function setMode(v){mode=v}' })),
      'binding mode is reassigned');
    // Writes inside the included dependencies themselves are fine.
    assert.ok(plan(members(factory('const u=bump()', { prelude: 'let mode=1;function bump(){mode+=1;return mode}' })))
      .module.includes('mode+=1'));
  });

  test('fails closed on unsupported static dependencies', () => {
    const cases = {
      'a native module': [{ 'native-h.node': Buffer.from([0]) }, 'require("./native-h.node")', 'native module'],
      'a bare package': [{}, 'require("left-pad")', 'non-relative original dependency'],
      'a missing chunk': [{}, 'require("./missing-h.js")', 'original dependency is missing'],
      'a static literal import': [{}, 'import("objc-js")', 'statically'],
      'a computed require': [{}, 'require(process.platform)', 'non-literal'],
      'an escape from the archive': [{}, 'require("../../../outside.js")', 'leaves the application archive'],
      electron: [{}, 'require("electron/main")', 'depends on Electron'],
    };
    for (const [, [extra, expression, pattern]] of Object.entries(cases)) {
      assertLayoutError(members(factory(`const u=${expression}`), extra), pattern);
    }
  });

  test('fails closed on dependency graph hazards', () => {
    const mainSource = factory('const u=a.x', { prelude: 'const a=require("./src-h.js");' });
    for (const [, chunk, pattern] of [
      ['electron in a chunk', 'require("electron");module.exports={};', 'depends on Electron'],
      ['the main bundle', 'require("./main-current-hash.js");', 'reaches the main bundle'],
      ['a missing chunk', 'require("./gone-h.js");', 'original dependency is missing'],
      ['a native module', 'require("./addon.node");', 'native module']]) {
      assertLayoutError(members(mainSource, { 'src-h.js': B(chunk), 'addon.node': Buffer.from([0]) }), pattern);
    }
    assertLayoutError(members(mainSource, { 'src-h.js': B('module.exports={') }), 'does not parse');
  });

  test('scope analysis ignores shadowed names, keys and properties', () => {
    const prelude = [...'XYZWQLMPKB'].map((name) => `const ${name}=require("electron");`).join('');
    const body = 'const o={X:1,[`k`]:2,Y(){return 1},get Z(){return 1}};' +
      'const a=o.Z+o?.W+o.M;' +
      'function inner(X){return X}' +
      '{let Y=1;Y++}' +
      'for(let Z=0;Z<1;Z++){}' +
      'for(const [W] of []){}' +
      'try{}catch(Q){Q}' +
      'try{}catch({L}){L}' +
      'const {M}=o,[P]=[1];' +
      'lbl:for(;;){break lbl}' +
      'const arrow=(K=1,...B)=>K+B.length;' +
      'function hoist(){if(1){var X2=1}return X2}' +
      'class C{static P=1;static{let Z=1}m(Y){return Y}}' +
      'if(1){var Q2=0}';
    assert.ok(!analyzed_requires(factory(body, { prelude })).has('electron'));
  });

  test('scope analysis follows real references', () => {
    const prelude = 'const X=require("electron"),B=require("node:fs");';
    for (const expression of ['({X})', '({[X]:1})', '((a=X)=>a)', '`${X}`', 'tag`${X}`', 'typeof X', '[...X]',
      'new X()', '(class extends X{})', 'X()', '(X++)', '(X=1)', 'X?.a', 'f(...X)',
      '(()=>{var Y=X})()', '(function(){return arguments,X})()',
      'void(X.a=1)', '({a:X}=1)', '[X.a]=[1]',
      '(async()=>{await X})()', '(function X2(){return X})()']) {
      assert.ok(analyzed_requires(factory(`const u=${expression}; function tag(){} function f(){}`, { prelude })).has('electron'), expression);
    }
    for (const statement of ['switch(1){case X:}', 'lbl:{X}', 'for(const k of X){}', 'if(X){}', 'try{X}catch{}',
      'for(X of []){}', 'for(X in {}){}', 'do{X}while(0)']) {
      assert.ok(analyzed_requires(factory(statement, { prelude })).has('electron'), statement);
    }
    // A name declared by the same function or block is not a reference to the bundle's.
    for (const body of ['var X=1;const u=X', '{const X=1;const u=X}', '(function(X){return X})(1)',
      '(X=>X)(1)', 'let Y=0;{var X=1}const u=X', 'function X(){}const u=X',
      'const u=class X{m(){return X}}']) {
      assert.ok(!analyzed_requires(factory(body, { prelude })).has('electron'), body);
    }
  });

  test('unsupported syntax fails closed', () => {
    assert.throws(() => windows_host._analyze(NODE, new Map([['op', 'host'], ['source', factory('with({}){}')]])), /with statement/);
    assert.throws(() => windows_host._analyze(NODE, new Map([['op', 'host'], ['source', 'function (']])), /does not parse/);
  });

  test('requires a runnable analyzer node', () => {
    _asar(archive, members(OLD_MAIN));
    assert.throws(() => windows_host.plan_original_host(app, { node: join(base, 'missing-node') }), /original Node needed/);
  });

  test('rejects redirected archive', () => {
    const target = join(base, 'elsewhere.asar');
    _asar(target, members(OLD_MAIN));
    symlinkSync(target, archive);
    assert.throws(() => windows_host.plan_original_host(app, { node: NODE }), /missing or redirected/);
  });

  test('the default analyzer Node is the app\'s own app/resources/cua_node/bin/node.exe', () => {
    _asar(archive, members(OLD_MAIN));
    assert.throws(() => windows_host.plan_original_host(app),
      { message: 'Required Windows host layout is unavailable: the original Node needed to read the host layout is missing' });
  });

  test('analyzer failures are reported like the Python module', () => {
    const calls = [];
    const original = windows_host.internals.run;
    try {
      windows_host.internals.run = (cmd, options) => {
        calls.push([cmd, options]);
        return { returncode: 3, stdout: Buffer.from(''), stderr: Buffer.from('  first line of trouble\nsecond\n') };
      };
      assert.throws(() => windows_host._analyze(NODE, new Map([['op', 'host']])), {
        message: 'Required Windows host layout is unavailable: the structural analyzer failed to read the main bundle (first line of trouble)' });
      assert.deepEqual(calls[0][0].slice(1, 2), ['--max-old-space-size=2048']);
      assert.equal(calls[0][1].timeout, 180000);
      assert.deepEqual(Object.keys(calls[0][1].env).filter((k) => k !== 'SYSTEMROOT'), ['PATH']);
      assert.equal(calls[0][1].input.toString(), '{"op": "host"}');
      windows_host.internals.run = () => ({ returncode: 0, stdout: Buffer.from('{"ok": false}'), stderr: Buffer.alloc(0) });
      assert.throws(() => windows_host._analyze(NODE, new Map()), {
        message: 'Required Windows host layout is unavailable: the structural analyzer rejected the main bundle' });
      windows_host.internals.run = () => { const e = new Error('timed out'); e.name = 'TimeoutExpired'; Object.setPrototypeOf(e, TimeoutExpired.prototype); throw e; };
      assert.throws(() => windows_host._analyze(NODE, new Map()), {
        message: 'Required Windows host layout is unavailable: the structural analyzer could not run (TimeoutExpired)' });
    } finally {
      windows_host.internals.run = original;
    }
  });

  test('plans and errors are identical to the Python oracle on the same archives', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const fixtures = [
      members(OLD_MAIN, { 'src-current-hash.js': B('module.exports={value:1};'), 'logger-current-hash.js': B('module.exports={};') }),
      split(),
      members(factory('const u=state.value+tally.n', { prelude: 'const state={};state.value=42;const tally={n:1};tally.n+=2;' })),
      members(factory('const u=c.app', { prelude: 'const c=require("electron");' })),
      members(factory('const u=a.x+b.x', { prelude: 'const a=require("./cfg"),b=require("./dir");' }),
        { 'cfg.json': B('{"x":2}'), [`${LOCATION}dir/index.js`]: B('module.exports={x:3};') }),
      members(factory('const u=require("../../../outside.js")')),
      members(factory('const u=require("left-pad")')),
      members(factory('const u=a.x', { prelude: 'const a=require("./src-h.js");' }), { 'src-h.js': B('module.exports={') }),
      members(`function A(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory}}\nasync function B(${OPTIONS}){return {closeActiveTurn(){},nativePipeDirectory}}\n`),
      members('const x=1;'),
      members(Buffer.from([0x66, 0xff])),
      members(factory('const u=a.x', { prelude: 'const a=require("./dir/");' }), { [`${LOCATION}dir/package.json`]: B('{}') }),
    ];
    for (const m of fixtures) {
      _asar(archive, m);
      assert.deepEqual(nodePlan(app), pythonPlan(app));
    }
  });

  test('materialized tree is byte-identical to the Python implementation', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const entry = extract(split());
    const done = spawnSync(PYTHON, ['-B', '-c',
      'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from lcu import windows_host; ' +
      'windows_host.materialize_original_host(Path(sys.argv[2]), Path(sys.argv[3]), node=Path(sys.argv[4]))',
      ORACLE_ROOT, app, join(base, 'py'), NODE], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(tree(dirname(entry)), tree(join(base, 'py')));
  });

  test('scripts/check_windows_host_layout matches the Python oracle tool', { skip: !PYTHON && 'python3.12 missing' }, () => {
    const tool = (argv) => {
      const py = spawnSync(PYTHON, ['-B', join(ORACLE_ROOT, 'scripts/check_windows_host_layout.py'), ...argv], { encoding: 'utf8' });
      const js = spawnSync(NODE, [join(ROOT, 'scripts/check_windows_host_layout.mjs'), ...argv], { encoding: 'utf8' });
      const trampoline = spawnSync(PYTHON, ['-B', join(ROOT, 'scripts/check_windows_host_layout.py'), ...argv], { encoding: 'utf8' });
      // CPython's text-mode stdio writes CRLF on Windows; the Node tool writes LF.
      const lf = (text) => text.replace(/\r\n/g, '\n');
      assert.deepEqual([js.status, js.stdout, js.stderr], [py.status, lf(py.stdout), lf(py.stderr)], argv.join(' '));
      assert.deepEqual([trampoline.status, lf(trampoline.stdout)], [py.status, lf(py.stdout)]);
    };
    tool(['--help']);
    _asar(archive, split());
    tool([archive, '--node', NODE]);
    _asar(archive, members('const x=1;'));
    tool([archive, '--node', NODE]);
    tool([join(base, 'missing.asar'), '--node', NODE]);
    tool([]);
  });

  test('destination must not exist (FileExistsError like Path.mkdir)', () => {
    _asar(archive, split());
    mkdirSync(join(base, 'derived'));
    assert.throws(() => windows_host.materialize_original_host(app, join(base, 'derived'), { node: NODE }),
      (error) => error.message === `[Errno 17] File exists: ${reprStr(join(base, 'derived'))}`);
  });
});

describe('windows_host (lifetime host)', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'lcu-whl-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

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
