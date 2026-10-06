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


if __name__ == '__main__':
    unittest.main()
