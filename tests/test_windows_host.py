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


class WindowsHostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.app = self.base / 'original'
        self.archive = self.app / 'app/resources/app.asar'
        self.archive.parent.mkdir(parents=True)
        self.main_name = '.vite/build/main-current-hash.js'
        self.host = (b'function Wre(options) { return {closeActiveTurn(){}, '
                     b'nativePipeDirectory: options.nativePipeDirectory, '
                     b'probe:n.value+":"+r.ok+":"+typeof T.default.createServer}; }')
        self.main = (b"const n = require('./src-current-hash.js'); "
                     b"const r = require('./logger-current-hash.js'); " + self.host)
        self.members = {
            self.main_name: self.main,
            '.vite/build/src-current-hash.js': (
                b"const dependency=require('./src-next-hash.js'); "
                b'module.exports={value:dependency.value};'),
            '.vite/build/src-next-hash.js': (
                b"const tslib=require('../../node_modules/tslib/tslib.js'); "
                b"module.exports={value:'original:'+tslib.marker};"),
            '.vite/build/logger-current-hash.js': b"module.exports={ok:'logger'};",
            '.vite/build/rolldown-runtime-next-hash.js': b'module.exports={};',
            'node_modules/tslib/package.json': b'{"main":"tslib.js"}',
            'node_modules/tslib/tslib.js': b"module.exports={marker:'tslib'};",
        }

    def _extract(self):
        _asar(self.archive, self.members)
        return windows_host.materialize_original_host(self.app, self.base / 'derived')

    def test_extracts_unchanged_host_and_rebased_direct_import(self):
        entry = self._extract()
        self.assertIn(self.host, entry.read_bytes())
        self.assertIn(b"const n = require(\"./.vite/build/src-current-hash.js\");", entry.read_bytes())
        self.assertNotIn(b'ORIGINAL_WINDOWS_PIPE_HOST', entry.read_bytes())
        for name, content in self.members.items():
            if name == self.main_name:
                continue
            self.assertEqual((entry.parent / name).read_bytes(), content)
        node = shutil.which('node')
        if node:
            probe = entry.parent / 'probe.cjs'
            bootstrap = entry.read_text().split('\nasync function start()', 1)[0]
            probe.write_text(bootstrap +
                "\nprocess.stdout.write(Wre({nativePipeDirectory:'fixture'}).probe);\n")
            resolved = subprocess.run([node, str(probe)], check=True, capture_output=True, text=True)
            self.assertEqual(resolved.stdout, 'original:tslib:logger:function')
        self.assertTrue((entry.parent / 'windows-lifetime-host.cjs').is_file())
        self.assertTrue((entry.parent / 'windows-sky-service.mjs').is_file())

    def test_does_not_require_a_repository_archive_hash(self):
        self._extract()
        self.archive.write_bytes(self.archive.read_bytes() + b'tampered')
        launcher = windows_host.materialize_original_host(self.app, self.base / 'derived-updated')
        self.assertIn(self.host, launcher.read_bytes())

    def test_rejects_missing_source_member_before_writing_host(self):
        self.members.pop('.vite/build/logger-current-hash.js')
        _asar(self.archive, self.members)
        with self.assertRaisesRegex(ValueError, 'Required Windows host layout is unavailable'):
            windows_host.materialize_original_host(self.app, self.base / 'derived')
        self.assertFalse((self.base / 'derived').exists())

    def test_rejects_ambiguous_host_layout(self):
        self.members['.vite/build/main-another.js'] = self.main
        _asar(self.archive, self.members)
        with self.assertRaisesRegex(ValueError, 'unique Wre host factory'):
            windows_host.materialize_original_host(self.app, self.base / 'derived')
        self.assertFalse((self.base / 'derived').exists())

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
