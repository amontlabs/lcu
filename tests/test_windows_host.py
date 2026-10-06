"""Structurally selected Windows host extraction from disposable ASAR fixtures."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from lcu import windows_host


def minimal_env():
    """PATH only, plus SystemRoot on Windows: Node aborts at startup without it."""
    env = {'PATH': os.environ.get('PATH', '')}
    if 'SYSTEMROOT' in os.environ:
        env['SYSTEMROOT'] = os.environ['SYSTEMROOT']
    return env


def _asar(path: Path, members: dict[str, bytes]):
    files = {}
    payload = bytearray()
    for name, content in members.items():
        node = files
        parts = name.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        node[parts[-1]] = {'offset': str(len(payload)), 'size': len(content)}
        payload.extend(content)
    header = json.dumps({'files': files}, separators=(',', ':')).encode()
    path.write_bytes(struct.pack('<4I', 4, 8 + len(header), 4 + len(header), len(header)) +
                     header + payload)
    return hashlib.sha256(path.read_bytes()).hexdigest()


NODE = shutil.which('node')
OPTIONS = ('{codexCliPath,nativePipeDirectory,windowsHelperPath,'
           'windowsHelperTransportModulePath}')
LOCATION = '.vite/build/'
GENERATED = LOCATION + 'lcu-original-pipe-host.cjs'

# Hand-written stand-ins for the structures of the app's bundle; none is OpenAI code.
OLD_MAIN = (
    b"const n = require('./src-current-hash.js'); const r = require('./logger-current-hash.js'); "
    b'function Zed(' + OPTIONS.encode() + b') { return {pipePath: nativePipeDirectory, '
    b'closeActiveTurn() { return false; }, probe: n.value + ":" + r.ok}; }')

SPLIT_MAIN = (
    b'"use strict";\n'
    b'const e=require("./rolldown-runtime-h.js"),t=require("./src-h.js"),zz=require("./unreached-h.js");\n'
    b'let g=require("electron");g=e.a(g);\n'
    b'let v=require("node:path"),y=e.a(v,1);v=e.a(v);\n'
    b'let k=require("node:os");k=e.a(k);\n'
    b'const LIMIT=3;\n'
    b'var cache=new Map();\n'
    b'class Counter{constructor(){this.n=0}bump(){return this.n+=LIMIT}}\n'
    b'function helper(a,b){return a+b+LIMIT}\n'
    b'function unrelated(){return g.app+zz.value}\n'
    b'var schema=t.build({lead:1});\n'
    b'async function Kne({codexCliPath:g,nativePipeDirectory:e,onAnalyticsEvent:t,windowsHelperPath:i,'
    b'windowsHelperTransportModulePath:a}){\n'
    b'  const count=new Counter();count.bump();cache.set("k",helper(e.length,1));\n'
    b'  const load=async p=>(await import(p)).value;\n'
    b'  return {pipePath:e,closeActiveTurn:async()=>false,hasActiveTurn:()=>false,dispose:async()=>{},\n'
    b'    probe:[v.basename("x/y.txt"),typeof k.platform,count.n,cache.get("k"),schema,g,typeof t,'
    b'typeof load].join("|")};\n'
    b'}\n'
    b'console.log("bundle bootstrap must not run");\n')

SPLIT_PROBE = 'y.txt|function|3|13|built:1|cli|undefined|function'

SPLIT_MEMBERS = {
    'src-h.js': (b'const core=require("./core-h.js");\n'
                 b'module.exports={build:o=>"built:"+o.lead+core.suffix};'),
    'core-h.js': b'const dep=require("../../node_modules/dep/index.js");module.exports={suffix:dep.suffix};',
    'rolldown-runtime-h.js': b'module.exports={a:m=>m};',
    'unreached-h.js': b'require("electron");module.exports={value:1};',
    'logger-h.js': b'module.exports={ok:"logger"};',
}


def factory(body: str, *, prelude: str = '') -> str:
    return (prelude + '\nfunction Kne(' + OPTIONS + '){' + body +
            ';return {closeActiveTurn(){},nativePipeDirectory}}\n')


@unittest.skipUnless(NODE, 'Node is needed to run the structural analyzer')
class WindowsHostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.app = self.base / 'original'
        self.archive = self.app / 'app/resources/app.asar'
        self.archive.parent.mkdir(parents=True)
        self.main_name = LOCATION + 'main-current-hash.js'

    def members(self, main, extra=None):
        members = {self.main_name: main.encode() if isinstance(main, str) else main}
        for name, content in (extra or {}).items():
            members[name if '/' in name else LOCATION + name] = content
        return members

    def split(self, main=SPLIT_MAIN):
        members = self.members(main, SPLIT_MEMBERS)
        members['node_modules/dep/index.js'] = b'module.exports={suffix:""};'
        return members

    def plan(self, members):
        _asar(self.archive, members)
        return windows_host.plan_original_host(self.app, node=Path(NODE))

    def extract(self, members, name='derived'):
        _asar(self.archive, members)
        return windows_host.materialize_original_host(self.app, self.base / name, node=Path(NODE))

    def assertLayoutError(self, members, pattern):
        _asar(self.archive, members)
        with self.assertRaisesRegex(ValueError, 'Required Windows host layout is unavailable: .*' + pattern):
            windows_host.materialize_original_host(self.app, self.base / 'derived', node=Path(NODE))
        self.assertFalse((self.base / 'derived').exists())

    def run_factory(self, entry: Path):
        """Load the generated module in plain Node with Electron unavailable and call the factory."""
        script = self.base / 'probe.cjs'
        script.write_text(
            "const Module=require('node:module');const resolve=Module._resolveFilename;\n"
            "Module._resolveFilename=function(request,...rest){\n"
            "  if(request==='electron'||request.startsWith('electron/'))throw new Error('blocked electron');\n"
            "  return resolve.call(this,request,...rest);};\n"
            "const factory=require(process.argv[2]);\n"
            "(async()=>{const host=await factory({codexCliPath:'cli',nativePipeDirectory:'/pipe-dir',\n"
            "  windowsHelperPath:'helper',windowsHelperTransportModulePath:process.argv[3]});\n"
            "  const result={keys:Object.keys(host).sort(),probe:host.probe,\n"
            "    closed:await host.closeActiveTurn({sessionId:'s',turnId:'t'})};\n"
            "  if(typeof host.dispose==='function')await host.dispose();console.log(JSON.stringify(result));})()"
            ".catch(e=>{console.error(e);process.exit(1)});\n")
        transport = self.base / 'transport.mjs'
        transport.write_text('export const value = "transport";\n')
        result = subprocess.run([NODE, str(script), str(entry.parent / GENERATED), str(transport)],
                                capture_output=True, text=True, env=minimal_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def analyzed_requires(self, source):
        response = windows_host._analyze(Path(NODE), {'op': 'host', 'source': source})
        return {item['spec'] for item in response['requires']}

    def test_old_self_contained_layout_extracts_unchanged_host(self):
        members = self.members(OLD_MAIN, {
            'src-current-hash.js': (b"const dependency=require('./src-next-hash.js'); "
                                    b'module.exports={value:dependency.value};'),
            'src-next-hash.js': (b"const tslib=require('../../node_modules/tslib/tslib.js'); "
                                 b"module.exports={value:'original:'+tslib.marker};"),
            'logger-current-hash.js': b"module.exports={ok:'logger'};",
            'rolldown-runtime-unused.js': b'module.exports={};',
            'node_modules/tslib/tslib.js': b"module.exports={marker:'tslib'};",
        })
        entry = self.extract(members)
        generated = (entry.parent / GENERATED).read_text()
        self.assertIn(OLD_MAIN[OLD_MAIN.index(b'function Zed'):].decode(), generated)
        self.assertIn('module.exports = Zed;', generated)
        for name, content in members.items():
            if name == self.main_name or name.endswith('rolldown-runtime-unused.js'):
                self.assertFalse((entry.parent / name).exists(), name)
            else:
                self.assertEqual((entry.parent / name).read_bytes(), content)
        self.assertNotIn(b'ORIGINAL_WINDOWS_PIPE_HOST', entry.read_bytes())
        self.assertIn(b'require("./.vite/build/lcu-original-pipe-host.cjs")', entry.read_bytes())
        self.assertEqual(self.run_factory(entry)['probe'], 'original:tslib:logger')
        self.assertTrue((entry.parent / 'windows-lifetime-host.cjs').is_file())
        self.assertTrue((entry.parent / 'windows-sky-service.mjs').is_file())

    def test_split_layout_extracts_scope_correct_closure_and_only_reachable_chunks(self):
        entry = self.extract(self.split())
        generated = (entry.parent / GENERATED).read_text()
        # Needed declarations are copied verbatim, in their original order.
        text = SPLIT_MAIN.decode()
        wanted = ['const e=require("./rolldown-runtime-h.js")', 'let v=require("node:path")',
                  'v=e.a(v);', 'let k=require("node:os")', 'const LIMIT=3;', 'var cache=new Map();',
                  'class Counter{', 'function helper(a,b){return a+b+LIMIT}', 'var schema=t.build({lead:1});',
                  'async function Kne(']
        positions = [generated.index(piece) for piece in wanted]
        self.assertEqual(positions, sorted(positions))
        self.assertIn(text[text.index('class Counter'):text.index('\nfunction helper')], generated)
        # Electron, the unrelated function and the bundle's own bootstrap are not pulled in.
        for absent in ('electron', 'unrelated', 'zz', 'bundle bootstrap'):
            self.assertNotIn(absent, generated)
        self.assertTrue(generated.startswith('// Generated by LCU'))
        self.assertIn('"use strict";', generated)
        self.assertTrue(generated.rstrip().endswith('module.exports = Kne;'))
        # Only the relative-require graph is copied; sibling chunks nothing reaches are not.
        copied = {path.relative_to(entry.parent).as_posix() for path in entry.parent.rglob('*')
                  if path.is_file()}
        self.assertEqual({name for name in copied if name.endswith(('.js', '.cjs')) and 'windows-' not in name},
                         {GENERATED, LOCATION + 'rolldown-runtime-h.js', LOCATION + 'src-h.js',
                          LOCATION + 'core-h.js', 'node_modules/dep/index.js'})
        result = self.run_factory(entry)
        self.assertEqual(result['probe'], SPLIT_PROBE)
        self.assertEqual(result['keys'], ['closeActiveTurn', 'dispose', 'hasActiveTurn', 'pipePath', 'probe'])
        self.assertIs(result['closed'], False)

    def test_alias_letters_follow_the_bundle_instead_of_a_fixed_map(self):
        # The old entry bound c, T, p, v, _ and R to fixed modules. Here other modules own those letters.
        main = (b'const c=require("node:path"),T=require("node:os"),p=require("node:fs"),'
                b'v=require("node:url"),_=require("node:util"),R=require("node:crypto");\n'
                b'function Kne(' + OPTIONS.encode() + b'){return {closeActiveTurn(){},nativePipeDirectory,'
                b'probe:[c.basename("a/b.txt"),typeof T.platform,typeof p.readFileSync,'
                b'typeof v.pathToFileURL,typeof _.inspect,typeof R.randomUUID].join("|")}}\n')
        entry = self.extract(self.members(main))
        self.assertEqual(self.run_factory(entry)['probe'], 'b.txt|function|function|function|function|function')

    def test_wrongly_bound_alias_fails_closed(self):
        # c is bound to Electron here; the host uses it, so extraction must refuse instead of guessing.
        main = factory('const u=c.app', prelude='const c=require("electron");')
        self.assertLayoutError(self.members(main), 'depends on Electron')

    def test_plan_is_read_only_and_needs_no_repository_hash(self):
        plan = self.plan(self.split())
        self.assertEqual((plan.main, plan.factory), (self.main_name, 'Kne'))
        self.assertFalse((self.base / 'derived').exists())
        self.archive.write_bytes(self.archive.read_bytes() + b'tampered')
        self.assertEqual(windows_host.plan_original_host(self.app, node=Path(NODE)).module, plan.module)

    def test_fails_closed_without_a_matching_factory(self):
        for source in (
            b'function Kne({codexCliPath,nativePipeDirectory,windowsHelperPath}){return {closeActiveTurn(){}}}',
            b'const Kne=(' + OPTIONS.encode() + b')=>1;',
            b'function Kne(options){return {closeActiveTurn(){},nativePipeDirectory:options.nativePipeDirectory}}',
            b'if(1){function Kne(' + OPTIONS.encode() + b'){return {closeActiveTurn(){}}}}',
            b'const decoy="function Wre(' + OPTIONS.encode() + b'){}";',
        ):
            with self.subTest(source=source):
                self.assertLayoutError(self.members(source),
                                       'no main bundle has a top-level native-pipe host factory')

    def test_fails_closed_on_several_matching_factories(self):
        one = b'function A(' + OPTIONS.encode() + b'){return {closeActiveTurn(){},nativePipeDirectory}}\n'
        two = b'async function B(' + OPTIONS.encode() + b'){return {closeActiveTurn(){},nativePipeDirectory}}\n'
        self.assertLayoutError(self.members(one + two), 'more than one top-level native-pipe host factory')
        members = self.members(one)
        members[LOCATION + 'main-another.js'] = two
        self.assertLayoutError(members, 'more than one top-level native-pipe host factory')

    def test_fails_closed_without_the_turn_cleanup_interface(self):
        main = b'function Kne(' + OPTIONS.encode() + b'){return {nativePipeDirectory}}'
        self.assertLayoutError(self.members(main), 'no longer exposes closeActiveTurn')

    def test_fails_closed_when_the_factory_depends_on_electron(self):
        for binding in ('let c=require("electron");', 'const c=require("electron"),d=1;',
                        'let c=require("electron");c=require("./rolldown-runtime-h.js").a(c);'):
            with self.subTest(binding=binding):
                main = factory('const u=c.app', prelude=binding)
                self.assertLayoutError(self.members(main, SPLIT_MEMBERS), 'depends on Electron')

    def test_fails_closed_on_unresolved_identifiers(self):
        for body in ('const u=mystery()', 'const u=__dirname', 'const u=exports.x'):
            with self.subTest(body=body):
                self.assertLayoutError(self.members(factory(body)), 'unresolved identifiers')
        self.assertLayoutError(self.members(factory('const u=eval("1")')), 'unsupported eval')

    def test_fails_closed_on_state_changed_outside_the_dependencies(self):
        main = factory('const u=mode', prelude='let mode=1;function setMode(v){mode=v}')
        self.assertLayoutError(self.members(main), 'binding mode is reassigned')
        # Writes inside the included dependencies themselves are fine.
        main = factory('const u=bump()', prelude='let mode=1;function bump(){mode+=1;return mode}')
        self.assertIn('mode+=1', self.plan(self.members(main)).module)

    def test_fails_closed_on_unsupported_static_dependencies(self):
        cases = {
            'a native module': ({'native-h.node': b'\x00'}, 'require("./native-h.node")', 'native module'),
            'a bare package': ({}, 'require("left-pad")', 'non-relative original dependency'),
            'a missing chunk': ({}, 'require("./missing-h.js")', 'original dependency is missing'),
            'a static literal import': ({}, 'import("objc-js")', 'statically'),
            'a computed require': ({}, 'require(process.platform)', 'non-literal'),
            'an escape from the archive': ({}, 'require("../../../outside.js")', 'leaves the application archive'),
            'electron': ({}, 'require("electron/main")', 'depends on Electron'),
        }
        for label, (extra, expression, pattern) in cases.items():
            with self.subTest(label):
                self.assertLayoutError(self.members(factory('const u=' + expression).encode(), extra), pattern)

    def test_fails_closed_on_dependency_graph_hazards(self):
        main = factory('const u=a.x', prelude='const a=require("./src-h.js");').encode()
        for label, chunk, pattern in (
            ('electron in a chunk', b'require("electron");module.exports={};', 'depends on Electron'),
            ('the main bundle', b'require("./main-current-hash.js");', 'reaches the main bundle'),
            ('a missing chunk', b'require("./gone-h.js");', 'original dependency is missing'),
            ('a native module', b'require("./addon.node");', 'native module'),
        ):
            with self.subTest(label):
                self.assertLayoutError(self.members(main, {'src-h.js': chunk, 'addon.node': b'\x00'}), pattern)
        self.assertLayoutError(self.members(main, {'src-h.js': b'module.exports={'}), 'does not parse')

    def test_scope_analysis_ignores_shadowed_names_keys_and_properties(self):
        prelude = ''.join(f'const {name}=require("electron");' for name in 'XYZWQLMPKB')
        body = (
            'const o={X:1,[`k`]:2,Y(){return 1},get Z(){return 1}};'
            'const a=o.Z+o?.W+o.M;'
            'function inner(X){return X}'
            '{let Y=1;Y++}'
            'for(let Z=0;Z<1;Z++){}'
            'for(const [W] of []){}'
            'try{}catch(Q){Q}'
            'try{}catch({L}){L}'
            'const {M}=o,[P]=[1];'
            'lbl:for(;;){break lbl}'
            'const arrow=(K=1,...B)=>K+B.length;'
            'function hoist(){if(1){var X2=1}return X2}'
            'class C{static P=1;static{let Z=1}m(Y){return Y}}'
            'if(1){var Q2=0}'
        )
        self.assertNotIn('electron', self.analyzed_requires(factory(body, prelude=prelude)))

    def test_scope_analysis_follows_real_references(self):
        prelude = 'const X=require("electron"),B=require("node:fs");'
        for expression in ('({X})', '({[X]:1})', '((a=X)=>a)', '`${X}`', 'tag`${X}`', 'typeof X', '[...X]',
                           'new X()', '(class extends X{})', 'X()', '(X++)', '(X=1)', 'X?.a', 'f(...X)',
                           '(()=>{var Y=X})()', '(function(){return arguments,X})()',
                           'void(X.a=1)', '({a:X}=1)', '[X.a]=[1]',
                           '(async()=>{await X})()', '(function X2(){return X})()',
                           ):
            with self.subTest(expression=expression):
                source = factory('const u=' + expression + '; function tag(){} function f(){}', prelude=prelude)
                self.assertIn('electron', self.analyzed_requires(source))
        for statement in ('switch(1){case X:}', 'lbl:{X}', 'for(const k of X){}', 'if(X){}', 'try{X}catch{}',
                          'for(X of []){}', 'for(X in {}){}', 'do{X}while(0)'):
            with self.subTest(statement=statement):
                self.assertIn('electron', self.analyzed_requires(factory(statement, prelude=prelude)))
        # A name declared by the same function or block is not a reference to the bundle's.
        for body in ('var X=1;const u=X', '{const X=1;const u=X}', '(function(X){return X})(1)',
                     '(X=>X)(1)', 'let Y=0;{var X=1}const u=X', 'function X(){}const u=X',
                     'const u=class X{m(){return X}}'):
            with self.subTest(body=body):
                self.assertNotIn('electron', self.analyzed_requires(factory(body, prelude=prelude)))

    def test_unsupported_syntax_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'with statement'):
            windows_host._analyze(Path(NODE), {'op': 'host', 'source': factory('with({}){}')})
        with self.assertRaisesRegex(ValueError, 'does not parse'):
            windows_host._analyze(Path(NODE), {'op': 'host', 'source': 'function ('})

    def test_requires_a_runnable_analyzer_node(self):
        _asar(self.archive, self.members(OLD_MAIN))
        with self.assertRaisesRegex(ValueError, 'original Node needed'):
            windows_host.plan_original_host(self.app, node=self.base / 'missing-node')

    def test_rejects_redirected_archive(self):
        target = self.base / 'elsewhere.asar'
        _asar(target, self.members(OLD_MAIN))
        try:
            self.archive.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest('Symbolic links are not available here')
        with self.assertRaisesRegex(ValueError, 'missing or redirected'):
            windows_host.plan_original_host(self.app, node=Path(NODE))


class WindowsHostLifetimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)

    def test_host_ready_handshake_and_owned_child_disposal(self):
        entry = self.base / 'host.py'
        entry.write_text("import json, sys\nprint(json.dumps({'ready': True, "
                         "'pipePath': r'\\\\.\\pipe\\lcu-wre-fixture', "
                         "'lifetimePath': r'\\\\.\\pipe\\lcu-lifetime-fixture'}), flush=True)\n"
                         "sys.stdin.buffer.read()\n")
        helper = self.base / 'helper.exe'
        transport = self.base / 'transport.js'
        helper.touch()
        transport.touch()
        process, pipe, lifetime = windows_host.start_original_host(
            node=Path(sys.executable), entry=entry, helper=helper, transport=transport, env={})
        self.assertEqual(pipe, r'\\.\pipe\lcu-wre-fixture')
        self.assertEqual(lifetime, r'\\.\pipe\lcu-lifetime-fixture')
        windows_host.stop_original_host(process)
        self.assertEqual(process.returncode, 0)

    def test_host_early_exit_is_an_error(self):
        entry = self.base / 'host.py'
        entry.write_text("print('not ready', flush=True)\n")
        helper = self.base / 'helper.exe'
        transport = self.base / 'transport.js'
        helper.touch()
        transport.touch()
        with self.assertRaisesRegex(ValueError, 'failed to become ready'):
            windows_host.start_original_host(
                node=Path(sys.executable), entry=entry, helper=helper, transport=transport, env={})

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for the lifetime transport test')
    def test_private_lifetime_transport_forwards_ids_and_survives_disconnect(self):
        # Windows uses the production transport, a private named pipe.
        address = (rf'\\.\pipe\lcu-lifetime-test-{uuid.uuid4()}' if sys.platform == 'win32'
                   else str(self.base / 'lifetime.sock'))
        module = Path(windows_host.__file__).with_name('windows_lifetime_host.cjs')
        script = ("const {startLifetimeSignal}=require(process.argv[1]); "
                  "let active='new'; "
                  "startLifetimeSignal(async ({sessionId,turnId})=>{ "
                  "if(turnId==='disconnect'){await new Promise(r=>setTimeout(r,50)); return false;} "
                  "const matched=sessionId==='session'&&turnId===active; "
                  "if(matched)active=null; return matched; }, process.argv[2]) "
                  ".then(signal=>{console.log('ready'); process.stdin.resume(); "
                  "process.stdin.once('end',()=>signal.dispose().then(()=>process.exit(0)));});")
        child = subprocess.Popen([shutil.which('node'), '-e', script, str(module), address],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=minimal_env())
        def cleanup():
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
            for pipe in (child.stdin, child.stdout, child.stderr):
                if pipe and not pipe.closed:
                    pipe.close()
        self.addCleanup(cleanup)
        ready = child.stdout.readline()
        if not ready:
            error = child.stderr.read()
            if b'listen EPERM' in error:
                self.skipTest('Local sandbox denies Unix socket listening')
            self.fail(f'Private lifetime host did not start: {error.decode(errors="replace")[:300]}')
        self.assertEqual(ready, b'ready\n')

        def send(turn, *, drop=False):
            request = json.dumps({'session_id': 'session', 'turn_id': turn}).encode() + b'\n'
            if sys.platform == 'win32':
                with open(address, 'r+b', buffering=0) as pipe:
                    pipe.write(request)
                    return None if drop else json.loads(pipe.readline())
            with socket.socket(socket.AF_UNIX) as client:
                client.connect(address)
                if drop:
                    client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                client.sendall(request)
                if drop:
                    return None
                with client.makefile('rb') as stream:
                    return json.loads(stream.readline())

        self.assertEqual(send('old'), {'closed': False})
        send('disconnect', drop=True)
        # A peer reset during the asynchronous host response must not crash it.
        import time
        time.sleep(0.1)
        self.assertIsNone(child.poll())
        self.assertEqual(send('new'), {'closed': True})
        self.assertEqual(send('new'), {'closed': False})
        child.stdin.close()
        self.assertEqual(child.wait(timeout=5), 0)
        child.stdout.close()

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for trusted-service forwarding test')
    def test_sky_wrapper_registers_once_and_forwards_original_service(self):
        original = self.base / 'original-sky.mjs'
        original.write_text('export function handleRpc(request) { return request.type; }\n')
        wrapper = Path(windows_host.__file__).with_name('windows_sky_service.mjs')
        script = r'''import {pathToFileURL} from 'node:url';
let handlers = 0, ended = false, written, callback;
const listeners = {};
const socket = {
  on(name, fn) { listeners[name] = fn; return this; },
  write(bytes) {
    written = Buffer.from(bytes).toString('utf8');
    queueMicrotask(() => listeners.data(Buffer.from('{"closed":true}\n')));
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
console.log(JSON.stringify({first, second, handlers, ended, written}));'''
        result = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script,
                                 str(wrapper), str(original)], check=True, capture_output=True,
                                env=minimal_env())
        self.assertEqual(json.loads(result.stdout),
                         {'first': 'setup', 'second': 'execute', 'handlers': 1,
                          'ended': True, 'written': '{"session_id":"session","turn_id":"turn"}\n'})


if __name__ == '__main__':
    unittest.main()
