"""lcu/compat/winpath.mjs against CPython's PureWindowsPath and ntpath (pure functions; no Windows host needed)."""
import ntpath
import os
import sys
import unittest
from pathlib import PureWindowsPath

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import NodeTestCase, run_node

PATHS = ['C:\\prefix\\releases\\1.0-abc', 'C:/prefix/releases/1.0-abc/', 'C:\\', 'C:', 'C:rel\\x', '\\rooted\\x',
         'relative\\profile', 'relative/profile', '\\\\server\\share\\x\\y', '\\\\server\\share', 'D:\\a\\.\\b\\\\c',
         'C:\\profiles\\hermes', 'c:\\Users\\me\\AppData\\Local\\LCU', '.', '']
JOINS = [['C:\\Users\\me', 'AppData/Local/LCU'], ['C:\\Users\\me', '.hermes'], ['C:\\a', 'D:\\b'], ['C:\\a', '\\b'],
         ['C:\\a', 'plugins/lcu-cua'], ['C:\\lcu', 'adapters/pi/index.ts'], ['C:\\a', 'b', 'c\\d'], ['rel', 'x']]
RELS = [['C:\\lcu\\adapters\\pi\\index.ts', 'C:\\Users\\me\\AppData\\Local\\LCU\\omp\\user-1'],
        ['C:\\lcu\\adapters\\pi\\index.ts', 'D:\\Users\\me\\omp\\user-1'],
        ['c:\\LCU\\x', 'C:\\lcu\\y\\z']]


def py_case(function):
    try:
        return {'ok': function()}
    except ValueError as exc:
        return {'error': str(exc)}


class WinPathTests(NodeTestCase):
    def test_against_pure_windows_path(self):
        expected = {
            'str': [str(PureWindowsPath(p)) for p in PATHS],
            'abs': [PureWindowsPath(p).is_absolute() for p in PATHS],
            'parent': [str(PureWindowsPath(p).parent) for p in PATHS],
            'name': [PureWindowsPath(p).name for p in PATHS],
            'join': [str(PureWindowsPath(*parts)) for parts in JOINS],
            'rel': [py_case(lambda a=a, b=b: PureWindowsPath(ntpath.relpath(a, b)).as_posix()) for a, b in RELS],
        }
        got = run_node("""
const m = await import(COMPAT + 'winpath.mjs');
const rel = ([a, b]) => { try { return { ok: m.winAsPosix(m.winRelpath(a, b)) }; } catch (e) { return { error: e.message }; } };
emit({
  str: input.paths.map((p) => m.winPathStr(p)),
  abs: input.paths.map((p) => m.winIsAbsolute(p)),
  parent: input.paths.map((p) => m.winParent(p)),
  name: input.paths.map((p) => m.winName(p)),
  join: input.joins.map((parts) => m.winPathStr(...parts)),
  rel: input.rels.map(rel),
});
""", {'paths': PATHS, 'joins': JOINS, 'rels': RELS})
        for key in expected:
            self.assertEqual(got[key], expected[key], key)


NT_PATHS = ['C:\\prefix\\releases\\1.0-abc', 'C:/prefix/releases/1.0-abc/', 'C:\\', 'C:/', 'C:\\a\\..\\b', 'C:\\a\\.\\b\\\\c\\',
            '\\\\server\\share\\x\\y', '\\\\server\\share', 'D:\\a\\..\\..\\x', 'relative\\profile', 'rel/ative/../x',
            '.', '..', 'a\\..', '\\rooted\\x', 'c:\\Users\\me\\AppData\\Local\\LCU']
NT_ENV = {'USERPROFILE': 'C:\\Users\\me', 'USERNAME': 'me'}
NT_EXPAND = ['~', '~\\x', '~/x/y', '~me', '~me\\z', '~other', '~other\\z', 'plain', '']
SETUP = """
Object.defineProperty(process, 'platform', { value: 'win32' });   // the host-flavour branches, off Windows
const m = await import(COMPAT + 'pathlib.mjs');
const attempt = (f) => { try { return { ok: f() }; } catch (e) { return { error: e.name + ': ' + e.message }; } };
"""


class PathlibWindowsHostTests(NodeTestCase):
    """compat/pathlib.mjs with process.platform forced to win32 against CPython's ntpath / PureWindowsPath."""

    def test_flavour_functions(self):
        cwd = 'C:\\work\\dir'
        expected = {
            'str': [str(PureWindowsPath(p)) for p in NT_PATHS],
            'normpath': [ntpath.normpath(p) for p in NT_PATHS],
            'abspath': [ntpath.normpath(ntpath.join(cwd, p)) for p in NT_PATHS],
            'absolute': [str(PureWindowsPath(p)) if PureWindowsPath(p).is_absolute()
                         else str(PureWindowsPath(cwd) / PureWindowsPath(p)) for p in NT_PATHS],
            'uri': [py_case(lambda p=p: PureWindowsPath(p).as_uri()) for p in NT_PATHS],
        }
        got = run_node(SETUP + """
const cwd = input.cwd;
emit({
  str: input.paths.map((p) => m.pathStr(p)),
  normpath: input.paths.map((p) => m.normpath(p)),
  abspath: input.paths.map((p) => m.abspath(p, cwd)),
  absolute: input.paths.map((p) => m.absolute(p, cwd)),
  uri: input.paths.map((p) => attempt(() => m.asUri(p))).map((r) => ('ok' in r ? r : { error: r.error.split(': ').slice(1).join(': ') })),
});
""", {'paths': NT_PATHS, 'cwd': cwd})
        for key in expected:
            self.assertEqual(got[key], expected[key], key)

    def test_expanduser(self):
        from unittest import mock
        with mock.patch.dict(os.environ, NT_ENV, clear=True):
            expected = [ntpath.expanduser(p) for p in NT_EXPAND]
        got = run_node(SETUP + "emit(input.paths.map((p) => m.expanduser(p, { env: input.env })));",
                       {'paths': NT_EXPAND, 'env': NT_ENV})
        self.assertEqual(got, expected)
        env = {'USERPROFILE': 'C:\\Users\\x', 'USERNAME': 'me'}  # profile not named after the user: ~other stays
        with mock.patch.dict(os.environ, env, clear=True):
            expected = [ntpath.expanduser(p) for p in NT_EXPAND]
        got = run_node(SETUP + "emit(input.paths.map((p) => m.expanduser(p, { env: input.env })));",
                       {'paths': NT_EXPAND, 'env': env})
        self.assertEqual(got, expected)
        # HOMEDRIVE + HOMEPATH when USERPROFILE is absent, and nothing known at all.
        env = {'HOMEDRIVE': 'D:', 'HOMEPATH': '\\h\\me', 'USERNAME': 'me'}
        with mock.patch.dict(os.environ, env, clear=True):
            expected = [ntpath.expanduser(p) for p in ['~', '~\\x', '~me']]
        got = run_node(SETUP + "emit(input.paths.map((p) => m.expanduser(p, { env: input.env })));",
                       {'paths': ['~', '~\\x', '~me'], 'env': env})
        self.assertEqual(got, expected)
        with mock.patch.dict(os.environ, {}, clear=True):
            expected = ntpath.expanduser('~\\x')
        self.assertEqual(run_node(SETUP + "emit(m.expanduser('~\\\\x', { env: {} }));"), expected)


if __name__ == '__main__':
    unittest.main()
