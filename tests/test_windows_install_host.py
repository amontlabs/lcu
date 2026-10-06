"""The Windows installer checks the host layout before copying and cleans up what it created."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import install_windows
from lcu.windows import (WINDOWS_REQUIRED_FILES, application_inventory,
                         inventory_sha256)

NODE_MEMBER = 'app/resources/cua_node/bin/node.exe'


class InstallHostTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.source = self.base / 'archive'
        (self.source / 'scripts').mkdir(parents=True)
        (self.source / 'scripts/windows_launcher.py').write_text('fixture')
        (self.source / 'runtime.lock.json').write_text(json.dumps({'platforms': {'windows': {
            'architectures': {'x64': {}}}}}))
        self.official = self.base / 'official-app'
        for relative in WINDOWS_REQUIRED_FILES:
            file = self.official / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'node fixture' if relative == NODE_MEMBER else relative.encode())
        inventory = application_inventory(self.official)
        self.selected = SimpleNamespace(
            app=self.official, version='26.930.7945.0', runtime_version='runtime-fixture',
            inventory=inventory, inventory_digest=inventory_sha256(inventory))
        self.prefix = self.base / 'installed'
        self.calls = []
        self.copy = install_windows.shutil.copytree

    def install(self, *, materialize=None, preflight=None):
        def spy_copy(source, destination, *args, **options):
            self.calls.append('copy')
            return self.copy(source, destination, *args, **options)
        patches = [
            mock.patch.object(install_windows, 'SOURCE', self.source),
            mock.patch.object(install_windows.platform, 'system', return_value='Windows'),
            mock.patch.object(install_windows.sys, 'version_info', (3, 13)),
            mock.patch.object(install_windows, 'architecture', return_value='x64'),
            mock.patch.object(install_windows, 'verify'),
            mock.patch.object(install_windows, 'checked_prefix', return_value=self.prefix),
            mock.patch.object(install_windows, 'resolve_installed_windows_app', return_value=self.selected),
            mock.patch.object(install_windows, '_validated_copy'),
            mock.patch.object(install_windows, '_preflight_host',
                              side_effect=preflight or (lambda selected: self.calls.append('preflight'))),
            mock.patch.object(install_windows, 'materialize_original_host',
                              side_effect=materialize or (lambda *args, **options: self.calls.append('host'))),
            mock.patch.object(install_windows.shutil, 'copytree', side_effect=spy_copy),
            mock.patch('lcu.runtime.paths'),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return install_windows.install(self.prefix)

    def test_layout_check_runs_before_any_copy_or_prefix_write(self):
        def refuse(selected):
            self.calls.append('preflight')
            raise ValueError('Required Windows host layout is unavailable: example')
        with self.assertRaisesRegex(ValueError, 'unavailable: example'):
            self.install(preflight=refuse)
        self.assertEqual(self.calls, ['preflight'])
        self.assertFalse(self.prefix.exists())

    def test_successful_install_checks_the_layout_first(self):
        self.install()
        self.assertEqual(self.calls[0], 'preflight')
        self.assertLess(self.calls.index('preflight'), self.calls.index('copy'))
        self.assertIn('current.json', {path.name for path in self.prefix.iterdir()})

    def test_failure_after_the_app_copy_removes_the_copy_this_run_created(self):
        def fail(app, destination, **options):
            self.assertTrue(app.is_dir())  # the new generation existed when the host was extracted
            raise ValueError('Required Windows host layout is unavailable: late failure')
        with self.assertRaisesRegex(ValueError, 'late failure'):
            self.install(materialize=fail)
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [])
        self.assertEqual(list((self.prefix / 'releases').iterdir()), [])
        self.assertFalse((self.prefix / 'current.json').exists())

    def test_failure_before_the_release_copy_still_removes_the_new_copy(self):
        redirected = install_windows._redirected
        with mock.patch.object(install_windows, '_redirected',
                               side_effect=lambda path: Path(path).name == 'releases' or redirected(path)):
            with self.assertRaisesRegex(ValueError, 'redirected Windows release directory'):
                self.install()
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [])
        self.assertFalse((self.prefix / 'current.json').exists())

    def test_failed_launcher_restore_still_removes_the_new_copy(self):
        self.prefix.mkdir(parents=True)
        (self.prefix / 'windows_launcher.py').write_bytes(b'previous launcher')
        calls = []
        def write(path, data):
            calls.append(Path(path).name)
            if len(calls) == 2:
                raise OSError('command locked')
            if len(calls) == 3:
                raise OSError('restore locked')
        with mock.patch.object(install_windows, '_atomic_bytes', side_effect=write):
            with self.assertRaisesRegex(OSError, 'restore locked'):
                self.install()
        self.assertEqual(calls, ['windows_launcher.py', 'lcu.cmd', 'windows_launcher.py'])
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [])
        self.assertEqual(list((self.prefix / 'releases').iterdir()), [])

    def test_a_second_install_for_the_same_prefix_is_refused_while_one_runs(self):
        self.prefix.mkdir(parents=True)
        with install_windows._install_lock(self.prefix):
            with self.assertRaisesRegex(ValueError, 'Another LCU install is already running'):
                self.install()
        self.assertFalse((self.prefix / 'apps').exists())  # nothing was copied or removed
        self.install()  # the lock is free again once the holder finishes

    def test_failure_keeps_a_generation_a_committed_release_records(self):
        def other_install_commits_then_this_one_fails(app, destination, **options):
            # Stands in for a release that came to reference the new generation meanwhile.
            other = self.prefix / 'releases' / 'other-release'
            other.mkdir(parents=True)
            (other / 'installation.json').write_text(json.dumps({'app': str(app)}))
            raise OSError('host extraction failed')
        with self.assertRaisesRegex(OSError, 'host extraction failed'):
            self.install(materialize=other_install_commits_then_this_one_fails)
        generations = list((self.prefix / 'apps').iterdir())
        self.assertEqual(len(generations), 1)
        self.assertTrue((generations[0] / 'app').is_dir())
        # A release this run itself created is removed, but an unreadable record keeps the copy.
        self.assertTrue(install_windows._generation_in_use(self.prefix, generations[0]))

    def test_unreadable_or_malformed_release_record_counts_as_in_use(self):
        generation = self.prefix / 'apps' / 'digest'
        (self.prefix / 'releases' / 'broken').mkdir(parents=True)
        record = self.prefix / 'releases' / 'broken' / 'installation.json'
        for text in ('not json', '{"app": 5}', '{"app": null}', '[]', '{}'):
            with self.subTest(text=text):
                record.write_text(text)
                self.assertTrue(install_windows._generation_in_use(self.prefix, generation))
        record.write_text(json.dumps({'app': str(self.prefix / 'apps' / 'other' / 'app')}))
        self.assertFalse(install_windows._generation_in_use(self.prefix, generation))

    def test_failure_with_a_malformed_release_record_keeps_the_original_error(self):
        def fail(app, destination, **options):
            other = self.prefix / 'releases' / 'odd'
            other.mkdir(parents=True)
            (other / 'installation.json').write_text('{"app": 5}')
            raise OSError('host extraction failed')
        with self.assertRaisesRegex(OSError, 'host extraction failed'):
            self.install(materialize=fail)

    def test_failure_never_removes_a_generation_that_already_existed(self):
        self.install()
        generation = next((self.prefix / 'apps').iterdir())
        marker = generation / 'app/NOTICE.txt'
        marker.write_text('kept')
        before = json.loads((self.prefix / 'current.json').read_text())
        with mock.patch.object(install_windows, 'materialize_original_host',
                               side_effect=OSError('host extraction failed')):
            with self.assertRaisesRegex(OSError, 'host extraction failed'):
                install_windows.install(self.prefix)
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [generation])
        self.assertEqual(marker.read_text(), 'kept')
        self.assertEqual(json.loads((self.prefix / 'current.json').read_text()), before)

    def test_preflight_uses_a_private_node_copy_and_reports_the_observed_app(self):
        seen = {}
        def plan(app, *, node):
            seen.update(app=app, node=node, existed=node.is_file(), content=node.read_bytes())
            raise ValueError('Required Windows host layout is unavailable: no factory')
        node = self.official / NODE_MEMBER
        before = node.read_bytes()
        with mock.patch.object(install_windows, 'plan_original_host', side_effect=plan):
            with self.assertRaises(ValueError) as caught:
                install_windows._preflight_host(self.selected)
        self.assertEqual(seen['app'], self.official)
        self.assertNotEqual(seen['node'], node)
        self.assertTrue(seen['existed'])
        self.assertEqual(seen['content'], before)
        self.assertFalse(seen['node'].exists())  # nothing from the check remains
        self.assertEqual(node.read_bytes(), before)
        message = str(caught.exception)
        self.assertIn('Required Windows host layout is unavailable: no factory', message)
        self.assertIn('26.930.7945.0', message)
        self.assertIn('runtime-fixture', message)

    def test_preflight_refuses_a_missing_node(self):
        (self.official / NODE_MEMBER).unlink()
        with self.assertRaisesRegex(ValueError, 'no usable app/resources/cua_node/bin/node.exe'):
            install_windows._preflight_host(self.selected)


if __name__ == '__main__':
    unittest.main()
