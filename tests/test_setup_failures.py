import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from lcu import setup


class ConfigureFailureTests(unittest.TestCase):
    def run_configure(self, names, cleanup, run):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home, tools, release = root / 'home', root / 'tools', root / 'release'
            for d in (home, tools, release / 'adapters'):
                d.mkdir(parents=True)
            for f in ('claude.mjs', 'codex.mjs', 'audio-files.mjs'):
                (release / 'adapters' / f).write_text('x')
            out, err = io.StringIO(), io.StringIO()
            with patch('lcu.setup.installer_paths', return_value=(tools / 'node', tools / 's.mjs', tools / 'm.mjs')), \
                 patch('lcu.setup.installed_app_resources', return_value=root / 'resources'), \
                 patch('lcu.setup.host_policy', return_value={}), patch('lcu.setup.preflight_mcp'), \
                 patch('lcu.setup.subprocess.run', side_effect=run) as sub, \
                 patch('lcu.setup.remove_old_skill', side_effect=cleanup), \
                 patch('lcu.codex_hooks.require_cli_hook_support'), patch('lcu.codex_hooks.install_hooks'), \
                 patch('lcu.claude_visibility.install'), patch('lcu.claude_mod.install', return_value=root / 'mod'), \
                 patch('lcu.app_layout.locate_codex_tools', return_value=SimpleNamespace(cli=root / 'codex')), \
                 redirect_stdout(out), redirect_stderr(err):
                failures = setup.configure(names, home, ['/opt/lcu/bin/lcu'], tools, release,
                                           environ={'HOME': str(home)})
            return failures, err.getvalue(), sub

    @staticmethod
    def ok(argv, **_):
        return SimpleNamespace(returncode=0, stdout=json.dumps({'path': '/x/config.toml'}), stderr='')

    def check_cleanup_is_warn_only(self, error):
        failures, err, sub = self.run_configure(['claude-code'], error, self.ok)
        self.assertEqual(failures, [])
        self.assertIn('Claude Code: skipped old LCU skill cleanup', err)
        self.assertEqual(sub.call_count, 1)

    def test_cleanup_value_error_only_warns(self):
        self.check_cleanup_is_warn_only(ValueError('boom'))

    def test_cleanup_unexpected_error_only_warns(self):
        self.check_cleanup_is_warn_only(TypeError('weird'))

    def test_unexpected_phase_error_is_recorded_and_next_harness_runs(self):
        calls = []

        def run(argv, **kw):
            calls.append(argv)
            if len(calls) == 1:
                raise KeyError('nope')
            return self.ok(argv)

        failures, err, _ = self.run_configure(['claude-code', 'codex'], lambda *a: 'none', run)
        self.assertEqual(failures, [('claude-code', 'MCP', "KeyError: 'nope'")])
        self.assertEqual(len(calls), 2)
        self.assertIn("MCP failed: KeyError: 'nope'", err)

    def test_codex_non_dict_output_is_a_failure_not_a_crash(self):
        for stdout in ('[]', '{}', 'null'):
            run = lambda argv, **_: SimpleNamespace(returncode=0, stdout=stdout, stderr='')
            failures, err, _ = self.run_configure(['codex'], lambda *a: 'none', run)
            self.assertEqual([f[:2] for f in failures], [('codex', 'MCP')])
            self.assertIn('unexpected output', failures[0][2])

    def test_keyboard_interrupt_is_not_swallowed(self):
        def run(argv, **_):
            raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.run_configure(['claude-code'], lambda *a: 'none', run)


if __name__ == '__main__':
    unittest.main()
