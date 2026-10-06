"""lcu/compat/pathlib.mjs against pathlib / os.path."""
import json
import os
import posixpath
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PurePosixPath

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import NODE, NodeTestCase, py_cases, run_node

ALPHA = ['a', 'b', '/', '/', '/', '.', '..', ' ', '%', '#', '?', 'é', '中', '\U0001f600', "'", '"', '\\', '~', '+', '&',
         '=', ':', '@', '!', '$', '(', ')', '*', ',', ';', '[', ']', '\t', '\n', '_', '-', '\x7f', '\x01', ' ']


def fuzz_paths(seed, count):
    rng = random.Random(seed)
    return [''.join(rng.choice(ALPHA) for _ in range(rng.randint(0, 12))) for _ in range(count)]


class UriTests(NodeTestCase):
    def test_as_uri(self):
        cases = ['/', '/a', '/a/b c/d', '/é/中/\U0001f600', '/a%b', '/a#b?c', '//a/b', '///a', '////a//b', '/a/./b/',
                 '/a/../b', "/it's", '/a+b&c=d', '/~user', '/a:b@c', '/(x)[y]{z}', '/a\\b', '/tab\there', '/nl\nx',
                 '/Users/x/Library/Application Support/Claude/claude_desktop_config.json', '/a/b/.', '/./a', '/_-.~',
                 'relative/path', '', '.', '~/x']
        cases += ['/' + c for c in fuzz_paths(11, 1500)]
        cases += fuzz_paths(12, 200)

        def oracle(path):
            return Path(path).as_uri()
        expected = py_cases(oracle, cases)
        got = run_node("""
const m = await import(COMPAT + 'pathlib.mjs');
emit(input.map((p) => { try { return m.asUri(p); } catch (e) { return { error: e.name + ': ' + e.message }; } }));
""", cases)
        for case, want, have in zip(cases, expected, got):
            self.assertEqual(have, want, repr(case))

    def test_as_uri_filesystem_bytes(self):
        # finding 14 (uri-surrogateescape): os.fsencode semantics for surrogate-escaped strings; other
        # lone surrogates are Python's UnicodeEncodeError; raw bytes (Buffer) give the same URI as
        # Path(os.fsdecode(bytes)).as_uri().
        rng = random.Random(14)
        strings = ['/x\udcff', '/a\udc80b', '/é\udcc3\udca9', '/ab\ud800', '/ab\udc7f', '/􏿿', 'rel\udcff',
                   '/\udcff/../\udcfe/./x']
        raw = [b'/x\xff', b'/\xe2\x82A\xed\xa0\x80\xf4\x90\x80\x80\xc0\xaf', b'/\xc3\xa9/\xf0\x9f\x98\x80', b'rel\xff']
        raw += [b'/' + bytes(rng.randrange(1, 256) for _ in range(rng.randint(0, 12))).replace(b'/', b'_')
                for _ in range(1500)]
        want = py_cases(lambda p: Path(p).as_uri(), strings) + py_cases(lambda b: Path(os.fsdecode(b)).as_uri(), raw)
        want_decoded = [os.fsdecode(b) for b in raw]
        got = run_node("""
const m = await import(COMPAT + 'pathlib.mjs');
const attempt = (fn) => { try { return fn(); } catch (e) { return { error: e.name + ': ' + e.message }; } };
emit({
  uris: [...input.strings.map((p) => attempt(() => m.asUri(p))),
         ...input.raw.map((hex) => attempt(() => m.asUri(Buffer.from(hex, 'hex'))))],
  decoded: input.raw.map((hex) => m.fsdecode(Buffer.from(hex, 'hex'))),
  roundtrip: input.raw.every((hex) => m.fsencode(m.fsdecode(Buffer.from(hex, 'hex'))).toString('hex') === hex),
});""", {'strings': strings, 'raw': [b.hex() for b in raw]})
        self.assertEqual(got['uris'], want)
        self.assertEqual(got['decoded'], want_decoded)
        self.assertTrue(got['roundtrip'])

    def test_path_str_and_normpath(self):
        cases = ['', '.', '/', '//', '///', '//a', '///a/b', 'a//b', 'a/./b', './a', 'a/', '/a/../b', '../a', 'a/../..',
                 '/..', '/../..', '//..', 'a/b/../../..', './', './/.', '...'] + fuzz_paths(13, 3000)
        got = run_node("""
const m = await import(COMPAT + 'pathlib.mjs');
emit(input.map((p) => [m.pathStr(p), m.normpath(p)]));""", cases)
        self.assertEqual(got, [[str(PurePosixPath(c)), posixpath.normpath(c)] for c in cases])

    def test_pathstr_join(self):
        cases = [['a', 'b'], ['/a', 'b'], ['a', '/b'], ['', 'a'], ['a', ''], ['//a', 'b', '../c'], ['.', 'a'],
                 ['a/', 'b/'], ['~', 'x']]
        got = run_node("const m = await import(COMPAT + 'pathlib.mjs'); emit(input.map((a) => m.pathStr(...a)));", cases)
        self.assertEqual(got, [str(PurePosixPath(*c)) for c in cases])


class ResolveTests(NodeTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = self.d = Path(self.tmp.name)
        (d / 'real/sub').mkdir(parents=True)
        (d / 'real/file').write_text('x')
        (d / 'real/sub/inner').write_text('x')
        (d / 'file_link').symlink_to('real/file')
        (d / 'abs_link').symlink_to(d / 'real')
        (d / 'rel_dir_link').symlink_to('real/sub')
        (d / 'up_link').symlink_to('real/sub/..')
        (d / 'chain1').symlink_to('chain2')
        (d / 'chain2').symlink_to('real/sub')
        (d / 'dangling').symlink_to('nowhere')
        (d / 'dangling_abs').symlink_to(d / 'missing' / 'deeper')
        (d / 'loop_a').symlink_to('loop_b')
        (d / 'loop_b').symlink_to('loop_a')
        (d / 'self_loop').symlink_to('self_loop')
        (d / 'loop_dir').symlink_to('loop_dir/x')
        (d / 'parent_link').symlink_to('..')
        (d / 'real/sub/to_root').symlink_to('../..')
        (d / 'slashy').symlink_to('real//sub/./')
        (d / 'to_file_then').symlink_to('real/file/more')
        (d / 'rooted').symlink_to('/')
        (d / 'dot').symlink_to('.')
        (d / 'empty_target_dir').mkdir()
        (d / 'empty_target_dir/back').symlink_to('..')

    def paths(self):
        d = str(self.d)
        rel = ['real', 'real/file', 'real/../real/file', 'file_link', 'abs_link/sub', 'rel_dir_link/inner', 'up_link',
               'up_link/file', 'chain1/inner', 'chain1/../file_link', 'dangling', 'dangling/x', 'dangling/../real',
               'dangling_abs', 'dangling_abs/..', 'loop_a', 'loop_a/x', 'loop_b/../real', 'self_loop', 'loop_dir',
               'loop_dir/y', 'real/sub/to_root/real', 'parent_link/' + self.d.name + '/real', 'slashy', 'slashy/inner',
               'to_file_then', 'real/file/x', 'missing', 'missing/../real', 'missing/a/b', 'rooted/etc', 'dot/dot/real',
               'real/./sub//inner', 'empty_target_dir/back/real', '..', '../' + self.d.name + '/real', '.', '', 'real/',
               'file_link/', 'real/file/', 'abs_link/../real', 'rooted/..', 'a' * 300]
        paths = rel + [f'{d}/{r}' for r in rel] + ['/', '//', '/..', '/etc/..', '/tmp', '/var', '/private/var/..',
                                                  f'{d}//real///sub', f'/{d}/real']
        return paths

    def test_resolve_and_realpath(self):
        PY = '''
import json, os, sys
from pathlib import Path
spec = json.load(sys.stdin)
os.chdir(spec['cwd'])
out = []
for p in spec['paths']:
    row = []
    for strict in (False, True):
        for kind in ('resolve', 'realpath'):
            try:
                row.append(str(Path(p).resolve(strict=strict)) if kind == 'resolve' else os.path.realpath(p, strict=strict))
            except BaseException as exc:
                row.append('ERR ' + type(exc).__name__ + ': ' + str(exc))
    out.append(row)
print(json.dumps(out))
'''
        spec = {'cwd': str(self.d), 'paths': self.paths()}
        want = json.loads(subprocess.run([sys.executable, '-c', PY], input=json.dumps(spec), capture_output=True,
                                         text=True, check=True).stdout)
        got = run_node("""
const m = await import(COMPAT + 'pathlib.mjs');
const e = await import(COMPAT + 'pyerr.mjs');
process.chdir(input.cwd);
const attempt = (fn) => { try { return fn(); } catch (err) {
  const sys = e.fromNodeError(err); return 'ERR ' + (sys ? sys.name + ': ' + sys.message : err.name + ': ' + err.message); } };
emit(input.paths.map((p) => { const row = [];
  for (const strict of [false, true]) {
    row.push(attempt(() => m.resolve(p, { strict })));
    row.push(attempt(() => m.realpath(p, { strict })));
  }
  // order: python loops strict -> kind; same order here
  return row; }));
""", spec)
        for path, w, h in zip(spec['paths'], want, got):
            self.assertEqual(h, w, path)


class ExpandUserTests(NodeTestCase):
    def test_expanduser(self):
        PY = '''
import json, os, sys
from pathlib import Path
spec = json.load(sys.stdin)
out = []
for p in spec['paths']:
    row = [os.path.expanduser(p)]
    try:
        row.append(str(Path(p).expanduser()))
    except BaseException as exc:
        row.append('ERR ' + type(exc).__name__ + ': ' + str(exc))
    out.append(row)
print(json.dumps(out))
'''
        paths = ['~', '~/', '~/x', '~//x', '~root', '~root/x', '~root/', '~nosuchuser_zz', '~nosuchuser_zz/x', 'x~', '/~',
                 '~/a/b/', '', '.', '~~', '~:', 'a/~', '~/.config/x y']
        account = os.environ.get('USER', 'root')
        paths += [f'~{account}', f'~{account}/z']
        for env in ({'HOME': '/home/someone'}, {'HOME': '/'}, {'HOME': '/trailing//'}, {'HOME': ''}, {}):
            spec = {'paths': paths}
            run_env = dict(env)
            want = json.loads(subprocess.run([sys.executable, '-c', PY], input=json.dumps(spec), capture_output=True,
                                             text=True, check=True, env=run_env).stdout)
            got = run_node("""
const m = await import(COMPAT + 'pathlib.mjs');
const attempt = (fn) => { try { return fn(); } catch (err) { return 'ERR ' + err.name + ': ' + err.message; } };
emit(input.paths.map((p) => [m.expanduser(p), attempt(() => m.pathExpanduser(p))]));
""", spec, env={**run_env, 'PATH': os.environ['PATH']} if run_env or True else None)
            for path, w, h in zip(paths, want, got):
                self.assertEqual(h, w, f'{env} {path!r}')


if __name__ == '__main__':
    unittest.main()
