"""Differential tests: lcu/compat/argparse.mjs against CPython's argparse on every real LCU parser.

For each parser (tests/compat/argparse_parsers.py builds the real ones, argparse_parsers.mjs is the JS twin) a few
hundred argv cases (hand-written edge cases, systematic option x value pairs, seeded random combinations) run in
both implementations at COLUMNS in {unset, 40, 80, 200}. The parsed namespace (as JSON), stdout, stderr and exit
status must be identical. Skipped when node is absent.
"""
import contextlib
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import argparse_parsers  # noqa: E402

import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
import support as _support  # noqa: E402  (one Node selector for every runner)
NODE = _support.selected_node()
COLUMNS = (None, '40', '80', '200')
ARGV0 = '/x/tool'

VALUES = [
    'x', '', '0', '3', '-3', ' 5 ', '1_0', '1__0', '+7', '٣', '१२', 'ü', '😀', 'a b', '--', '-', '-5', '-.5', '1.5',
    '9' * 20, '9' * 4301, '/tmp/x', 'a//b/', './a', '//a', '///a', '..', '~', 'chrome', 'edge', 'user', 'project',
    'ask', 'auto', 'discover', 'direct', 'all', 'SessionStart', 'UserPromptSubmit', 'linux', 'darwin', 'windows',
    'list', 'allow', 'revoke', 'install', 'status', 'serve', 'protocol', 'codex', 'claude-code', '--help', '-h',
    '=', 'a=b', '--user=bob', '-x', '--zzz', '-1', '--=', '-=', "it's", 'say "hi"', "both ' and \"", 'tab\there',
    'new\nline', '\x00'.replace('\x00', 'nul'), ' ', ' ', 'Zed', 'dev.zed.Zed', '/Applications/Foo.app',
]


# Review regressions (findings 1, 2, 5): Unicode decimal digits in every Nd block (adjacent mathematical blocks),
# negative Unicode numbers that must not become options, numeric choices, int boundaries, trailing newline.
NUMERIC_VALUES = [
    '\U0001d7da', '\U0001d7ce', '\U0001d7d8', '\U0001d7e2', '\U0001d7ec', '\U0001d7f6', '\U0001d7ff',
    '-\U0001d7da', '-٣', '-\uff13', '-３.５', '-٣.٥', '-.٥', '-1\n', '-1.5\n', '1\n', ' 2\n', '٢', '１２', '१_२', '-१_२', '१__२',
    '2', '-3', '1', '9007199254740993', '9007199254740992', '-9007199254740993', '9007199254740991', '-9007199254740991',
    '1152921504606846976', '٩٠٠٧١٩٩٢٥٤٧٤٠٩٩٣', '+2', '-0', '00', '0_0', '-_1', '\u2003 4 \u2003', '\x1c5', '\x855',
    '\u00a07', '\u00b2', '\u2460', '٣.٥', '-.5.5', '-3.', '-e', '-1e3',
]


def option_strings(parser, seen=None):
    seen = seen if seen is not None else []
    for action in parser._actions:
        seen.extend(action.option_strings)
        for sub in getattr(action, '_name_parser_map', {}).values():
            option_strings(sub, seen)
    return sorted(set(seen))


def subcommand_names(parser):
    names = []
    for action in parser._actions:
        names.extend(getattr(action, '_name_parser_map', {}).keys())
    return names


def abbreviations(options):
    out = []
    for option in options:
        if option.startswith('--'):
            for length in range(3, len(option)):
                out.append(option[:length])
    return out


def generate(name, parser):
    options = option_strings(parser)
    subs = subcommand_names(parser)
    abbreviated = abbreviations(options)
    cases = {(): None, ('-h',): None, ('--help',): None, ('--he',): None, ('-h', '--bogus'): None,
             ('--bogus',): None, ('--bogus', '-h'): None, ('--',): None, ('--', '--'): None, ('',): None,
             ('-',): None, ('-x',): None, ('-hx',): None, ('-h=x',): None, ('-xh',): None, ('--=',): None,
             ('--help=x',): None, ('--h=x',): None, ('-1',): None, ('--',) + ('x',): None,
             ('x', '--'): None, ('x', 'y', 'z'): None}
    for option in options:
        cases[(option,)] = None
        cases[(option + '=',)] = None
        cases[(option + '=x',)] = None
        cases[(option, '--')] = None
        cases[(option, '-h')] = None
        cases[('--', option)] = None
        for value in VALUES[:28] + NUMERIC_VALUES:
            cases[(option, value)] = None
            cases[(option + '=' + value,)] = None
    for abbreviation in abbreviated:
        cases[(abbreviation,)] = None
        cases[(abbreviation, 'x')] = None
        cases[(abbreviation + '=3',)] = None
    for sub in subs:
        cases[(sub,)] = None
        cases[(sub, '-h')] = None
        cases[(sub, '--help')] = None
        cases[(sub, 'x')] = None
        cases[(sub, 'x', 'y')] = None
        cases[(sub, '--')] = None
        cases[(sub, '--', 'x')] = None
        cases[('--', sub)] = None
        cases[(sub[:2],)] = None
        cases[(sub + 'x',)] = None
        for option in options:
            cases[(sub, option)] = None
            cases[(option, sub)] = None
            cases[(sub, option, 'x')] = None
    for value in NUMERIC_VALUES:
        cases[(value,)] = None
        cases[('--', value)] = None
        cases[(value, value)] = None
    pool = NUMERIC_VALUES + options + abbreviated + [o + '=' + v for o in options[:12] for v in ('x', '', '3')] + VALUES + subs * 3
    rng = random.Random(name)
    for _ in range(260):
        length = rng.choice([1, 2, 2, 3, 3, 4, 5, 6, 8])
        argv = tuple(rng.choice(pool) for _ in range(length))
        cases[argv] = None
    return [list(argv) for argv in cases]


def run_python(parser, hooks, argv):
    out, err = io.StringIO(), io.StringIO()
    ns = None
    code = 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                arguments = hooks.pre(parser, argv)
                args = parser.parse_args(arguments)
                hooks.post(parser, args)
                ns = json.dumps(vars(args), sort_keys=True, default=str)
            except SystemExit as exit_:
                code = exit_.code
    except Exception as exc:  # noqa: BLE001 - recorded so the JS side can be compared
        return {'exc': f'{type(exc).__name__}: {exc}', 'stdout': out.getvalue(), 'stderr': err.getvalue(), 'ns': None, 'code': None}
    return {'ns': ns, 'stdout': out.getvalue(), 'stderr': err.getvalue(), 'code': code}


class ArgparseDifferential(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE:
            raise unittest.SkipTest('node is not installed')
        cls.shared = argparse_parsers.shared_data()
        saved = (sys.argv[:], os.environ.get('COLUMNS'))
        sys.argv[0] = ARGV0
        try:
            cls.cases = []
            parsers = {}
            for name, (builder, hooks) in argparse_parsers.BUILDERS.items():
                parsers[name] = (builder(), hooks)
                for argv in generate(name, parsers[name][0]):
                    for columns in COLUMNS:
                        cls.cases.append({'parser': name, 'argv': argv, 'columns': columns})
            cls.python = []
            for case in cls.cases:
                if case['columns'] is None:
                    os.environ.pop('COLUMNS', None)
                else:
                    os.environ['COLUMNS'] = case['columns']
                parser, hooks = parsers[case['parser']]
                cls.python.append(run_python(parser, hooks, case['argv']))
        finally:
            sys.argv[:] = saved[0]
            if saved[1] is None:
                os.environ.pop('COLUMNS', None)
            else:
                os.environ['COLUMNS'] = saved[1]
        done = subprocess.run([NODE, str(HERE / 'argparse_runner.mjs')], input=json.dumps({'shared': cls.shared, 'cases': cls.cases}),
                              capture_output=True, text=True, timeout=120, env={k: v for k, v in os.environ.items() if k != 'COLUMNS'})
        if done.returncode:
            raise AssertionError(f'node runner failed: {done.stderr}')
        cls.node = json.loads(done.stdout)

    def compare(self, name):
        bad = []
        total = 0
        for case, expected, actual in zip(self.cases, self.python, self.node):
            if case['parser'] != name:
                continue
            total += 1
            if expected != actual:
                bad.append((case, expected, actual))
        self.assertGreater(total, 100, name)
        if bad:
            case, expected, actual = bad[0]
            self.fail(f'{name}: {len(bad)} of {total} cases differ; first: {json.dumps(case)}\n'
                      f'python: {json.dumps(expected, indent=1)}\nnode:   {json.dumps(actual, indent=1)}')

    def test_every_parser_has_a_test(self):
        self.assertEqual(set(argparse_parsers.BUILDERS), {
            'setup', 'apps', 'browser', 'doctor', 'session', 'prune', 'status', 'update', 'install', 'install_macos',
            'install_windows', 'provision', 'kitchen', 'kitchen2', 'numeric', 'negopt'})

    def test_cases_exercise_every_outcome(self):
        # Guard against a vacuous suite: successes, usage errors and help all occur, with real output.
        codes = {r['code'] for r in self.python}
        self.assertEqual(codes, {0, 2})
        self.assertTrue(any(r['stdout'].startswith('usage:') for r in self.python))
        self.assertTrue(any('error: ambiguous option' in r['stderr'] for r in self.python))
        self.assertTrue(any('invalid choice' in r['stderr'] for r in self.python))
        self.assertTrue(any('invalid int value' in r['stderr'] for r in self.python))
        self.assertTrue(any('the following arguments are required' in r['stderr'] for r in self.python))
        self.assertTrue(any('not allowed with argument' in r['stderr'] for r in self.python))
        self.assertTrue(any('ignored explicit argument' in r['stderr'] for r in self.python))
        self.assertTrue(any('unrecognized arguments' in r['stderr'] for r in self.python))
        self.assertTrue(any('expected one argument' in r['stderr'] for r in self.python))
        self.assertFalse(any('exc' in r for r in self.python))


def _make(name):
    def test(self):
        self.compare(name)
    test.__name__ = f'test_parser_{name}'
    return test


for _name in argparse_parsers.BUILDERS:
    setattr(ArgparseDifferential, f'test_parser_{_name}', _make(_name))


E2E_MODULE = r'''
import { ArgumentParser, REMAINDER, types } from '%(argparse)s';
import { namespaceJson } from '%(runner)s';
const parser = new ArgumentParser({ description: 'Probe %% with a long description that needs wrapping at narrow terminals to show the formatter.' });
parser.add_argument('--user', { required: true });
parser.add_argument('--n', { type: types.int, default: 2 });
parser.add_argument('--where', { type: types.Path });
parser.add_argument('-v', '--verbose', { action: 'count', default: 0 });
parser.add_argument('command', { nargs: REMAINDER });
process.stdout.write(namespaceJson(parser.parse_args()) + '\n');
'''

E2E_PY = '''
import argparse, json, sys
from pathlib import Path
parser = argparse.ArgumentParser(description='Probe %% with a long description that needs wrapping at narrow terminals to show the formatter.')
parser.add_argument('--user', required=True)
parser.add_argument('--n', type=int, default=2)
parser.add_argument('--where', type=Path)
parser.add_argument('-v', '--verbose', action='count', default=0)
parser.add_argument('command', nargs=argparse.REMAINDER)
ns = parser.parse_args()
print(json.dumps(vars(ns), sort_keys=True, default=str))
'''


class ArgparseProcessTest(unittest.TestCase):
    """Real process behaviour: default prog from argv[0], stdout/stderr file descriptors, exit status."""

    @classmethod
    def setUpClass(cls):
        if not NODE:
            raise unittest.SkipTest('node is not installed')
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        (base / 'py').mkdir()
        (base / 'js').mkdir()
        (base / 'py' / 'tool').write_text(E2E_PY.replace('%%', '%'), encoding='utf-8')
        module = base / 'js' / 'probe.mjs'
        module.write_text(E2E_MODULE % {'argparse': (HERE.parents[1] / 'lcu' / 'compat' / 'argparse.mjs').as_uri(), 'runner': (HERE / 'argparse_runner.mjs').as_uri()}, encoding='utf-8')
        (base / 'js' / 'tool').write_text(f'import({json.dumps(module.as_uri())});\n', encoding='utf-8')
        cls.py_tool = str(base / 'py' / 'tool')
        cls.js_tool = str(base / 'js' / 'tool')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_tool(self, command, argv, columns):
        env = {k: v for k, v in os.environ.items() if k not in ('COLUMNS', 'LINES')}
        if columns:
            env['COLUMNS'] = columns
        done = subprocess.run([*command, *argv], capture_output=True, env=env, timeout=30)
        return done.returncode, done.stdout.decode(), done.stderr.decode()

    def test_process_level_equivalence(self):
        cases = [[], ['-h'], ['--help'], ['--user', 'a'], ['--user', 'a', '--n', 'x'], ['--user=a', '--n=7', 'cmd', '--', '-x'],
                 ['--use', 'a', '-vvv', '--where', 'a//b/'], ['--user', 'a', '--bogus'], ['--us', 'b', '--u'], ['--n'],
                 ['--user', 'é😀', 'run', '-h'], ['-v', '--user', '--help']]
        for columns in (None, '30', '120'):
            for argv in cases:
                expected = self.run_tool([sys.executable, self.py_tool], argv, columns)
                actual = self.run_tool([NODE, self.js_tool], argv, columns)
                self.assertEqual(expected, actual, f'argv={argv} COLUMNS={columns}')

    def test_help_goes_to_stdout_and_errors_to_stderr_with_status_two(self):
        code, out, err = self.run_tool([NODE, self.js_tool], ['--help'], '80')
        self.assertEqual((code, bool(out), err), (0, True, ''))
        code, out, err = self.run_tool([NODE, self.js_tool], [], '80')
        self.assertEqual((code, out), (2, ''))
        self.assertTrue(err.startswith('usage: tool '))
        self.assertTrue(err.rstrip().endswith('tool: error: the following arguments are required: --user'))


class RuntimeHelpers(unittest.TestCase):
    """Direct checks of the Python-compat helpers the parser relies on (textwrap, repr, int)."""

    @classmethod
    def setUpClass(cls):
        if not NODE:
            raise unittest.SkipTest('node is not installed')

    def node(self, code, data):
        script = ("import * as a from " + json.dumps((HERE.parents[1] / 'lcu' / 'compat' / 'argparse.mjs').as_uri()) + ";\n"
                  "import { readFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\n" + code)
        done = subprocess.run([NODE, '--input-type=module', '-e', script], input=json.dumps(data), capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_textwrap_wrap_and_fill(self):
        import textwrap
        texts = ['', 'a', 'word ' * 30, 'a-very-long-hyphenated-word-that-does-not-fit well-known foo--bar --opt VALUE',
                 'x' * 100, 'élan vital ' * 7, 'He said "hello--world", then left; see https://example.com/some/long/path/segment?x=1',
                 'ab-' * 40, '-' * 50, 'tabs\tand\nnewlines\r\nhere ' * 4, '  leading and trailing  ', 'a. b? c! d' * 9,
                 ' nbsp words joined ' * 5, 'wide 😀😀😀😀 emoji 😀😀😀😀😀 line ' * 4]
        cases = [{'text': t, 'width': w} for t in texts for w in (11, 20, 37, 70)]
        got = self.node("process.stdout.write(JSON.stringify(input.map(c => a.textwrapWrap(c.text, c.width))));", cases)
        for case, lines in zip(cases, got):
            self.assertEqual(textwrap.wrap(case['text'], case['width']), lines, case)

    def test_repr_and_int(self):
        strings = ['', "a'b", 'a"b', "a'\"b", '\\', '\n\t\r', '\x00\x1f\x7f', 'é', '​', '­', '\ud800', '\U0010ffff', '😀', ' ', ' ']
        got = self.node("process.stdout.write(JSON.stringify(input.map(s => a.pyRepr(s))));", strings)
        self.assertEqual([repr(s) for s in strings], got)
        ints = ['\U0001d7da', '\U0001d7ce\U0001d7cf', '\U0001d7ff', '\U0001d7f5\U0001d7f6', '٠١٢٣٤٥٦٧٨٩', '０１２３４５６７８９',
                '-\U0001d7e3', '\u2003 5\u2003', '1\n', '5\x1f', '²', '9007199254740993', '-9007199254740993',
                '9007199254740992', '1_0_0', '0_', '٣_٤', '1' + '٣' * 3,
                '1', ' 12 ', '+3', '-4', '1_000', '_1', '1_', '1__0', '', ' ', '-', '+-1', '0x10', '1e3', '٣', '१२३', '1 2', '١٢٣٤٥٦٧٨٩٠', '9' * 4300, '9' * 4301, '0' * 5000 + '1', ' 5 ']
        got = self.node("process.stdout.write(JSON.stringify(input.map(s => { try { return String(a.pyInt(s)); } catch (e) { return 'ValueError'; } })));", ints)
        want = []
        for s in ints:
            try:
                want.append(str(int(s)))
            except ValueError:
                want.append('ValueError')
        self.assertEqual(want, got)

    def test_path_normalisation(self):
        paths = ['', '.', './', 'a', 'a/', 'a//b', './a', 'a/./b', '/', '//', '///', '//a', '///a', '////a//b/', '..', 'a/..', '/a/.', '~', 'é/😀']
        got = self.node("process.stdout.write(JSON.stringify(input.map(s => String(new a.PyPath(s)))));", paths)
        self.assertEqual([str(Path(p)) for p in paths], got)

    def test_python_columns_rule(self):
        for value in (None, '', '0', '-5', 'abc', ' 40 ', '1_0', '120'):
            env = {k: v for k, v in os.environ.items() if k != 'COLUMNS'}
            if value is not None:
                env['COLUMNS'] = value
            expected = int(subprocess.run([sys.executable, '-c', 'import shutil;print(shutil.get_terminal_size().columns)'],
                                          capture_output=True, text=True, env=env).stdout)
            actual = subprocess.run([NODE, '--input-type=module', '-e',
                                     'import * as a from ' + json.dumps((HERE.parents[1] / 'lcu' / 'compat' / 'argparse.mjs').as_uri())
                                     + ';process.stdout.write(String(a.getTerminalColumns()))'],
                                    capture_output=True, text=True, env=env).stdout
            self.assertEqual(str(expected), actual, value)


if __name__ == '__main__':
    unittest.main()
