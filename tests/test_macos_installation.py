"""Exercise macOS selection without changing or executing an application."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

if sys.platform == 'win32':
    raise unittest.SkipTest('macOS installer')

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import install_macos
from bundle import seal, verify


class MacInstallationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        self.app = self.base / 'ChatGPT.app'
        self.app.mkdir()
        (self.app / 'preserve').write_bytes(b'original signed application')
        (self.source / 'runtime.lock.json').write_text(json.dumps({'platforms': {'darwin': {
            'version': 'fixture', 'runtime': 'fixture-runtime',
            'architectures': {'arm64': {'components': {}}}}}}))
        seal(self.source, 'arm64', 'darwin')
        self.prefix = self.base / 'lcu'

    def _install(self):
        with patch('install_macos.SOURCE', self.source), \
             patch('install_macos.architecture', return_value='arm64'), \
             patch('install_macos.resolve_installed_mac_app', return_value=SimpleNamespace(
                 app=self.app, version='26.924.22138',
                 runtime_version='0.0.24/20260924074400-f52ea85e2a98', arch='arm64')):
            return install_macos.install(self.prefix, self.app)

    def test_reuses_app_in_place_and_records_observed_version_and_runtime(self):
        with patch('install.validate_release') as validate:
            release = self._install()
        self.assertEqual((self.prefix / 'current').resolve(), release)
        self.assertEqual((release / 'app').resolve(), self.app)
        self.assertEqual((self.app / 'preserve').read_bytes(), b'original signed application')
        descriptor = json.loads((release / 'installation.json').read_text())
        self.assertEqual(descriptor['platform'], 'darwin')
        self.assertEqual(descriptor['app'], str(self.app))
        self.assertEqual(descriptor['package_version'], '26.924.22138')
        self.assertEqual(descriptor['runtime'], '0.0.24/20260924074400-f52ea85e2a98')
        validate.assert_called_once_with(release, None)

    def test_invalid_application_fails_before_prefix_or_selection_changes(self):
        with patch('install_macos.SOURCE', self.source), \
             patch('install_macos.architecture', return_value='arm64'), \
             patch('install_macos.resolve_installed_mac_app', side_effect=ValueError('invalid application')):
            with self.assertRaisesRegex(ValueError, 'invalid application'):
                install_macos.install(self.prefix, self.app)
        self.assertFalse(self.prefix.exists())

    def test_missing_application_has_official_download_link_before_prefix_writes(self):
        missing = self.base / 'missing.app'
        with patch('install_macos.SOURCE', self.source), \
             patch('install_macos.architecture', return_value='arm64'), \
             patch('install_macos.resolve_installed_mac_app',
                   side_effect=AssertionError('app validation reached')):
            with self.assertRaisesRegex(ValueError, 'chatgpt.com/download/'):
                install_macos.install(self.prefix, missing)
        self.assertFalse(self.prefix.exists())

    def test_failed_validation_preserves_previous_selection(self):
        with patch('install.validate_release'):
            previous = self._install()
        with patch('install.validate_release', side_effect=ValueError('startup failed')):
            with self.assertRaisesRegex(ValueError, 'startup failed'):
                self._install()
        self.assertEqual((self.prefix / 'current').resolve(), previous)
        self.assertEqual(list((self.prefix / 'releases').iterdir()), [previous])
        self.assertEqual((self.app / 'preserve').read_bytes(), b'original signed application')

    def test_agent_setup_return_code_is_preserved_after_install(self):
        account = SimpleNamespace(pw_name='alice')
        completed = subprocess.CompletedProcess([], 7)
        with patch('install_macos.setup.validate', return_value=(account, ['codex'])), \
             patch('install_macos.install') as install, \
             patch('install_macos.subprocess.run', return_value=completed) as run, \
             patch('sys.stdout', io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                install_macos.main(['--prefix', str(self.prefix), '--existing-app', str(self.app),
                                    '--agent', 'codex', '--audio', '--yes'])
        self.assertEqual(raised.exception.code, 7)
        install.assert_called_once_with(self.prefix, self.app, account=account)
        self.assertEqual(run.call_args.args[0], [str(self.prefix / 'current/bin/lcu'), 'setup',
                         '--prefix', str(self.prefix), '--user', 'alice', '--scope', 'user',
                         '--session', 'direct', '--agent', 'codex', '--yes', '--audio'])
        self.assertIn('--audio', run.call_args.args[0])
        self.assertFalse(run.call_args.kwargs['check'])

    def test_bundle_rejects_the_other_platform(self):
        verify(self.source, 'arm64', 'darwin')
        with self.assertRaisesRegex(ValueError, 'manifest'):
            verify(self.source, 'arm64', 'linux')


if __name__ == '__main__':
    unittest.main()
