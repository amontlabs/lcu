"""The Windows archive is thin and platform specific. (The installer bridge, the dispatcher and the stable-release
selection are covered by tests/test_windows_bridge.py and tests/node/install_windows.test.mjs.)"""

import json
from pathlib import Path
import sys
import tempfile
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
                for name in ('bin/lcu.cmd', 'lcu/windows.mjs', 'lcu/windows_host.mjs', 'lcu/entry.mjs', 'lcu/compat/spawn.mjs',
                             'scripts/install_windows.py', 'scripts/install_windows.mjs', 'scripts/install.mjs',
                             'scripts/windows_launcher.py', 'scripts/windows_launcher.mjs', 'scripts/bundle.py',
                             'scripts/bundle_runtime.mjs', 'scripts/startup_env.mjs', 'bundle.json',
                             'lcu/windows_host_analyze.cjs', 'lcu/vendor/acorn/acorn.js', 'lcu/vendor/acorn/LICENSE',
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
                for path in ('bin/lcu', 'bin/lcu-session', 'lcu/session.mjs', 'lcu/linux_sky_service.mjs', 'scripts/install.sh',
                             'scripts/install.py', 'scripts/install_macos.py', 'scripts/install_macos.mjs'):
                    self.assertNotIn(prefix + path, names)



if __name__ == '__main__':
    unittest.main()
