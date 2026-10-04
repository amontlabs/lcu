"""The optional CLI probe must fail before installing unreadable hook config."""
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from lcu.codex_hooks import require_cli_hook_support


class CodexCliCapabilityTests(unittest.TestCase):
    def test_missing_cli_keeps_before_install_setup_available(self):
        with patch('lcu.codex_hooks.shutil.which', return_value=None), \
             patch('lcu.codex_hooks.subprocess.run') as run:
            require_cli_hook_support({'PATH': '/bin'})
            run.assert_not_called()

    def test_unsupported_cli_fails_with_isolated_no_auth_probe(self):
        calls = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
            self.assertEqual(kwargs['env']['HOME'], kwargs['env']['CODEX_HOME'])
            if argv[-1] == '--version':
                return subprocess.CompletedProcess(argv, 0, 'codex-cli 0.145.0\n', '')
            self.assertIn('mcp_tool', Path(kwargs['env']['CODEX_HOME'], 'config.toml').read_text())
            return subprocess.CompletedProcess(argv, 1, '', 'unknown variant mcp_tool')

        with patch('lcu.codex_hooks.shutil.which', return_value='/fixture/bin/codex'), \
             patch('lcu.codex_hooks.subprocess.run', side_effect=run):
            with self.assertRaisesRegex(ValueError, r'/fixture/bin/codex \(codex-cli 0\.145\.0\)') as failure:
                require_cli_hook_support({'PATH': '/fixture/bin', 'OPENAI_API_KEY': 'never-forward'})
        self.assertIn('npm install -g @openai/codex@latest', str(failure.exception))
        self.assertIn('lcu setup --agent codex', str(failure.exception))
        self.assertIn('unknown variant mcp_tool', str(failure.exception))
        self.assertEqual(len(calls), 2)

    def test_windows_systemroot_survives_isolated_probe(self):
        environments = []

        def run(argv, **kwargs):
            environments.append(kwargs['env'])
            return subprocess.CompletedProcess(argv, 0, 'codex-cli fixture\n', '')

        with patch('lcu.codex_hooks.shutil.which', return_value=r'C:\fixture\codex.exe'), \
             patch('lcu.codex_hooks.subprocess.run', side_effect=run):
            require_cli_hook_support({'PATH': r'C:\fixture', 'SYSTEMROOT': r'C:\Windows',
                                      'OPENAI_API_KEY': 'never-forward'})
        self.assertEqual(len(environments), 2)
        for child in environments:
            self.assertEqual(child['SYSTEMROOT'], r'C:\Windows')
            self.assertNotIn('OPENAI_API_KEY', child)

    def test_utf8_cli_output_is_read_under_a_legacy_windows_locale(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / 'codex-fixture'
            cli.write_text('#!' + sys.executable + '\n'
                           'import sys\n'
                           'sys.stdout.buffer.write(b"codex-cli \\xe2\\x80\\x8f fixture\\n")\n')
            cli.chmod(0o755)
            env = {'PATH': str(Path(sys.executable).parent)}
            if sys.platform == 'win32':
                # Windows runs no shebang scripts; a batch shim starts the same fixture.
                script, cli = cli, cli.with_suffix('.cmd')
                cli.write_text(f'@"{sys.executable}" "{script}" %*\r\n')
                env.update({key: os.environ[key] for key in ('SYSTEMROOT', 'COMSPEC', 'PATHEXT')
                            if key in os.environ})
            with patch('lcu.codex_hooks.shutil.which', return_value=str(cli)), \
                 patch('subprocess._text_encoding', return_value='cp1252'):
                require_cli_hook_support(env)


if __name__ == '__main__':
    unittest.main()
