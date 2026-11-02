"""The Windows archive is thin and platform specific."""

import errno
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_bundle
from bundle import VERSION, architecture


class WindowsBuildTests(unittest.TestCase):
    def test_native_windows_amd64_name_selects_x64_archive(self):
        with mock.patch('bundle.platform.system', return_value='Windows'), \
             mock.patch('bundle.platform.machine', return_value='AMD64'):
            self.assertEqual(architecture('windows'), 'x64')

    def test_cross_built_windows_archive_omits_upstream_payload_and_node(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'dist'
            def fake_provision(release, _source, **options):
                self.assertEqual(options['target'], 'windows')
                (release / 'agent-tools/node_modules/skills').mkdir(parents=True)
                (release / 'agent-tools/node_modules/skills/package.json').write_text('{}')
            with mock.patch.object(build_bundle, 'provision_agents', side_effect=fake_provision):
                archive = build_bundle.build(output, target='windows')
            self.assertEqual(archive.name, f'lcu-{VERSION}-windows-x64.zip')
            with ZipFile(archive) as bundle:
                names = set(bundle.namelist())
                prefix = f'lcu-{VERSION}-windows-x64/'
                for name in ('bin/lcu.cmd', 'lcu/windows.mjs', 'lcu/windows_host.mjs', 'lcu/runtime.mjs',
                             'scripts/install.ps1', 'scripts/install_windows.mjs', 'scripts/install_windows.py',
                             'scripts/bundle.mjs', 'lcu/windows_host_analyze.cjs', 'lcu/vendor/acorn/acorn.js',
                             'lcu/claude_hook.mjs', 'lcu/claude_lifecycle.mjs',
                             'lcu/vendor/acorn/LICENSE',
                             'scripts/windows_launcher.mjs', 'bundle.json',
                             'docs/verification/codex-interactive-2026-09-24.md'):
                    self.assertIn(prefix + name, names)
                bundled_records = {name.removeprefix(prefix + 'docs/verification/') for name in names
                                   if name.startswith(prefix + 'docs/verification/')}
                # Only the transitively linked records ship; unlinked ones are dropped.
                linked = {path.name for path in build_bundle.linked_verification_records(ROOT)}
                self.assertEqual(bundled_records, linked)
                all_records = {path.name for path in (ROOT / 'docs/verification').glob('*.md')}
                self.assertTrue(linked < all_records)
                self.assertFalse(any(name.startswith(prefix + 'docs/verification/')
                                     and not name.endswith('.md') for name in names))
                manifest = json.loads(bundle.read(prefix + 'bundle.json'))
                self.assertEqual((manifest['platform'], manifest['architecture']), ('windows', 'x64'))
                self.assertFalse(any(name.startswith(prefix + 'app/') for name in names))
                self.assertFalse(any(name.endswith(('.exe', '.msix', '.node')) for name in names))
                for path in ('bin/lcu', 'bin/lcu-session', 'bin/lcu-codex-sandbox', 'lcu/session.mjs', 'lcu/x11.mjs', 'lcu/macos_host.mjs',
                             'scripts/install.sh', 'scripts/install.py', 'scripts/install.mjs', 'scripts/bundle.py'):
                    self.assertNotIn(prefix + path, names)

    def test_a_held_temporary_file_does_not_fail_the_build_or_reach_the_archive(self):
        # Antivirus can hold a file for a moment after npm exits; Windows then refuses the directory (WinError 145).
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tool = root / 'tool'
            tool.write_text('fixture')
            tool.chmod(0o755)
            real_rmtree = shutil.rmtree
            held = []

            def rmtree(path, *args, onexc=None, **options):
                if Path(path).name.startswith(('lcu-build-', '.agent-tools-')):
                    held.append(path)
                    try:
                        raise OSError(errno.ENOTEMPTY, 'directory not empty', path)
                    except OSError as error:
                        return onexc(os.rmdir, path, error)
                return real_rmtree(path, *args, onexc=onexc, **options)

            def fake_run(command, **options):
                if 'ci' in command:
                    directory = options['cwd']
                    for package, version in json.loads((directory / 'package.json').read_text())['dependencies'].items():
                        (directory / 'node_modules' / package).mkdir(parents=True)
                        (directory / 'node_modules' / package / 'package.json').write_text(
                            json.dumps({'version': version}))
                return SimpleNamespace(returncode=0)

            try:
                with mock.patch('shutil.rmtree', rmtree), \
                        mock.patch('shutil.which', return_value=str(tool)), \
                        mock.patch('subprocess.run', side_effect=fake_run), \
                        mock.patch('provision_agent_tools.download', side_effect=AssertionError('unexpected download')):
                    archive = build_bundle.build(root / 'dist', target='windows')
                self.assertEqual({Path(path).name[:10] for path in held}, {'lcu-build-', '.agent-too'})
                self.assertTrue(archive.with_suffix('.zip.sha256').is_file())
                with ZipFile(archive) as bundle:
                    self.assertFalse(any('.agent-tools-' in name for name in bundle.namelist()))
            finally:
                for path in held:
                    real_rmtree(path, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
