"""`lcu origins`: list and forget saved Chrome site decisions, against a temporary CODEX_HOME."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lcu import origins, runtime

SAMPLE = '[origins]\nallowed = ["https://ok.example"]\ndenied = ["https://bad.example", "http://localhost:3000"]\n'


class OriginsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name) / 'codex'
        self.sessions = self.home / 'browser' / 'sessions'
        self.env = {'CODEX_HOME': str(self.home)}
        self.addCleanup(self.temporary.cleanup)

    def session(self, name, text=SAMPLE):
        self.sessions.mkdir(parents=True, exist_ok=True)
        path = self.sessions / f'{name}.toml'
        path.write_text(text, encoding='utf-8')
        return path

    def files(self):
        return sorted(p.name for p in self.sessions.iterdir() if p.name != origins.LOCK_NAME)

    def run_origins(self, *argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                origins.main(list(argv), env=self.env if env is None else env)
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    def state(self, name):
        return origins.parse(( self.sessions / f'{name}.toml').read_bytes(), name)[1]

    # list ----------------------------------------------------------------------------------

    def test_list_shows_every_session(self):
        self.session('abc')
        self.session('agent-2', '[origins]\ndenied = ["https://x.example"]\n')
        code, out, _ = self.run_origins('list')
        self.assertEqual(code, 0)
        self.assertIn('session abc', out)
        self.assertIn('allowed https://ok.example', out)
        self.assertIn('denied  http://localhost:3000', out)
        self.assertIn('session agent-2', out)

    def test_list_defaults_when_no_subcommand_and_supports_json(self):
        self.session('abc')
        code, out, _ = self.run_origins('--json')
        document = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(document['codexHome'], str(self.home))
        self.assertEqual(document['sessions'], [{
            'session': 'abc', 'file': str(self.sessions / 'abc.toml'), 'allowed': ['https://ok.example'],
            'denied': ['https://bad.example', 'http://localhost:3000']}])
        self.assertEqual(document['problems'], [])

    def test_list_one_session(self):
        self.session('abc')
        self.session('other', '[origins]\ndenied = ["https://x.example"]\n')
        code, out, _ = self.run_origins('list', '--session', 'other')
        self.assertEqual(code, 0)
        self.assertIn('https://x.example', out)
        self.assertNotIn('ok.example', out)

    def test_list_with_nothing_saved(self):
        for env in (self.env, {'CODEX_HOME': str(self.home / 'missing')}):
            code, out, _ = self.run_origins('list', env=env)
            self.assertEqual((code, 'No saved Chrome site decisions' in out), (0, True))
        self.sessions.mkdir(parents=True)
        self.session('empty', '[origins]\nallowed = []\ndenied = []\n')
        self.assertIn('No saved', self.run_origins('list')[1])

    def test_list_skips_unreadable_session_but_reports_it(self):
        self.session('good')
        self.session('broken', 'not = [valid')
        code, out, err = self.run_origins('list')
        self.assertEqual(code, 0)
        self.assertIn('session good', out)
        self.assertIn('broken.toml', err)
        document = json.loads(self.run_origins('list', '--json')[1])
        self.assertEqual([p['session'] for p in document['problems']], ['broken'])
        code, _, err = self.run_origins('list', '--session', 'broken')
        self.assertEqual(code, 1)
        self.assertIn('not valid TOML', err)

    def test_list_ignores_files_that_are_not_session_files(self):
        self.session('abc')
        (self.sessions / 'notes.txt').write_text('x')
        self.session('has space')
        self.session('.hidden')
        sessions = json.loads(self.run_origins('list', '--json')[1])['sessions']
        self.assertEqual([entry['session'] for entry in sessions], ['abc'])

    def test_list_rejects_wrongly_shaped_origins(self):
        for text in ('origins = 3\n', '[origins]\ndenied = "https://x.example"\n', '[origins]\ndenied = [1]\n'):
            path = self.session('odd', text)
            code, _, err = self.run_origins('list', '--session', 'odd')
            self.assertEqual(code, 1, text)
            self.assertIn('leaving it untouched', err)
            self.assertEqual(path.read_text(), text)

    # forget --------------------------------------------------------------------------------

    def test_forget_removes_only_the_denied_origin_by_default(self):
        path = self.session('abc')
        code, out, _ = self.run_origins('forget', 'http://localhost:3000')
        self.assertEqual(code, 0)
        self.assertIn('Removed http://localhost:3000 from denied in session abc.', out)
        self.assertIn('5 minutes', out)
        self.assertEqual(self.state('abc'), {'allowed': ['https://ok.example'], 'denied': ['https://bad.example']})
        self.assertEqual(path.read_text(), '[origins]\nallowed = ["https://ok.example"]\ndenied = ["https://bad.example"]\n')

    def test_forget_never_touches_allowed_unless_asked(self):
        self.session('abc')
        code, out, _ = self.run_origins('forget', 'https://ok.example')
        self.assertEqual(code, 0)
        self.assertIn('nothing changed', out)
        self.assertNotIn('5 minutes', out)
        self.assertEqual(self.state('abc')['allowed'], ['https://ok.example'])
        self.run_origins('forget', 'https://ok.example', '--allowed')
        self.assertEqual(self.state('abc'), {'allowed': [], 'denied': ['https://bad.example', 'http://localhost:3000']})

    def test_forget_both_lists(self):
        self.session('abc', '[origins]\nallowed = ["https://a.example"]\ndenied = ["https://a.example"]\n')
        self.run_origins('forget', 'https://a.example', '--allowed', '--denied')
        self.assertEqual(self.state('abc'), {'allowed': [], 'denied': []})

    def test_forget_normalizes_origin_and_stored_entries(self):
        self.session('abc', '[origins]\ndenied = ["HTTPS://Bad.Example:443", "https://bad.example"]\n')
        code, out, _ = self.run_origins('forget', 'https://BAD.example/')
        self.assertEqual(code, 0)
        self.assertIn('Removed 2 entries for https://bad.example from denied', out)
        self.assertEqual(self.state('abc')['denied'], [])

    def test_forget_defaults_to_every_session_and_all_sessions_flag_matches(self):
        for name in ('one', 'two'):
            self.session(name)
        self.session('three', '[origins]\ndenied = ["https://other.example"]\n')
        for flag in ([], ['--all-sessions']):
            for name in ('one', 'two'):
                self.session(name)
            code, out, _ = self.run_origins('forget', 'https://bad.example', *flag)
            self.assertEqual(code, 0)
            self.assertEqual(self.state('one')['denied'], ['http://localhost:3000'])
            self.assertEqual(self.state('two')['denied'], ['http://localhost:3000'])
            self.assertEqual(self.state('three')['denied'], ['https://other.example'])

    def test_forget_one_session_leaves_the_others(self):
        self.session('one')
        self.session('two')
        code, _, _ = self.run_origins('forget', 'https://bad.example', '--session', 'two')
        self.assertEqual(code, 0)
        self.assertEqual(self.state('one')['denied'], ['https://bad.example', 'http://localhost:3000'])
        self.assertEqual(self.state('two')['denied'], ['http://localhost:3000'])

    def test_forget_preserves_other_keys_and_tables(self):
        text = ('version = 2\nname = "agent"\n\n[origins]\nallowed = ["https://ok.example"]\n'
                'denied = ["https://bad.example"]\nnote = "kept"\nflag = true\n\n[other]\nitems = ["a", "b"]\n')
        path = self.session('abc', text)
        self.run_origins('forget', 'https://bad.example')
        document = origins.tomllib.loads(path.read_text())
        self.assertEqual(document, {'version': 2, 'name': 'agent', 'origins': {
            'allowed': ['https://ok.example'], 'denied': [], 'note': 'kept', 'flag': True},
            'other': {'items': ['a', 'b']}})

    def test_forget_keeps_special_characters_and_file_mode(self):
        text = '[origins]\ndenied = ["https://bad.example"]\n"odd key" = "caf\\u00e9 \\"quoted\\" \\\\"\n'
        path = self.session('abc', text)
        if os.name == 'posix':
            path.chmod(0o640)
        before = origins.tomllib.loads(text)
        self.run_origins('forget', 'https://bad.example')
        before['origins']['denied'] = []
        self.assertEqual(origins.tomllib.loads(path.read_text(encoding='utf-8')), before)
        if os.name == 'posix':
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.files(), ['abc.toml'])

    def test_forget_leaves_unknown_structures_untouched(self):
        cases = {
            'comment': '# written by hand\n[origins]\ndenied = ["https://bad.example"]\n',
            'inline comment': '[origins]\ndenied = ["https://bad.example"] # keep\n',
            'nested table': '[origins]\ndenied = ["https://bad.example"]\n[origins.extra]\nx = 1\n',
            'float': 'ratio = 1.5\n[origins]\ndenied = ["https://bad.example"]\n',
            'date': 'at = 2026-10-06\n[origins]\ndenied = ["https://bad.example"]\n',
            'array of tables': '[[history]]\nurl = "x"\n[origins]\ndenied = ["https://bad.example"]\n',
            'multi-line string': 'note = """a\nb"""\n[origins]\ndenied = ["https://bad.example"]\n',
        }
        for name, text in cases.items():
            with self.subTest(name):
                path = self.session('abc', text)
                code, out, err = self.run_origins('forget', 'https://bad.example', '--session', 'abc')
                self.assertEqual(code, 1)
                self.assertIn('leaving it untouched', err)
                self.assertNotIn('5 minutes', out)
                self.assertEqual(path.read_text(), text)
                self.assertEqual(self.files(), ['abc.toml'])

    def test_hash_inside_a_string_is_not_a_comment(self):
        path = self.session('abc', '[origins]\ndenied = ["https://bad.example", "https://a.example/#x"]\n')
        code, _, _ = self.run_origins('forget', 'https://bad.example')
        self.assertEqual(code, 0)
        self.assertEqual(self.state('abc')['denied'], ['https://a.example/#x'])
        self.assertIn('#x', path.read_text())

    def test_bad_file_does_not_block_the_others_but_fails_the_run(self):
        self.session('good')
        broken = self.session('broken', '# note\n[origins]\ndenied = ["https://bad.example"]\n')
        code, out, err = self.run_origins('forget', 'https://bad.example')
        self.assertEqual(code, 1)
        self.assertIn('broken.toml', err)
        self.assertEqual(self.state('good')['denied'], ['http://localhost:3000'])
        self.assertTrue(broken.read_text().startswith('# note'))
        self.assertIn('5 minutes', out)

    def test_forget_refuses_symbolic_links(self):
        if os.name != 'posix':
            self.skipTest('symbolic links need POSIX here')
        real = self.session('real')
        link = self.sessions / 'linked.toml'
        link.symlink_to(real)
        code, _, err = self.run_origins('forget', 'https://bad.example', '--session', 'linked')
        self.assertEqual(code, 1)
        self.assertIn('symbolic link', err)
        self.assertEqual(real.read_text(), SAMPLE)

    def test_forget_retries_when_the_runtime_writes_in_between(self):
        path = self.session('abc')
        runtime_write = '[origins]\nallowed = ["https://new.example"]\ndenied = ["https://bad.example", "https://late.example"]\n'
        real = origins.write_atomically
        calls = []

        def racing(target, text, mode):
            temporary = real(target, text, mode)
            if not calls:
                calls.append(1)
                target.write_text(runtime_write)
            return temporary

        with mock.patch.object(origins, 'write_atomically', racing):
            code, _, _ = self.run_origins('forget', 'https://bad.example')
        self.assertEqual(code, 0)
        self.assertEqual(self.state('abc'), {'allowed': ['https://new.example'], 'denied': ['https://late.example']})
        self.assertEqual(self.files(), ['abc.toml'])
        self.assertEqual(path.read_text().count('late.example'), 1)

    def test_forget_reports_a_runtime_write_that_lands_after_the_replace(self):
        self.session('abc')
        real = origins.os.replace

        def late(source, target):
            real(source, target)
            Path(target).write_text('[origins]\ndenied = ["https://late.example"]\n')

        with mock.patch.object(origins.os, 'replace', late):
            code, out, err = self.run_origins('forget', 'https://bad.example', '--session', 'abc')
        self.assertEqual(code, 1)
        self.assertIn('original runtime changed', err)
        self.assertNotIn('5 minutes', out)

    def test_concurrent_forgets_are_serialized(self):
        path = self.session('abc', '[origins]\nallowed = ["https://a.example", "https://b.example"]\n')
        paused, release, second_done = threading.Event(), threading.Event(), threading.Event()
        real = origins.write_atomically
        errors = []

        def pausing(target, text, mode):
            temporary = real(target, text, mode)
            paused.set()
            release.wait(10)
            return temporary

        def first():
            try:
                with mock.patch.object(origins, 'write_atomically', pausing):
                    origins.forget_in(path, 'https://a.example', ('allowed',))
            except Exception as exc:  # reported through the assertion below
                errors.append(exc)

        def second():
            try:
                origins.forget_in(path, 'https://b.example', ('allowed',))
            except Exception as exc:
                errors.append(exc)
            second_done.set()

        one = threading.Thread(target=first)
        one.start()
        self.assertTrue(paused.wait(10))
        two = threading.Thread(target=second)
        two.start()
        self.assertFalse(second_done.wait(0.3), 'the second command ran while the first held the lock')
        release.set()
        one.join(10)
        two.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(self.state('abc')['allowed'], [])

    def test_lock_gives_up_when_it_stays_held(self):
        self.session('abc')
        with origins.locked(self.sessions):
            with self.assertRaises(origins.OriginsError) as caught:
                with origins.locked(self.sessions, wait=0.2):
                    pass
        self.assertIn('another `lcu origins` command', str(caught.exception))
        with origins.locked(self.sessions, wait=0.2):
            pass

    def test_lock_file_is_not_a_session(self):
        self.session('abc')
        self.run_origins('forget', 'https://bad.example')
        self.assertTrue((self.sessions / origins.LOCK_NAME).exists())
        sessions = json.loads(self.run_origins('list', '--json')[1])['sessions']
        self.assertEqual([entry['session'] for entry in sessions], ['abc'])

    def test_forget_gives_up_when_the_file_never_settles(self):
        path = self.session('abc')
        real = origins.write_atomically

        counter = []

        def racing(target, text, mode):
            temporary = real(target, text, mode)
            counter.append(1)
            target.write_text(f'[origins]\ndenied = ["https://bad.example", "https://n{len(counter)}.example"]\n')
            return temporary

        with mock.patch.object(origins, 'write_atomically', racing):
            code, _, err = self.run_origins('forget', 'https://bad.example', '--session', 'abc')
        self.assertEqual(code, 1)
        self.assertIn('kept changing', err)
        self.assertIn('bad.example', path.read_text())
        self.assertEqual(self.files(), ['abc.toml'])

    def test_forget_with_nothing_saved(self):
        code, out, _ = self.run_origins('forget', 'https://bad.example')
        self.assertEqual(code, 0)
        self.assertIn('nothing changed', out)
        self.assertFalse(self.home.exists())

    # validation ----------------------------------------------------------------------------

    def test_bad_session_ids_are_rejected(self):
        for name in ('../x', 'a/b', 'a\\b', '', 'x' * 129, 'a b', 'é', 'abc\n'):
            for argv in (('list', '--session', name), ('forget', 'https://a.example', '--session', name)):
                with self.subTest(name=name, argv=argv[0]):
                    code, _, err = self.run_origins(*argv)
                    self.assertEqual(code, 1)
                    self.assertIn('not a session id', err)
        self.assertEqual(origins.check_session_id('x' * 128), 'x' * 128)
        self.assertEqual(origins.check_session_id('A_b-9'), 'A_b-9')

    def test_missing_named_session_is_an_error(self):
        self.session('abc')
        code, _, err = self.run_origins('forget', 'https://bad.example', '--session', 'nope')
        self.assertEqual(code, 1)
        self.assertIn('no saved site decisions for session nope', err)

    def test_invalid_origins_are_rejected_before_any_change(self):
        path = self.session('abc')
        for value in ('example.com', 'localhost:3000', 'ftp://a.example', 'https://a.example/path',
                      'https://a.example?x=1', 'https://a.example#x', 'https://user@a.example', 'https://',
                      'https://a b.example', 'https://a.example:99999', '*', '', 'https://bücher.de',
                      'https://faß.de', 'http://0x7f.1', 'http://127.1', 'http://2130706433', 'http://[::g]'):
            with self.subTest(value=value):
                code, _, err = self.run_origins('forget', value)
                self.assertEqual(code, 1)
                self.assertEqual(path.read_text(), SAMPLE)

    def test_origin_normalization(self):
        cases = {'https://Example.com': 'https://example.com', 'https://example.com:443/': 'https://example.com',
                 'http://example.com:80': 'http://example.com', 'http://localhost:3000': 'http://localhost:3000',
                 'https://example.com:8443': 'https://example.com:8443', 'http://[::1]:8080': 'http://[::1]:8080',
                 'https://xn--bcher-kva.de': 'https://xn--bcher-kva.de', ' https://a.example ': 'https://a.example',
                 'http://[2001:DB8:0:0::1]:81': 'http://[2001:db8::1]:81', 'https://127.0.0.1': 'https://127.0.0.1'}
        for value, expected in cases.items():
            self.assertEqual(origins.normalize_origin(value), expected, value)

    def test_forget_requires_one_scope(self):
        code, _, err = self.run_origins('forget', 'https://a.example', '--session', 'a', '--all-sessions')
        self.assertEqual(code, 2)
        self.assertIn('not allowed with', err)

    # CODEX_HOME ----------------------------------------------------------------------------

    def test_codex_home_resolution(self):
        self.assertEqual(origins.codex_home({'CODEX_HOME': str(self.home)}, windows=False), self.home)
        self.assertEqual(runtime.default_codex_home({'USERPROFILE': 'C:\\Users\\a', 'HOME': '/x'}, True),
                         'C:\\Users\\a\\.codex')
        self.assertEqual(runtime.default_codex_home({'HOME': 'C:\\h'}, True), 'C:\\h\\.codex')

    @unittest.skipUnless(os.name == 'posix', 'POSIX path semantics')
    def test_default_codex_home_on_posix(self):
        self.assertEqual(origins.codex_home({'HOME': '/home/a'}, windows=False), Path('/home/a/.codex'))
        self.assertEqual(origins.codex_home({'HOME': '//home/a'}, windows=False), Path('/home/a/.codex'))

    def test_empty_or_relative_codex_home_is_rejected(self):
        for value in ('', 'relative/dir'):
            code, _, err = self.run_origins('list', env={'CODEX_HOME': value})
            self.assertEqual(code, 1)
            self.assertIn('CODEX_HOME', err)

    def test_default_home_is_dot_codex_in_the_home_directory(self):
        with mock.patch.object(origins, 'default_codex_home', return_value=str(self.home)) as chosen:
            code, out, _ = self.run_origins('list', env={})
        self.assertEqual(code, 0)
        chosen.assert_called_once()
        self.assertIn('No saved', out)

    # runtime dispatch ----------------------------------------------------------------------

    def test_runtime_dispatches_origins(self):
        self.session('abc')
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {'CODEX_HOME': str(self.home)}):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                runtime.main(ROOT, ['origins', 'forget', 'https://bad.example'])
                runtime.main(ROOT, ['origins'])
        self.assertIn('Removed https://bad.example from denied in session abc.', out.getvalue())
        self.assertIn('denied  http://localhost:3000', out.getvalue())
        self.assertNotIn('bad.example"', out.getvalue().split('Removed', 1)[1])

    def test_runtime_usage_lists_origins(self):
        self.assertIn('lcu origins forget ORIGIN', runtime.USAGE)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            runtime.main(ROOT, ['--help'])
        self.assertIn('lcu origins', out.getvalue())


if __name__ == '__main__':
    unittest.main()
