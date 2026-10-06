"""lcu/compat/toml.mjs (a port of tomllib), utf8.mjs and which.mjs against CPython."""
import datetime
import os
import random
import shutil
import stat
import sys
import tempfile
import tomllib
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import NodeTestCase, run_node


def tag(value):
    """A canonical, order-preserving text form shared with the Node side."""
    if isinstance(value, bool):
        return ['b', value]
    if isinstance(value, int):
        return ['i', str(value)]
    if isinstance(value, float):
        return ['f', repr(value)]
    if isinstance(value, str):
        return ['s', value]
    if isinstance(value, list):
        return ['l', [tag(item) for item in value]]
    if isinstance(value, dict):
        return ['d', [[key, tag(item)] for key, item in value.items()]]
    if isinstance(value, datetime.datetime):
        offset = value.utcoffset()
        return ['dt', value.replace(tzinfo=None).isoformat(),
                None if offset is None else int(offset.total_seconds() // 60)]
    if isinstance(value, datetime.date):
        return ['date', value.isoformat()]
    if isinstance(value, datetime.time):
        return ['time', value.isoformat()]
    raise AssertionError(type(value))


def oracle(text):
    try:
        return {'ok': tag(tomllib.loads(text))}
    except tomllib.TOMLDecodeError as exc:
        return {'error': f'TOMLDecodeError: {exc}'}


NODE_SIDE = """
const m = await import(COMPAT + 'toml.mjs');
const { PyFloat, reprFloat, isInt } = await import(COMPAT + 'pyjson.mjs');
const pad = (n, w = 2) => String(n).padStart(w, '0');
const tag = (v) => {
  if (typeof v === 'boolean') return ['b', v];
  if (isInt(v)) return ['i', String(v)];
  if (v instanceof PyFloat) return ['f', reprFloat(v.value)];
  if (typeof v === 'string') return ['s', v];
  if (Array.isArray(v)) return ['l', v.map(tag)];
  if (v instanceof Map) return ['d', [...v].map(([k, x]) => [k, tag(x)])];
  const frac = (x) => (x.microsecond ? '.' + pad(x.microsecond, 6) : '');
  if (v instanceof m.datetime) return ['dt', `${pad(v.year, 4)}-${pad(v.month)}-${pad(v.day)}T${pad(v.hour)}:${pad(v.minute)}:${pad(v.second)}${frac(v)}`, v.offset];
  if (v instanceof m.date) return ['date', `${pad(v.year, 4)}-${pad(v.month)}-${pad(v.day)}`];
  if (v instanceof m.time) return ['time', `${pad(v.hour)}:${pad(v.minute)}:${pad(v.second)}${frac(v)}`];
  throw new Error('unknown ' + typeof v);
};
emit(input.map((text) => { try { return { ok: tag(m.loads(text)) }; } catch (e) { return { error: e.name + ': ' + e.message }; } }));
"""

FIXED = [
    '', '\n', '# comment only', 'a = 1', 'a = 1\nb = 2\n', 'a = "x"\r\nb = \'y\'\r\n', 'a.b.c = 1\na.b.d = 2',
    '[a]\nb = 1\n[a.c]\nd = 2', '[a]\n[a]', '[a]\nb=1\n[a.b]', '[[a]]\nb=1\n[[a]]\nb=2', '[[a]]\n[a.b]\n[[a.c]]',
    'a = [1, 2, 3,]', 'a = [1, "x", [true, false]]', 'a = []\n[a.b]', 'a = {b = 1, c = {d = 2}}', 'a = {b = 1,}',
    'a = {b = 1}\n[a.c]', 'a = {b.c = 1, b.d = 2}', 'a = {b = 1, b = 2}',
    'a = 0x1F\nb = 0o17\nc = 0b101\nd = 1_000\ne = +5\nf = -0\ng = 0', 'a = 007', 'a = 1__0', 'a = 1_',
    'a = 1.5\nb = -0.0\nc = 1e10\nd = 1E-3\ne = 6.02_2e2_3\nf = inf\ng = -inf\nh = nan\ni = +nan',
    'a = .5', 'a = 5.', 'a = 1e', 'a = 1979-05-27\nb = 1979-05-27T07:32:00Z\nc = 1979-05-27 07:32:00.999999-08:00',
    'a = 07:32:00\nb = 07:32:00.123456789', 'a = 1979-02-30', 'a = 0000-01-01', 'a = 2023-02-29', 'a = 2024-02-29',
    'a = 1979-13-01', 'a = 1979-05-27T25:00:00', 'a = "unterminated', "a = 'unterminated", 'a = """multi\nline"""',
    'a = """\\\n   trim"""', 'a = """a\\   \n  b"""', 'a = """a\\  x"""', 'a = \'\'\'raw\\n\'\'\'', 'a = """x""""', 'a = """x"""""',
    "a = '''x''''", "a = '''x'''''", 'a = "\\u00e9\\U0001F600"', 'a = "\\ud800"', 'a = "\\u12"', 'a = "\\q"', 'a = "\\x41"',
    'a = "\\e"', 'a = "tab\there"', 'a = "nul\x00"', 'a = "del\x7f"', "a = 'del\x7f'", '# c\x00omment', 'a = 1 # c\x7f',
    '"quoted key" = 1\n\'lit key\' = 2\n"" = 3', '"a.b" = 1\n"a"."b" = 2', 'a = 1 b = 2', 'a = ', 'a', '= 1', '[a', '[a]]',
    '[[a]', '[]', '[a.]', '[.a]', 'a = [1,, 2]', 'a = [1 2]', 'a = {b = 1 c = 2}', 'a = {b = 1', 'a = [1,\n# c\n 2]',
    'a = true\nb = false\nc = tru', 'a = True', 'a = é', 'é = 1', 'a = "é"\nb = "😀"', '😀 = 1', 'a = "😀" x',
    '﻿a = 1', 'a = 1\n\n\n[b]\n', 'a = 1\r\n[b]\r\nc = 2', 'x = [\n  1,\n  2,\n]\n', 'a.b = 1\n[a]', 'a.b = 1\n[a.c]',
    '[a.b]\nx=1\n[a]\ny=2', '[a]\nb.c = 1\n[a.b]', '[a]\nb.c = 1\n[a.b.d]', 'a = 1\na = 2', 'a = 1\n[a]', '[a]\n[a.b]\n[a]',
    '[a.b.c]\n[a]\n[a.b]', '[[a.b]]\n[a]', 'a = [{b = 1}]\n[[a]]', 'a = [{b = 1}]\n[a.b]', '[t]\na=[[1,2],[3]]',
    '[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n[mcp_servers.lcu.tools.js]\napproval_mode = "approve"\n',
    '[hooks]\nStop = [{ hooks = [{ type = "mcp_tool", server = "lcu", tool = "turn_ended", input = { session_id = "s", turn_id = "t" } }] }]\n',
    '[hooks.state."/a b/c.toml:stop:0:0"]\ntrusted_hash = "sha256:abc"\n', 'profile = "x"', 'a = " "', "a = '\x1f'",
    'a = 1\x0b', 'a = 1\f', '\t[a]\t\n\tb = 1\t# c', 'a=1#c', 'a = "x"#c\nb=1', '[ a . b ]\nc = 1', 'a . b = 1',
    'a = 9223372036854775808', 'a = -9223372036854775809', 'a = 0xFFFFFFFFFFFFFFFFFFFF', 'a = 1e400', 'a = 0e0',
    'a = 1.0e+2', 'a = infinity', 'a = nan1', 'a = inf1', 'a = [inf, nan]', 'a = {inf = nan}',
]

ALPHABET = list('ab1_.-=[]{}", \n\t#\'\\') + ['é', '😀', '"""', "'''", '\r\n', 'true', '0x', '1979-05-27', 'T07:32:00', 'Z',
                                              '\\u00e9', '[[', ']]', ' = ', 'a.b', '\x00', '\x7f']


def fuzz(seed, count, max_len=12):
    rng = random.Random(seed)
    return [''.join(rng.choice(ALPHABET) for _ in range(rng.randint(0, max_len))) for _ in range(count)]


def mutate(seed, count):
    rng = random.Random(seed)
    out = []
    for _ in range(count):
        text = list(rng.choice(FIXED))
        for _ in range(rng.randint(1, 3)):
            if text and rng.random() < 0.5:
                del text[rng.randrange(len(text))]
            else:
                text.insert(rng.randint(0, len(text)), rng.choice(ALPHABET))
        out.append(''.join(text))
    return out


class TomlTests(NodeTestCase):
    def test_fixed_and_fuzzed_documents_match_tomllib(self):
        cases = FIXED + mutate(1, 4000) + fuzz(2, 4000)
        got = run_node(NODE_SIDE, cases)
        for case, have in zip(cases, got):
            self.assertEqual(have, oracle(case), repr(case))

    def test_decimal_integer_digit_limit(self):
        cases = ['a = ' + '1' * 4300, 'a = ' + '1' * 4301, 'a = -' + '1' * 4301, 'a = +' + '1' * 4300,
                 'a = ' + '1_' * 4299 + '1', 'a = ' + '1_' * 4300 + '1', 'a = 0x' + 'f' * 3000, 'a = 0o' + '7' * 4400,
                 'a = 0b' + '1' * 9000, 'a = 1' + '0' * 4400 + '.0', 'a = [1, ' + '2' * 4301 + ']']

        def py(text):
            try:
                return {'ok': tag(tomllib.loads(text))}
            except ValueError as exc:  # TOMLDecodeError or int()'s plain ValueError
                return {'error': f'{type(exc).__name__}: {exc}'}
        got = run_node(NODE_SIDE, cases)
        for case, have in zip(cases, got):
            self.assertEqual(have, py(case), case[:20])
        self.assertEqual(py(cases[1])['error'], 'ValueError: Exceeds the limit (4300 digits) for integer string '
                         'conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit')

    def test_error_columns_count_code_points(self):
        cases = ['a = "😀" ?', 'é = 1\n😀 = ?', '😀 = ?']
        got = run_node(NODE_SIDE, cases)
        for case, have in zip(cases, got):
            self.assertEqual(have, oracle(case), repr(case))


class Utf8Tests(NodeTestCase):
    def test_strict_decode_errors_match(self):
        rng = random.Random(7)
        pieces = [b'a', b'\xc3\xa9', b'\xe2\x82\xac', b'\xf0\x9f\x98\x80', b'\xff', b'\xc0', b'\xc3', b'\xe2\x82',
                  b'\xf0\x9f\x98', b'\xed\xa0\x80', b'\xe0\x80\x80', b'\xf4\x90\x80\x80', b'\x80', b'\xf8', b'\xef\xbb\xbf',
                  b'\xe2\x28\xa1', b'\xf0\x28\x8c\xbc']
        cases = [b''.join(rng.choice(pieces) for _ in range(rng.randint(0, 5))) for _ in range(3000)]

        def py(data):
            try:
                return {'ok': data.decode()}
            except UnicodeDecodeError as exc:
                return {'error': str(exc)}
        got = run_node("""
const m = await import(COMPAT + 'utf8.mjs');
emit(input.map((hex) => { try { return { ok: m.decode(Buffer.from(hex, 'hex')) }; } catch (e) { return { error: e.message }; } }));
""", [case.hex() for case in cases])
        for case, have in zip(cases, got):
            self.assertEqual(have, py(case), repr(case))


def windows_which(cmd, path, env, files):
    """CPython 3.12's shutil.which run with its Windows branch: ntpath, ';', PATHEXT, the current-directory
    rule of NeedCurrentDirectoryForExePath (searched unless NoDefaultCurrentDirectoryInExePath is set)."""
    import ntpath
    import types
    from unittest import mock
    fake_os = types.SimpleNamespace(
        path=ntpath, pathsep=';', curdir='.', defpath='.;C:\\bin', F_OK=os.F_OK, X_OK=os.X_OK,
        environ=env, getenv=env.get, fsdecode=lambda x: x, fsencode=lambda x: x.encode())
    with mock.patch.object(shutil, 'os', fake_os), \
         mock.patch.object(shutil, 'sys', types.SimpleNamespace(platform='win32')), \
         mock.patch.object(shutil, '_win_path_needs_curdir',
                           lambda cmd, mode: 'NoDefaultCurrentDirectoryInExePath' not in env), \
         mock.patch.object(shutil, '_access_check', lambda fn, mode: fn in files):
        return shutil.which(cmd, path=path)


class WhichTests(NodeTestCase):
    # shutil.which's Windows branch changed within 3.12 (PATHEXT/direct-match rules); the oracle is the baseline
    # interpreter LCU's Python implementation was verified with (3.12.9/3.12.10), not older 3.12 patch releases.
    @unittest.skipIf(sys.version_info < (3, 12, 9), 'Windows which() oracle needs CPython >= 3.12.9')
    def test_which_windows_branch_matches_shutil(self):
        files = ['.\\codex.EXE', 'C:\\apps\\codex.exe', 'C:\\bin\\tool.CMD', 'D:\\x\\omp.exe', 'C:\\bin\\plain',
                 '.\\local.bat', 'C:/fwd/hermes.EXE']
        envs = [{}, {'PATH': 'C:\\bin;D:\\x'}, {'PATH': ''}, {'NoDefaultCurrentDirectoryInExePath': '1', 'PATH': 'C:\\bin'},
                {'PATHEXT': '.EXE;.CMD;', 'PATH': 'C:\\bin;c:\\BIN\\'}, {'PATH': 'C:\\fwd'}]
        cmds = ['codex', 'C:\\apps\\codex.exe', 'C:\\apps\\codex', 'tool', 'omp', 'plain', 'local', 'hermes',
                'C:/fwd/hermes', 'D:x\\omp.exe', '\\\\srv\\share\\codex', 'missing']
        cases = [[cmd, path, env] for cmd in cmds for env in envs for path in (None, 'C:\\bin', ';')]
        expected = [windows_which(cmd, path, env, set(files)) for cmd, path, env in cases]
        got = run_node("""
const m = await import(COMPAT + 'which.mjs');
const files = new Set(input.files);
emit(input.cases.map(([cmd, path, env]) => m.which(cmd, path, env, { platform: 'win32', check: (n) => files.has(n) })));
""", {'files': files, 'cases': cases})
        for case, want, have in zip(cases, expected, got):
            self.assertEqual(have, want, repr(case))
        self.assertIn('.\\codex.EXE', expected)
        self.assertIn('C:\\apps\\codex.exe', expected)

    def test_which_matches_shutil(self):
        with tempfile.TemporaryDirectory() as raw:
            root = os.path.realpath(raw)
            for name, mode in (('a/tool', 0o755), ('b/tool', 0o755), ('c/tool', 0o644), ('d/other', 0o755)):
                path = os.path.join(root, name)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path, 'w').close()
                os.chmod(path, mode)
            os.makedirs(os.path.join(root, 'e/tool'))
            paths = [
                os.pathsep.join(os.path.join(root, d) for d in ('c', 'a', 'b')),
                os.pathsep.join(os.path.join(root, d) for d in ('e', 'c', 'd')),
                os.path.join(root, 'a') + os.pathsep + os.path.join(root, 'a'),
                '', os.pathsep, os.path.join(root, 'zzz'), os.path.join(root, 'a') + '/',
            ]
            cmds = ['tool', 'other', 'missing', os.path.join(root, 'a/tool'), os.path.join(root, 'c/tool'),
                    os.path.join(root, 'e/tool'), os.path.join(root, 'a') + '/tool']
            cases = [[cmd, path] for cmd in cmds for path in paths]
            expected = [shutil.which(cmd, path=path) for cmd, path in cases]
            got = run_node("""
const m = await import(COMPAT + 'which.mjs');
emit(input.map(([cmd, path]) => m.which(cmd, path)));
""", cases)
            self.assertEqual(got, expected)
            previous = os.getcwd()
            os.chdir(root)
            try:
                self.assertEqual(run_node("const m = await import(COMPAT + 'which.mjs'); emit(m.which('tool', ':a'));"),
                                 shutil.which('tool', path=':a'))
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
