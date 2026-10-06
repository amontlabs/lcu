"""Differential test: lcu/compat/hash.mjs against scripts/bundle.py and lcu/windows.py hashing."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402
from scripts import bundle  # noqa: E402
from lcu import windows  # noqa: E402

RUNNER = S.ROOT / 'tests/compat/run_hash.mjs'


def populate(root, kind):
    """Build a tree variant under root (an existing empty directory)."""
    def write(rel, data=b'x', mode=None):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if mode is not None:
            os.chmod(path, mode)

    write('bin/lcu', b'#!/bin/sh\n' * 100, 0o755)
    write('bin/tool', b'', 0o644)
    write('lib/a-b.txt', b'dash')
    write('lib/a/b.txt', b'slash')
    write('lib/a.txt', b'dot')
    write('.hidden/.file', b'hidden', 0o600)
    write('data/big.bin', bytes(range(256)) * 20000, 0o644)
    write('uni/café/\U0001f600.txt', b'unicode')
    write('Z-upper', b'u')
    write('a-lower', b'l')
    write('weird name with spaces.txt', b'sp')
    write('mode/rwx', b'm', 0o777)
    write('mode/ro', b'm', 0o444)
    (root / 'emptydir').mkdir()
    (root / 'a-dir/sub').mkdir(parents=True)
    os.symlink('lcu', root / 'bin/lcu-link')
    os.symlink('../lib/a.txt', root / 'bin/up-link')
    os.symlink('emptydir', root / 'dirlink')
    os.symlink('missing', root / 'dangling')
    write('bundle.json', b'{"ignored": true}')
    if kind == 'abs-symlink':
        os.symlink('/etc/hosts', root / 'abs')
    elif kind == 'escape-symlink':
        os.symlink('../../..', root / 'lib/escape')
    elif kind == 'escape-via-link':
        os.symlink('dirlink/../../..', root / 'lib/esc2')
    elif kind == 'fifo':
        os.mkfifo(root / 'pipe')
    elif kind == 'socket':
        sock = socket.socket(socket.AF_UNIX)
        short = Path(tempfile.mkdtemp(prefix='s'))
        sock.bind(str(short / 's'))
        os.replace(short / 's', root / 'sock')
        sock.close()
        short.rmdir()
    elif kind == 'nested-bundle-json':
        write('sub/bundle.json', b'nested')
    elif kind == 'symlink-loop':
        os.symlink('loop2', root / 'loop1')
        os.symlink('loop1', root / 'loop2')


KINDS = ['plain', 'abs-symlink', 'escape-symlink', 'escape-via-link', 'fifo', 'socket', 'nested-bundle-json', 'symlink-loop']


def py_result(fn):
    try:
        return {'ok': True, 'value': fn()}
    except BaseException as exc:  # noqa: BLE001
        return {'ok': False, 'name': type(exc).__name__, 'message': str(exc)}


class HashDifferential(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.spec, cls.expected = [], {}
        small = cls.base / 'file.bin'
        small.write_bytes(os.urandom(3 * 1024 * 1024 + 17))
        empty = cls.base / 'empty.bin'
        empty.write_bytes(b'')
        for name, path in (('big', small), ('empty', empty)):
            cls.spec.append({'id': f'sha-{name}', 'op': 'sha256_file', 'file': str(path)})
            cls.expected[f'sha-{name}'] = py_result(lambda p=path: hashlib.sha256(p.read_bytes()).hexdigest())
        cls.spec.append({'id': 'sha-missing', 'op': 'sha256_file', 'file': str(cls.base / 'nope')})
        cls.expected['sha-missing'] = py_result(lambda: windows._sha256(cls.base / 'nope'))
        for kind in KINDS:
            for target in ('linux', 'windows'):
                root = cls.base / f'tree-{kind}-{target}'
                root.mkdir()
                populate(root, kind)
                ident = f'inv-{kind}-{target}'
                cls.spec.append({'id': ident, 'op': 'inventory', 'root': str(root), 'target': target})
                cls.expected[ident] = py_result(lambda r=root, t=target: json.dumps(bundle.inventory(r, t), sort_keys=True))
            # app inventory of the same tree (Windows installs hash the Store app this way)
            root = cls.base / f'tree-{kind}-linux'
            ident = f'app-{kind}'
            cls.spec.append({'id': ident, 'op': 'app_inventory', 'root': str(root)})
            cls.expected[ident] = py_result(lambda r=root: (lambda inv: [json.dumps(inv, sort_keys=True), windows.inventory_sha256(inv)])(
                windows.application_inventory(r)))
        # seal / manifest text / verify
        for target, arch in (('linux', 'x64'), ('windows', 'x64'), ('darwin', 'arm64')):
            root = cls.base / f'seal-{target}'
            root.mkdir()
            populate(root, 'plain')
            ident = f'manifest-{target}'
            cls.spec.append({'id': ident, 'op': 'manifest_text', 'root': str(root), 'target': target, 'arch': arch,
                             'version': bundle.VERSION})
            def make(r=root, t=target, a=arch):
                bundle.seal(r, a, t)
                return (r / 'bundle.json').read_text()
            cls.expected[ident] = py_result(make)
        cls.verify_cases = {}
        base_root = cls.base / 'verify-base'
        base_root.mkdir()
        populate(base_root, 'plain')
        bundle.seal(base_root, 'x64', 'linux')
        manifest = json.loads((base_root / 'bundle.json').read_text())

        def variant(name, mutate_manifest=None, mutate_tree=None, raw=None):
            root = cls.base / f'verify-{name}'
            import shutil
            shutil.copytree(base_root, root, symlinks=True)
            if mutate_manifest:
                data = json.loads((root / 'bundle.json').read_text())
                mutate_manifest(data)
                (root / 'bundle.json').write_text(json.dumps(data))
            if raw is not None:
                (root / 'bundle.json').write_text(raw)
            if mutate_tree:
                mutate_tree(root)
            return root

        variants = {
            'good': variant('good'),
            'bad-format': variant('bad-format', lambda m: m.update(format=2)),
            'bad-platform': variant('bad-platform', lambda m: m.update(platform='darwin')),
            'bad-version': variant('bad-version', lambda m: m.update(version='0.0.1')),
            'bad-arch': variant('bad-arch', lambda m: m.update(architecture='arm64')),
            'no-arch': variant('no-arch', lambda m: m.pop('architecture')),
            'files-list': variant('files-list', lambda m: m.update(files=[])),
            'not-dict': variant('not-dict', raw='[1, 2]'),
            'bad-json': variant('bad-json', raw='{not json'),
            'tampered-file': variant('tampered-file', mutate_tree=lambda r: (r / 'bin/tool').write_bytes(b'changed')),
            'extra-file': variant('extra-file', mutate_tree=lambda r: (r / 'extra').write_text('e')),
            'removed-file': variant('removed-file', mutate_tree=lambda r: (r / 'Z-upper').unlink()),
            'mode-changed': variant('mode-changed', mutate_tree=lambda r: os.chmod(r / 'bin/tool', 0o755)),
            'link-retargeted': variant('link-retargeted', mutate_tree=lambda r: (os.unlink(r / 'bin/lcu-link'),
                                                                              os.symlink('tool', r / 'bin/lcu-link'))),
            'bundle-symlink': variant('bundle-symlink', mutate_tree=lambda r: (os.rename(r / 'bundle.json', r / 'real.json'),
                                                                            os.symlink('real.json', r / 'bundle.json'))),
            'no-bundle': variant('no-bundle', mutate_tree=lambda r: (r / 'bundle.json').unlink()),
        }
        for name, root in variants.items():
            for arch in ('x64',):
                ident = f'verify-{name}'
                cls.spec.append({'id': ident, 'op': 'verify', 'root': str(root), 'target': 'linux', 'arch': arch,
                                 'version': bundle.VERSION})
                cls.expected[ident] = py_result(lambda r=root, a=arch: (bundle.verify(r, a, 'linux'), 'ok')[1])
        # the Node module's `seal` writes the same file as Python (compared byte for byte)
        for target, arch in (('linux', 'x64'),):
            for side in ('py', 'js'):
                root = cls.base / f'sealcmp-{side}'
                root.mkdir()
                populate(root, 'plain')
            cls.spec.append({'id': 'seal-js', 'op': 'seal', 'root': str(cls.base / 'sealcmp-js'), 'target': target,
                             'arch': arch, 'version': bundle.VERSION})
            cls.expected['seal-js'] = py_result(lambda: (bundle.seal(cls.base / 'sealcmp-py', arch, target),
                                                         (cls.base / 'sealcmp-py/bundle.json').read_text())[1])
        spec_path = cls.base / 'spec.json'
        spec_path.write_text(json.dumps(cls.spec))
        result = S.run_node(RUNNER, spec_path)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.node = json.loads(result.stdout)

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def normalize(self, text):
        return text.replace(str(self.base), '<B>') if isinstance(text, str) else text

    def test_all_operations_match(self):
        failures = []
        for item in self.spec:
            ident = item['id']
            py, js = self.expected[ident], self.node[ident]
            if py['ok'] != js['ok']:
                failures.append(f'[{ident}] outcome python={py} node={js}')
            elif py['ok']:
                if self.normalize(py['value']) != self.normalize(js['value']):
                    failures.append(f'[{ident}] value differs\npython={str(py["value"])[:400]}\nnode={str(js["value"])[:400]}')
            else:
                a, b = self.normalize(py['message']), self.normalize(js['message'])
                if a != b or py['name'] != js['name']:
                    failures.append(f'[{ident}] error python={py["name"]}: {a!r} node={js["name"]}: {b!r}')
        self.assertFalse(failures, f'{len(failures)} of {len(self.spec)} differ:\n' + '\n'.join(failures[:10]))

    def test_error_forms_seen(self):
        names = {r['message'] for r in self.expected.values() if not r['ok']}
        joined = '\n'.join(names)
        for needle in ('Unsafe bundle symlink', 'Unsupported bundle entry', 'integrity check failed',
                       'Unsupported LCU bundle manifest', 'does not match this machine'):
            self.assertIn(needle, joined)

    def test_architecture(self):
        spec = [{'id': t, 'op': 'architecture', 'target': t} for t in ('linux', 'darwin', 'windows', 'plan9')]
        path = self.base / 'arch.json'
        path.write_text(json.dumps(spec))
        node = json.loads(S.run_node(RUNNER, path).stdout)
        for t in ('linux', 'darwin', 'windows', 'plan9'):
            py = py_result(lambda t=t: bundle.architecture(t))
            self.assertEqual(py['ok'], node[t]['ok'], t)
            self.assertEqual(py.get('value') or py['message'], node[t].get('value') or node[t]['message'])


# ---------------------------------------------------------------------------------------------------------------
# Regression tests for the compat-archive-http review: F12 (equality), F13 (strict UTF-8 manifest), F14 (rglob roots)
# and the single ValueError class.
# ---------------------------------------------------------------------------------------------------------------
import re  # noqa: E402
import shutil  # noqa: E402


class HashRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.spec, cls.expected = [], {}
        base_root = cls.base / 'base'
        base_root.mkdir()
        populate(base_root, 'plain')
        bundle.seal(base_root, 'x64', 'linux')
        good = (base_root / 'bundle.json').read_bytes()

        def verify_variant(name, manifest=None, tree=None):
            root = cls.base / f'v-{name}'
            shutil.copytree(base_root, root, symlinks=True)
            if manifest is not None:
                (root / 'bundle.json').write_bytes(manifest(good) if callable(manifest) else manifest)
            if tree:
                tree(root)
            ident = f'verify-{name}'
            cls.spec.append({'id': ident, 'op': 'verify', 'root': str(root), 'target': 'linux', 'arch': 'x64',
                             'version': bundle.VERSION})
            cls.expected[ident] = py_result(lambda: (bundle.verify(root, 'x64', 'linux'), 'ok')[1])

        # F12: numerically equal modes and flags are equal in Python
        verify_variant('float-modes', lambda g: re.sub(rb'"mode": (\d+)', rb'"mode": \1.0', g))
        verify_variant('exponent-modes', lambda g: re.sub(rb'"mode": 420\b', rb'"mode": 4.2e2', g))
        verify_variant('format-float', lambda g: g.replace(b'"format": 1', b'"format": 1.0'))
        verify_variant('format-true', lambda g: g.replace(b'"format": 1', b'"format": true'))
        verify_variant('mode-differs', lambda g: re.sub(rb'"mode": 420\b', rb'"mode": 421.0', g))
        verify_variant('mode-string', lambda g: re.sub(rb'"mode": 420\b', rb'"mode": "420"', g))
        verify_variant('key-order', lambda g: json.dumps(json.loads(g), sort_keys=False).encode())
        # F13: text decoding is strict UTF-8 with text-mode newlines
        verify_variant('invalid-utf8', lambda g: g[:25] + b'\xff' + g[26:])
        verify_variant('truncated-utf8', lambda g: g + b'\xe2\x82')
        verify_variant('bom', lambda g: b'\xef\xbb\xbf' + g)
        verify_variant('crlf', lambda g: g.replace(b'\n', b'\r\n'))
        verify_variant('lone-cr', lambda g: g.replace(b'\n', b'\r'))
        verify_variant('overlong-utf8', lambda g: g[:25] + b'\xc0\xaf' + g[26:])
        verify_variant('surrogate-utf8', lambda g: g[:25] + b'\xed\xa0\x80' + g[26:])
        verify_variant('utf16-manifest', lambda g: g.decode().encode('utf-16'))
        # F14: Path.rglob('*') of a root that is not a directory, or cannot be listed
        for name, make in {
            'missing': lambda root: None,
            'file': lambda root: root.write_text('i am a file'),
            'file-symlink': lambda root: os.symlink('/etc/hosts', root),
            'dangling-symlink': lambda root: os.symlink('missing-target', root),
            'dir-symlink': lambda root: (root.parent / f'{root.name}-real').mkdir() or os.symlink(f'{root.name}-real', root),
            'empty-dir': lambda root: root.mkdir(),
        }.items():
            for target in ('linux', 'windows'):
                root = cls.base / f'inv-{name}-{target}'
                make(root)
                ident = f'inventory-{name}-{target}'
                cls.spec.append({'id': ident, 'op': 'inventory', 'root': str(root), 'target': target})
                cls.expected[ident] = py_result(lambda r=root, t=target: json.dumps(bundle.inventory(r, t), sort_keys=True))
        if os.geteuid() != 0:
            root = cls.base / 'inv-unreadable'
            (root / 'open').mkdir(parents=True)
            (root / 'open/f').write_text('f')
            (root / 'locked').mkdir()
            (root / 'locked/hidden').write_text('hidden')
            os.chmod(root / 'locked', 0)
            cls.spec.append({'id': 'inventory-unreadable', 'op': 'inventory', 'root': str(root), 'target': 'linux'})
            cls.expected['inventory-unreadable'] = py_result(lambda: json.dumps(bundle.inventory(root, 'linux'), sort_keys=True))
        path = cls.base / 'spec.json'
        path.write_text(json.dumps(cls.spec))
        result = S.run_node(RUNNER, path)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.node = json.loads(result.stdout)

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def normalize(self, text):
        return text.replace(str(self.base), '<B>') if isinstance(text, str) else text

    def test_all_match_python(self):
        failures = []
        for item in self.spec:
            ident = item['id']
            py, js = self.expected[ident], self.node[ident]
            if py['ok'] != js['ok']:
                failures.append(f'[{ident}] outcome python={py} node={js}')
            elif py['ok']:
                if self.normalize(py['value']) != self.normalize(js['value']):
                    failures.append(f'[{ident}] value python={str(py["value"])[:300]} node={str(js["value"])[:300]}')
            elif (py['name'], self.normalize(py['message'])) != (js['name'], self.normalize(js['message'])):
                failures.append(f'[{ident}] python={py["name"]}: {py["message"]!r} node={js["name"]}: {js["message"]!r}')
        self.assertFalse(failures, '\n'.join(failures[:8]))

    def test_the_review_probes(self):
        self.assertTrue(self.expected['verify-float-modes']['ok'])  # F12: 420.0 equals 420
        self.assertTrue(self.node['verify-float-modes']['ok'])
        self.assertEqual(self.expected['verify-invalid-utf8']['name'], 'UnicodeDecodeError')  # F13
        self.assertEqual(self.node['verify-invalid-utf8']['name'], 'UnicodeDecodeError')
        self.assertEqual(self.expected['inventory-missing-linux'], {'ok': True, 'value': '{}'})  # F14
        self.assertEqual(self.node['inventory-missing-linux'], {'ok': True, 'value': '{}'})

    def test_a_single_value_error_class_is_shared(self):
        script = (f'import {{ValueError as A}} from "{S.ROOT / "lcu/compat/hash.mjs"}";'
                  f'import {{ValueError as B}} from "{S.ROOT / "lcu/compat/errors.mjs"}";'
                  f'import {{ValueError as C}} from "{S.ROOT / "lcu/compat/pyjson.mjs"}";'
                  f'import {{ZipValueError}} from "{S.ROOT / "lcu/compat/zip.mjs"}";'
                  f'import {{PyValueError}} from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  f'import {{PyValueError as D}} from "{S.ROOT / "lcu/compat/pathlib.mjs"}";'
                  'console.log(JSON.stringify([A === B, B === C, ZipValueError === C, PyValueError === C, D === C]));')
        import subprocess
        out = subprocess.run([S.NODE, '--input-type=module', '-e', script], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), [True] * 5)


# ---------------------------------------------------------------------------------------------------------------
# F10 / F11: compat/errors.mjs is an adapter over pyerr.mjs (one error implementation, one class identity).
# ---------------------------------------------------------------------------------------------------------------
import errno as errno_module  # noqa: E402
import subprocess  # noqa: E402


class ErrorsAdapter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def node(self, body, *args):
        script = (f'import * as errors from "{S.ROOT / "lcu/compat/errors.mjs"}";'
                  f'import * as pyerr from "{S.ROOT / "lcu/compat/pyerr.mjs"}";'
                  f'import * as http from "{S.ROOT / "lcu/compat/http.mjs"}";'
                  f'import {{constants}} from "node:os";'
                  f'{body}')
        out = subprocess.run([S.NODE, '--input-type=module', '-e', script, *args], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_oserror_text_and_class_match_cpython_for_every_errno(self):
        names = self.node('console.log(JSON.stringify(Object.keys(constants.errno)));')
        codes = [name for name in names if name in errno_module.errorcode.values()]
        self.assertGreater(len(codes), 60)
        got = self.node('const codes = JSON.parse(process.argv[1]);'
                        'console.log(JSON.stringify(codes.map((c) => { const e = new errors.PyOSError(c, "x", "y");'
                        'return [e.name, String(e), e.message, e instanceof pyerr.PyOSError, e.errno, e.filename, e.filename2]; })));',
                        json.dumps(codes))
        for code, row in zip(codes, got):
            number = getattr(errno_module, code)
            expected = OSError(number, os.strerror(number), 'x', None, 'y')
            self.assertEqual(row[:3], [type(expected).__name__, str(expected), str(expected)], code)
            self.assertEqual(row[3:], [True, number, 'x', 'y'], code)

    def test_the_review_examples(self):
        got = self.node('console.log(JSON.stringify(["EAGAIN", "EINTR", "EADDRNOTAVAIL", "ENOENT"].map((c) => {'
                        'const e = new errors.PyOSError(c, "x"); return [e.name, e.message, String(e), http.caughtByUpdate(e)]; })));')
        self.assertEqual(got[0][:3], ['BlockingIOError', str(BlockingIOError(errno_module.EAGAIN, os.strerror(errno_module.EAGAIN), 'x')),
                                     str(BlockingIOError(errno_module.EAGAIN, os.strerror(errno_module.EAGAIN), 'x'))])
        self.assertEqual(got[1][0], 'InterruptedError')
        self.assertIn("Can't assign requested address", got[2][1] if sys.platform == 'darwin' else "Can't assign requested address")
        for row in got:
            self.assertEqual(row[1], row[2])  # String(err) is Python's str(exc), never "Name: message"
            self.assertTrue(row[3])  # the update boundary catches every one of them

    def test_conversion_of_node_errors(self):
        got = self.node("""
          import fs from 'node:fs';
          const rows = [];
          for (const fn of [() => fs.openSync('/nonexistent/file', 'r'), () => fs.mkdirSync('/')]) {
            try { fn(); } catch (err) {
              const e = errors.toPyOSError(err, '/shown/name');
              rows.push([e.name, e.message, e instanceof pyerr.PyOSError, errors.toPyOSError(e, 'other') === e]);
            }
          }
          const api = Object.assign(new TypeError('bad'), {code: 'ERR_INVALID_ARG_VALUE'});
          rows.push([errors.toPyOSError(api, 'x') === api]);
          let nul;
          try { errors.pyfs('a\\0b', () => fs.openSync('a\\0b', 'r')); } catch (err) { nul = [err.name, err.message, err instanceof errors.ValueError]; }
          rows.push(nul);
          console.log(JSON.stringify(rows));
        """)
        self.assertEqual(got[0][:2], ['FileNotFoundError', f"[Errno 2] {os.strerror(2)}: '/shown/name'"])
        self.assertEqual(got[1][0], 'FileExistsError')
        self.assertEqual([row[2:] for row in got[:2]], [[True, True]] * 2)
        self.assertEqual(got[2], [True])  # ERR_* API errors are not invented into errnos (F11)
        self.assertEqual(got[3], ['ValueError', 'embedded null byte', True])

    def test_repr_helpers_are_pyerr(self):
        got = self.node('console.log(JSON.stringify([errors.pyRepr === pyerr.reprStr, errors.pyRepr("it\'s \\u00a0 \\x7f"),'
                        'errors.pyBytesRepr(Buffer.from([0x27, 0x22, 0xff, 10]))]));')
        self.assertTrue(got[0])
        self.assertEqual(got[1], repr("it's   \x7f"))
        self.assertEqual(got[2], repr(bytes([0x27, 0x22, 0xff, 10])))


if __name__ == '__main__':
    unittest.main()
