"""The Windows installer checks the host layout before copying and cleans up what it created (LCU 0.9.6, #20).

Upstream's cases against the bridge (scripts/install_windows.py): it runs the layout check (with a temporary copy
of the app's node.exe, through `install_windows.mjs --check-host`) before the private copy or any prefix write,
holds the prefix lock while the copy and the Node installer run, and removes an app copy it created when the Node
installer fails, unless a release records it. The release-side cleanup (partial release, launcher restore,
release directory checks) is the Node installer's: tests/node/install_windows.test.mjs
"WindowsInstallHostTests (Node publication)". Fixtures only; no live Windows claim.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('install_windows_bridge', ROOT / 'scripts/install_windows.py')
install_windows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_windows)

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
        for relative in install_windows.WINDOWS_REQUIRED_FILES:
            file = self.official / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'node fixture' if relative == NODE_MEMBER else relative.encode())
        inventory = install_windows.application_inventory(self.official)
        self.selected = SimpleNamespace(
            app=self.official, version='26.930.7945.0', runtime_version='runtime-fixture',
            inventory=inventory, inventory_digest=install_windows.inventory_sha256(inventory))
        self.prefix = self.base / 'installed'
        self.calls = []
        self.copy = install_windows.shutil.copytree

    def node_installer(self, command, **options):
        """Stands in for the Node installer: publishes a release recording the generation and commits it."""
        self.calls.append('node')
        generation = Path(command[command.index('--app-generation') + 1])
        release = self.prefix / 'releases' / 'fixture-release'
        release.mkdir(parents=True, exist_ok=True)
        (release / 'installation.json').write_text(json.dumps({'app': str(generation / 'app')}))
        (self.prefix / 'current.json').write_text(json.dumps({'release': release.name}) + '\n')
        return SimpleNamespace(returncode=0)

    def install(self, *, node=None, preflight=None):
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
            mock.patch.object(install_windows.shutil, 'copytree', side_effect=spy_copy),
            mock.patch.object(install_windows.subprocess, 'run', side_effect=node or self.node_installer),
            mock.patch('sys.stderr', io.StringIO()),
        ]
        for patch in patches:
            patch.start()
        try:
            return install_windows.main(['--prefix', str(self.prefix), '--runtime-only'])
        finally:
            for patch in reversed(patches):
                patch.stop()

    def test_layout_check_runs_before_any_copy_or_prefix_write(self):
        def refuse(selected):
            self.calls.append('preflight')
            raise ValueError('Required Windows host layout is unavailable: example')
        with self.assertRaisesRegex(ValueError, 'unavailable: example'):
            self.install(preflight=refuse)
        self.assertEqual(self.calls, ['preflight'])
        self.assertFalse(self.prefix.exists())

    def test_successful_install_checks_the_layout_first(self):
        self.assertEqual(self.install(), 0)
        self.assertEqual(self.calls[0], 'preflight')
        self.assertLess(self.calls.index('preflight'), self.calls.index('copy'))
        self.assertLess(self.calls.index('copy'), self.calls.index('node'))
        self.assertIn('current.json', {path.name for path in self.prefix.iterdir()})

    def test_failure_after_the_app_copy_removes_the_copy_this_run_created(self):
        def fail(command, **options):
            generation = Path(command[command.index('--app-generation') + 1])
            self.assertTrue((generation / 'app').is_dir())  # the new generation existed when the host was extracted
            return SimpleNamespace(returncode=1)  # e.g. the Node installer's host extraction failed
        self.assertEqual(self.install(node=fail), 1)
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [])
        self.assertFalse((self.prefix / 'current.json').exists())

    def test_an_interrupted_node_installer_still_removes_the_new_copy(self):
        def interrupted(command, **options):
            raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.install(node=interrupted)
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [])

    def test_a_second_install_for_the_same_prefix_is_refused_while_one_runs(self):
        self.prefix.mkdir(parents=True)
        with install_windows._install_lock(self.prefix):
            with self.assertRaisesRegex(ValueError, 'Another LCU install is already running'):
                self.install()
        self.assertFalse((self.prefix / 'apps').exists())  # nothing was copied or removed
        self.assertEqual(self.install(), 0)  # the lock is free again once the holder finishes

    def test_the_lock_is_held_while_the_node_installer_runs(self):
        def concurrent(command, **options):
            with self.assertRaisesRegex(ValueError, 'Another LCU install is already running'):
                with install_windows._install_lock(self.prefix):
                    pass
            return self.node_installer(command, **options)
        self.assertEqual(self.install(node=concurrent), 0)

    def test_failure_keeps_a_generation_a_committed_release_records(self):
        def other_install_commits_then_this_one_fails(command, **options):
            # Stands in for a release that came to reference the new generation meanwhile.
            generation = Path(command[command.index('--app-generation') + 1])
            other = self.prefix / 'releases' / 'other-release'
            other.mkdir(parents=True)
            (other / 'installation.json').write_text(json.dumps({'app': str(generation / 'app')}))
            return SimpleNamespace(returncode=1)
        self.assertEqual(self.install(node=other_install_commits_then_this_one_fails), 1)
        generations = list((self.prefix / 'apps').iterdir())
        self.assertEqual(len(generations), 1)
        self.assertTrue((generations[0] / 'app').is_dir())
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
        def fail(command, **options):
            other = self.prefix / 'releases' / 'odd'
            other.mkdir(parents=True)
            (other / 'installation.json').write_text('{"app": 5}')
            raise OSError('host extraction failed')
        with self.assertRaisesRegex(OSError, 'host extraction failed'):
            self.install(node=fail)

    def test_failure_never_removes_a_generation_that_already_existed(self):
        self.assertEqual(self.install(), 0)
        generation = next((self.prefix / 'apps').iterdir())
        marker = generation / 'app/NOTICE.txt'
        marker.write_text('kept')
        before = json.loads((self.prefix / 'current.json').read_text())
        shutil.rmtree(self.prefix / 'releases')  # no release records the generation any more
        self.assertEqual(self.install(node=lambda command, **options: SimpleNamespace(returncode=1)), 1)
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
        self.assertTrue(message.endswith('; nothing was installed)'))

    def test_preflight_refuses_a_missing_node(self):
        (self.official / NODE_MEMBER).unlink()
        with self.assertRaisesRegex(ValueError, 'no usable app/resources/cua_node/bin/node.exe'):
            install_windows._preflight_host(self.selected)

    def test_layout_check_runs_the_node_installer_check_mode_with_the_staged_node(self):
        calls = []
        def run(command, **options):
            calls.append((command, options))
            return SimpleNamespace(returncode=0, stdout=b'{"ok": true}\n', stderr=b'')
        with mock.patch.object(install_windows.subprocess, 'run', side_effect=run), \
                mock.patch.dict(install_windows.os.environ, {'NODE_OPTIONS': '--require /evil.cjs', 'KEEP': '1'},
                                clear=True):
            install_windows.plan_original_host(self.official, node=self.base / 'staged/node.exe')
        command, options = calls[0]
        self.assertEqual(command, [str(self.base / 'staged/node.exe'), '--disable-warning=ExperimentalWarning',
                                   str(install_windows.SOURCE / 'scripts/install_windows.mjs'), '--check-host',
                                   str(self.official)])
        self.assertEqual(options['env'], {'KEEP': '1', '__LCU_Q_NODE_OPTIONS': '--require /evil.cjs',
                                          '__LCU_Q': 'NODE_OPTIONS'})
        self.assertFalse(options['check'])
        for stdout, returncode, stderr, message in (
                (b'{"ok": false, "error": "Required Windows host layout is unavailable: x"}', 0, b'',
                 'Required Windows host layout is unavailable: x'),
                (b'', 1, b'boom\nmore', 'Required Windows host layout is unavailable: the layout check could not run (boom)'),
                (b'[]', 0, b'', 'Required Windows host layout is unavailable: the layout check could not run')):
            with self.subTest(message=message):
                with mock.patch.object(install_windows.subprocess, 'run', return_value=SimpleNamespace(
                        returncode=returncode, stdout=stdout, stderr=stderr)):
                    with self.assertRaises(ValueError) as caught:
                        install_windows.plan_original_host(self.official, node=self.base / 'node.exe')
                self.assertEqual(str(caught.exception), message)
        with mock.patch.object(install_windows.subprocess, 'run', side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(ValueError, r'^Required Windows host layout is unavailable: the structural '
                                                    r'analyzer could not run \(PermissionError\)$'):
                install_windows.plan_original_host(self.official, node=self.base / 'node.exe')

    @unittest.skipUnless(shutil.which('node') and os.name != 'nt', 'needs node (a sh wrapper stands in for node.exe)')
    def test_layout_check_end_to_end_with_a_wrapper_node(self):
        """The real check: a copied node.exe (a sh wrapper around PATH node) runs install_windows.mjs --check-host."""
        node = self.official / NODE_MEMBER
        node.write_text(f'#!/bin/sh\nexec "{shutil.which("node")}" "$@"\n')
        node.chmod(0o755)
        options = '{codexCliPath,nativePipeDirectory,windowsHelperPath,windowsHelperTransportModulePath}'
        def asar(main):
            content = main.encode()
            header = json.dumps({'files': {'.vite': {'files': {'build': {'files': {
                'main-h.js': {'offset': '0', 'size': len(content)}}}}}}}).encode()
            import struct
            (self.official / 'app/resources/app.asar').write_bytes(
                struct.pack('<4I', 4, 8 + len(header), 4 + len(header), len(header)) + header + content)
        with mock.patch.object(install_windows, 'SOURCE', ROOT):
            asar(f'function Kne({options}){{return {{closeActiveTurn(){{}},nativePipeDirectory}}}}\n')
            install_windows._preflight_host(self.selected)
            asar('const x=1;\n')
            with self.assertRaisesRegex(ValueError, r'^Required Windows host layout is unavailable: no main bundle '
                                                    r'has a top-level native-pipe host factory .*\(observed ChatGPT '
                                                    r'app 26\.930\.7945\.0, runtime runtime-fixture; nothing was '
                                                    r'installed\)$'):
                install_windows._preflight_host(self.selected)
        leftovers = [name for name in os.listdir(tempfile.gettempdir()) if name.startswith('lcu-host-check-')]
        self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()
