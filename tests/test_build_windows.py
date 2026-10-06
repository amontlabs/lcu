"""Windows archive and stable-release selection are thin and platform specific."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_bundle
import install_windows
import windows_launcher
from bundle import VERSION, architecture
from lcu.windows import (WINDOWS_REQUIRED_FILES, application_inventory,
                         inventory_sha256)


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
                for name in ('bin/lcu.cmd', 'lcu/windows.py', 'scripts/install_windows.py',
                             'lcu/windows_host_analyze.cjs', 'lcu/vendor/acorn/acorn.js',
                             'lcu/vendor/acorn/LICENSE',
                             'scripts/windows_launcher.py', 'bundle.json',
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
                for path in ('bin/lcu-session', 'lcu/session.py', 'scripts/install.sh', 'scripts/install.py',
                             'scripts/installed_app.py'):
                    self.assertNotIn(prefix + path, names)

    def test_windows_launcher_rejects_pointer_escape_and_selects_versioned_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary).resolve()
            release = prefix / 'releases' / '0.3.0-123abc'
            (release / 'bin').mkdir(parents=True)
            (release / 'bin/lcu').write_text('fixture')
            (prefix / 'current.json').write_text(json.dumps({'release': release.name}))
            self.assertEqual(windows_launcher.selected_release(prefix), release)
            (prefix / 'current.json').write_text(json.dumps({'release': '../elsewhere'}))
            with self.assertRaisesRegex(ValueError, 'Invalid selected'):
                windows_launcher.selected_release(prefix)

    def test_installer_selects_registered_msix_before_mutating_prefix(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary).resolve() / 'install'
            with mock.patch.object(install_windows.platform, 'system', return_value='Windows'), \
                 mock.patch.object(install_windows, 'architecture', return_value='x64'), \
                 mock.patch.object(install_windows, 'verify'), \
                 mock.patch.object(install_windows, 'resolve_installed_windows_app',
                                   side_effect=ValueError('MSIX is not registered')):
                with self.assertRaisesRegex(ValueError, 'MSIX is not registered'):
                    install_windows.install(prefix)
            self.assertFalse(prefix.exists())

    def test_installed_launcher_reuses_validated_python_313(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / 'archive'
            (source / 'scripts').mkdir(parents=True)
            (source / 'scripts/windows_launcher.py').write_text('fixture')
            (source / 'runtime.lock.json').write_text(json.dumps({'platforms': {'windows': {
                'version': '26.917.9434.0', 'runtime': '24.21.0',
                'architectures': {'x64': {'sha256': 'fixture',
                    'components': {'app/resources/app.asar': 'fixture'}}}}}}))
            prefix = base / 'installed'
            official = base / 'official-app'
            official.mkdir()
            (official / 'notice.txt').write_text('original notice')
            inventory = application_inventory(official)
            selected = SimpleNamespace(app=official, version='27.100.1.0',
                runtime_version='runtime-new', inventory=inventory,
                inventory_digest=inventory_sha256(inventory))
            with mock.patch.object(install_windows, 'SOURCE', source), \
                 mock.patch.object(install_windows.platform, 'system', return_value='Windows'), \
                 mock.patch.object(install_windows.sys, 'version_info', (3, 13)), \
                 mock.patch.object(install_windows.sys, 'executable', 'C:\\Python313\\python.exe'), \
                 mock.patch.object(install_windows, 'architecture', return_value='x64'), \
                 mock.patch.object(install_windows, 'verify'), \
                 mock.patch.object(install_windows, 'checked_prefix', return_value=prefix), \
                 mock.patch.object(install_windows, 'resolve_installed_windows_app',
                                   return_value=selected), \
                 mock.patch.object(install_windows, '_validated_copy'), \
                 mock.patch.object(install_windows, '_preflight_host'), \
                 mock.patch.object(install_windows, 'materialize_original_host'), \
                 mock.patch('lcu.runtime.paths', return_value=(base / 'official-app', None, None, {})):
                install_windows.install(prefix)
            wrapper = (prefix / 'lcu.cmd').read_text()
            self.assertIn('"C:\\Python313\\python.exe" -B', wrapper)
            self.assertNotIn('py -3.12', wrapper)
            self.assertNotIn(b'\r\r\n', (prefix / 'lcu.cmd').read_bytes())

    def test_installer_stages_full_package_and_keeps_current_on_invalid_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / 'archive'
            (source / 'scripts').mkdir(parents=True)
            (source / 'scripts/windows_launcher.py').write_text('fixture')
            official = base / 'official-app'
            official.mkdir()
            (official / 'AppxManifest.xml').write_text(
                '<Package><Identity Name="OpenAI.Codex" '
                'Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" '
                'Version="27.100.1.0" ProcessorArchitecture="x64"/></Package>')
            for relative in WINDOWS_REQUIRED_FILES:
                file = official / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                data = relative.encode()
                if relative.endswith('cua_node/manifest.json'):
                    data = json.dumps({'platform': 'windows', 'arch': 'x64',
                        'runtime_archive_version': 'runtime-fixture'}).encode()
                file.write_bytes(data)
            (official / 'app/resources/NOTICE.txt').write_text('original notice')
            inventory = application_inventory(official)
            selected = SimpleNamespace(app=official, version='27.100.1.0',
                runtime_version='runtime-fixture', inventory=inventory,
                inventory_digest=inventory_sha256(inventory))
            (source / 'runtime.lock.json').write_text(json.dumps({'platforms': {'windows': {
                'version': '26.917.9434.0', 'runtime': 'old-runtime',
                'architectures': {'x64': {'sha256': 'a' * 64,
                    'components': {'app/resources/app.asar': 'b' * 64}}}}}}))
            prefix = base / 'installed'
            with mock.patch.object(install_windows, 'SOURCE', source), \
                 mock.patch.object(install_windows.platform, 'system', return_value='Windows'), \
                 mock.patch.object(install_windows.sys, 'version_info', (3, 13)), \
                 mock.patch.object(install_windows, 'architecture', return_value='x64'), \
                 mock.patch.object(install_windows, 'verify'), \
                 mock.patch.object(install_windows, 'checked_prefix', return_value=prefix), \
                 mock.patch.object(install_windows, 'resolve_installed_windows_app',
                                   return_value=selected), \
                 mock.patch('lcu.windows.platform.system', return_value='Windows'), \
                 mock.patch('lcu.windows.platform.machine', return_value='AMD64'), \
                 mock.patch.object(install_windows, '_preflight_host'), \
                 mock.patch.object(install_windows, 'materialize_original_host'), \
                 mock.patch('lcu.runtime.paths'):
                install_windows.install(prefix)
                descriptor = json.loads((prefix / 'current.json').read_text())
                release = prefix / 'releases' / descriptor['release']
                installed = json.loads((release / 'installation.json').read_text())
                app = Path(installed['app'])
                self.assertEqual(app.parent, prefix / 'apps' / selected.inventory_digest)
                self.assertEqual((installed['package_version'], installed['runtime']),
                                 ('27.100.1.0', 'runtime-fixture'))
                self.assertEqual(json.loads((app.parent / 'inventory.json').read_text()), inventory)
                self.assertEqual((app / 'app/resources/NOTICE.txt').read_text(), 'original notice')
                self.assertEqual((official / 'app/resources/NOTICE.txt').read_text(), 'original notice')
                install_windows.install(prefix)
                descriptor = json.loads((prefix / 'current.json').read_text())
                self.assertEqual(Path(json.loads((prefix / 'releases' /
                    descriptor['release'] /
                    'installation.json').read_text())['app']), app)
                launcher_before = (prefix / 'windows_launcher.py').read_bytes()
                command_before = (prefix / 'lcu.cmd').read_bytes()
                releases_before = {path.name for path in (prefix / 'releases').iterdir()}
                with mock.patch.object(install_windows, '_atomic_bytes',
                                       side_effect=OSError('launcher locked')) as atomic:
                    with self.assertRaisesRegex(OSError, 'launcher locked'):
                        install_windows.install(prefix)
                atomic.assert_called_once()
                self.assertEqual({path.name for path in (prefix / 'releases').iterdir()},
                                 releases_before)
                self.assertEqual(json.loads((prefix / 'current.json').read_text()), descriptor)
                (source / 'scripts/windows_launcher.py').write_text('new launcher')
                original_replace = install_windows.os.replace
                def fail_pointer(source_path, destination_path):
                    if Path(destination_path) == prefix / 'current.json':
                        raise OSError('pointer blocked')
                    return original_replace(source_path, destination_path)
                with mock.patch.object(install_windows.os, 'replace', side_effect=fail_pointer):
                    with self.assertRaisesRegex(OSError, 'pointer blocked'):
                        install_windows.install(prefix)
                self.assertEqual(json.loads((prefix / 'current.json').read_text()), descriptor)
                self.assertEqual((prefix / 'windows_launcher.py').read_bytes(), launcher_before)
                self.assertEqual((prefix / 'lcu.cmd').read_bytes(), command_before)
                (source / 'scripts/windows_launcher.py').write_text('fixture')
                with mock.patch.object(install_windows, '_validated_copy',
                                       side_effect=ValueError('copied bytes changed')):
                    with self.assertRaisesRegex(ValueError, 'copied bytes changed'):
                        install_windows.install(prefix)
                self.assertEqual(list((prefix / 'apps').iterdir()), [app.parent])
                self.assertEqual(json.loads((prefix / 'current.json').read_text()), descriptor)
                self.assertEqual((app / 'app/resources/NOTICE.txt').read_text(), 'original notice')
                (app / WINDOWS_REQUIRED_FILES[2]).write_text('tampered')
                with self.assertRaisesRegex(ValueError, 'differs from selected source inventory'):
                    install_windows.install(prefix)
                self.assertEqual(json.loads((prefix / 'current.json').read_text()), descriptor)

    def test_rejects_redirected_prefix_ancestor(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            link = base / 'junction'
            target = base / 'other'
            target.mkdir()
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'linked Windows installation path'):
                install_windows.checked_prefix(link / 'lcu')

    def test_rejects_windows_junction_prefix_ancestor(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary) / 'junction' / 'lcu'
            junction = prefix.parent
            with mock.patch.object(Path, 'is_junction', autospec=True,
                                   side_effect=lambda path: path == junction):
                with self.assertRaisesRegex(ValueError, 'linked Windows installation path'):
                    install_windows.checked_prefix(prefix)

    def test_internal_copy_paths_use_windows_extended_length_spelling(self):
        self.assertEqual(install_windows._extended_windows_name('C:\\LCU\\apps\\app'),
                         '\\\\?\\C:\\LCU\\apps\\app')
        self.assertEqual(install_windows._extended_windows_name('\\\\server\\share\\app'),
                         '\\\\?\\UNC\\server\\share\\app')
        self.assertEqual(install_windows._extended_windows_name('\\\\?\\C:\\already'),
                         '\\\\?\\C:\\already')


if __name__ == '__main__':
    unittest.main()
