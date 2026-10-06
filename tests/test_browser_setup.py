"""Native-host setup tests use only disposable homes and a fake upstream installer."""
import ast
import json
import io
import os
from pathlib import Path
import platform
import shlex
import stat
import struct
import sys
import shutil
import tempfile
import unittest
import subprocess
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu.browser import _RELAY_MINIMUM, _manifest_paths, _posix_wrapper, _write_private, install, status


class BrowserSetupTests(unittest.TestCase):
    def test_windows_original_installer_and_registry_are_reused_for_cmd_relay(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / 'release'
            app = base / 'registered-msix'
            resources = app / 'app/resources'
            plugin = resources / 'plugins/openai-bundled/plugins/chrome'
            installer = plugin / 'scripts/installManifest.mjs'
            installer.parent.mkdir(parents=True)
            installer.write_text('upstream fixture')
            host = plugin / 'extension-host/windows/x64/extension-host.exe'
            host.parent.mkdir(parents=True)
            host.write_bytes(b'original executable fixture')
            relay = root / 'lcu/native_host.py'
            relay.parent.mkdir(parents=True)
            relay.write_text('original relay fixture')
            home = base / 'account'
            home.mkdir()
            local = home / 'AppData/Local'
            manifest = local / 'OpenAI/extension/com.openai.codexextension.json'
            env = {'USERPROFILE': str(home), 'LOCALAPPDATA': str(local),
                   'NODE_REPL_NODE_PATH': 'C:/node.exe', 'CODEX_CLI_PATH': 'C:/codex.exe',
                   'CUA_REPL_NODE_REPL_PATH': 'C:/node_repl.exe'}

            def original_install(command, **_options):
                if command[0] == 'reg.exe':
                    return subprocess.CompletedProcess(command, 0, stdout=f'{manifest} REG_SZ {manifest}')
                private = next(d for d in (local / 'lcu/browser').iterdir() if d.is_dir()) / 'chrome'
                selected_host = private / 'extension-host/windows/x64/extension-host.exe'
                manifest.parent.mkdir(parents=True)
                manifest.write_text(json.dumps({'name': 'com.openai.codexextension',
                    'path': str(selected_host), 'allowed_origins': ['chrome-extension://fixture/']}))
                return subprocess.CompletedProcess(command, 0)

            with mock.patch('lcu.browser.platform.system', return_value='Windows'), \
                 mock.patch.dict(os.environ, {'USERPROFILE': str(home), 'LOCALAPPDATA': str(local)}), \
                 mock.patch('lcu.runtime.paths', return_value=(app, resources, None, {})), \
                 mock.patch('lcu.runtime.environment', return_value=env), \
                 mock.patch('lcu.browser.subprocess.run', side_effect=original_install) as run, \
                 mock.patch('lcu.browser.sys.executable', 'C:\\Python313\\python.exe'):
                destination = install(root)
            configured = json.loads(manifest.read_text())
            self.assertEqual(configured['path'], str(destination / 'lcu-native-host.cmd'))
            self.assertEqual(configured['allowed_origins'], ['chrome-extension://fixture/'])
            self.assertEqual((destination / 'lcu-native-host.py').read_text(), relay.read_text())
            self.assertIn(b'@echo off', (destination / 'lcu-native-host.cmd').read_bytes())
            self.assertIn(b'"C:\\Python313\\python.exe" -B -u',
                          (destination / 'lcu-native-host.cmd').read_bytes())
            self.assertEqual((destination / '.lcu-browser-host').read_text(), str(app) + '\n')
            self.assertEqual(run.call_count, 2)

    def test_macos_manifest_locations_match_original_installer(self):
        home = Path('/private/tmp/disposable-home')
        paths = _manifest_paths({'HOME': str(home)}, 'Darwin')
        self.assertEqual(len(paths), 8)
        self.assertIn(home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json', paths)
        self.assertIn(home / 'Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.openai.codexextension.json', paths)
        self.assertIn(home / 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.openai.codexextension.json', paths)

    def test_macos_setup_rewrites_only_manifests_for_selected_original_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'release'
            home = base / 'home'
            resources = root / 'app/Contents/Resources'
            source = resources / 'plugins/openai-bundled/plugins/chrome'
            (source / 'scripts').mkdir(parents=True)
            (source / 'scripts/installManifest.mjs').write_text('fixture')
            host = source / 'extension-host/macos/arm64/ChatGPT for Chrome'
            host.parent.mkdir(parents=True)
            host.write_text('fixture')
            relay_source = root / 'lcu/native_host.py'
            relay_source.parent.mkdir(parents=True)
            relay_source.write_text('#!/usr/bin/env python3\n')
            home.mkdir()
            env = {'HOME': str(home), 'NODE_REPL_NODE_PATH': '/fake/node',
                   'CODEX_CLI_PATH': '/fake/codex', 'CUA_REPL_NODE_REPL_PATH': '/fake/repl'}
            chrome_manifest = home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json'
            edge_manifest = home / 'Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.openai.codexextension.json'
            unrelated = home / 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.openai.codexextension.json'

            def original_installer(*args, **kwargs):
                destination = home / 'Library/Application Support/lcu/browser'
                plugin = next(d for d in destination.iterdir() if d.is_dir()) / 'chrome'
                selected_host = str(plugin / 'extension-host/macos/arm64/ChatGPT for Chrome')
                for path, selected in ((chrome_manifest, selected_host),
                                       (edge_manifest, selected_host),
                                       (unrelated, '/other/ChatGPT for Chrome')):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({'name': 'com.openai.codexextension',
                                                'path': selected, 'allowed_origins': ['chrome-extension://fixture/']}))
                return subprocess.CompletedProcess(args, 0)

            with mock.patch('lcu.browser.platform.system', return_value='Darwin'), \
                    mock.patch.dict(os.environ, {'HOME': str(home)}), \
                    mock.patch('lcu.runtime.paths', return_value=(root / 'app', resources, None, {})), \
                    mock.patch('lcu.runtime.environment', return_value=env), \
                    mock.patch('lcu.browser.subprocess.run', side_effect=original_installer) as run:
                destination = install(root)

            expected_relay = destination / 'lcu-native-host'
            self.assertEqual(json.loads(chrome_manifest.read_text())['path'], str(expected_relay))
            self.assertEqual(json.loads(edge_manifest.read_text())['path'], str(expected_relay))
            self.assertEqual(json.loads(unrelated.read_text())['path'], '/other/ChatGPT for Chrome')
            self.assertEqual(json.loads(chrome_manifest.read_text())['allowed_origins'],
                             ['chrome-extension://fixture/'])
            self.assertEqual((destination / '.lcu-browser-host').read_text(), str((root / 'app').resolve()) + '\n')
            self.assertEqual((destination / 'lcu-native-host.py').read_bytes(), relay_source.read_bytes())
            wrapper = expected_relay.read_text()
            self.assertTrue(wrapper.startswith('#!/bin/sh\n'))
            self.assertIn(f'python={shlex.quote(sys.executable)}\n', wrapper)
            self.assertIn(f'script={shlex.quote(str(destination / "lcu-native-host.py"))}\n', wrapper)
            self.assertTrue(wrapper.endswith('exec "$python" -B -u "$script" "$@"\n'))
            if os.name != 'nt':  # Windows has no POSIX mode bits.
                self.assertEqual(expected_relay.stat().st_mode & 0o777, 0o700)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][0], '/fake/node')
            self.assertTrue((destination / 'chrome/scripts/installManifest.mjs').is_file())

    def test_same_path_app_upgrade_refreshes_the_private_plugin_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'release'
            home = base / 'home'
            resources = root / 'app/Contents/Resources'
            source = resources / 'plugins/openai-bundled/plugins/chrome'
            (source / 'scripts').mkdir(parents=True)
            installer = source / 'scripts/installManifest.mjs'
            installer.write_text('version one')
            host = source / 'extension-host/macos/arm64/ChatGPT for Chrome'
            host.parent.mkdir(parents=True)
            host.write_text('host one')
            relay_source = root / 'lcu/native_host.py'
            relay_source.parent.mkdir(parents=True)
            relay_source.write_text('#!/usr/bin/env python3\n')
            home.mkdir()
            env = {'HOME': str(home), 'NODE_REPL_NODE_PATH': '/fake/node',
                   'CODEX_CLI_PATH': '/fake/codex', 'CUA_REPL_NODE_REPL_PATH': '/fake/repl'}
            manifest = home / 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json'

            def original_installer(*args, **kwargs):
                private = next(d for d in (home / 'Library/Application Support/lcu/browser').iterdir() if d.is_dir()) / 'chrome'
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest.write_text(json.dumps({
                    'path': str(private / 'extension-host/macos/arm64/ChatGPT for Chrome')}))
                return subprocess.CompletedProcess(args, 0)

            with mock.patch('lcu.browser.platform.system', return_value='Darwin'), \
                    mock.patch.dict(os.environ, {'HOME': str(home)}), \
                    mock.patch('lcu.runtime.paths', return_value=(root / 'app', resources, None, {})), \
                    mock.patch('lcu.runtime.environment', return_value=env), \
                    mock.patch('lcu.browser.subprocess.run', side_effect=original_installer):
                first = install(root)
                self.assertEqual((first / 'chrome/scripts/installManifest.mjs').read_text(), 'version one')
                unchanged = (first / 'chrome').stat().st_ino
                self.assertEqual(install(root), first)
                self.assertEqual((first / 'chrome').stat().st_ino, unchanged)
                installer.write_text('version two')  # apt upgrade at the same path
                host.write_text('host two')
                second = install(root)
            self.assertEqual(second, first)
            self.assertEqual((second / 'chrome/scripts/installManifest.mjs').read_text(), 'version two')
            self.assertEqual((second / 'chrome/extension-host/macos/arm64/ChatGPT for Chrome').read_text(), 'host two')
            self.assertEqual({p.name for p in second.iterdir()},
                             {'chrome', 'lcu-native-host', 'lcu-native-host.py', '.lcu-browser-host',
                              '.lcu-browser-plugin'})

    def test_macos_missing_original_manifest_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'release'
            resources = root / 'app/Contents/Resources'
            source = resources / 'plugins/openai-bundled/plugins/chrome/scripts'
            source.mkdir(parents=True)
            (source / 'installManifest.mjs').write_text('fixture')
            relay_source = root / 'lcu/native_host.py'
            relay_source.parent.mkdir(parents=True)
            relay_source.write_text('fixture')
            home = base / 'home'
            home.mkdir()
            env = {'HOME': str(home), 'NODE_REPL_NODE_PATH': '/fake/node',
                   'CODEX_CLI_PATH': '/fake/codex', 'CUA_REPL_NODE_REPL_PATH': '/fake/repl'}
            with mock.patch('lcu.browser.platform.system', return_value='Darwin'), \
                    mock.patch.dict(os.environ, {'HOME': str(home)}), \
                    mock.patch('lcu.runtime.paths', return_value=(root / 'app', resources, None, {})), \
                    mock.patch('lcu.runtime.environment', return_value=env), \
                    mock.patch('lcu.browser.capture.run',
                               return_value=subprocess.CompletedProcess([], 0, '', '')):
                with self.assertRaisesRegex(ValueError, 'produced no manifest'):
                    install(root)

    def test_original_installer_failure_surfaces_stderr(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / 'release'
            resources = root / 'app/Contents/Resources'
            source = resources / 'plugins/openai-bundled/plugins/chrome/scripts'
            source.mkdir(parents=True)
            (source / 'installManifest.mjs').write_text('fixture')
            relay_source = root / 'lcu/native_host.py'
            relay_source.parent.mkdir(parents=True)
            relay_source.write_text('fixture')
            home = base / 'home'
            home.mkdir()
            env = {'HOME': str(home), 'NODE_REPL_NODE_PATH': '/fake/node',
                   'CODEX_CLI_PATH': '/fake/codex', 'CUA_REPL_NODE_REPL_PATH': '/fake/repl'}
            failed = subprocess.CompletedProcess([], 1, '', 'installer exploded')
            with mock.patch('lcu.browser.platform.system', return_value='Darwin'), \
                    mock.patch.dict(os.environ, {'HOME': str(home)}), \
                    mock.patch('lcu.runtime.paths', return_value=(root / 'app', resources, None, {})), \
                    mock.patch('lcu.runtime.environment', return_value=env), \
                    mock.patch('lcu.browser.capture.run', return_value=failed):
                with self.assertRaisesRegex(ValueError, 'installer exploded'):
                    install(root)


class PluginCopyRefreshTests(unittest.TestCase):
    """The private Chrome plugin copy and its digest are published together and recoverable."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.root = base / 'release'
        self.home = base / 'home'
        self.home.mkdir()
        resources = self.root / 'app/Contents/Resources'
        self.source = resources / 'plugins/openai-bundled/plugins/chrome'
        (self.source / 'scripts').mkdir(parents=True)
        self.installer = self.source / 'scripts/installManifest.mjs'
        self.installer.write_text('version one')
        host = self.source / 'extension-host/macos/arm64/ChatGPT for Chrome'
        host.parent.mkdir(parents=True)
        host.write_text('host')
        relay = self.root / 'lcu/native_host.py'
        relay.parent.mkdir(parents=True)
        relay.write_text('#!/usr/bin/env python3\n')
        support = self.home / 'Library/Application Support'
        self.destinations = support / 'lcu/browser'
        manifest = support / 'Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json'
        env = {'HOME': str(self.home), 'NODE_REPL_NODE_PATH': '/fake/node',
               'CODEX_CLI_PATH': '/fake/codex', 'CUA_REPL_NODE_REPL_PATH': '/fake/repl'}

        def original_installer(*args, **kwargs):
            private = next(d for d in self.destinations.iterdir() if d.is_dir()) / 'chrome'
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps({'path': str(private / 'extension-host/macos/arm64/ChatGPT for Chrome')}))
            return subprocess.CompletedProcess(args, 0)

        for patcher in (mock.patch('lcu.browser.platform.system', return_value='Darwin'),
                        mock.patch.dict(os.environ, {'HOME': str(self.home)}),
                        mock.patch('lcu.runtime.paths', return_value=(self.root / 'app', resources, None, {})),
                        mock.patch('lcu.runtime.environment', return_value=env),
                        mock.patch('lcu.browser.subprocess.run', side_effect=original_installer)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def private(self, destination):
        return (destination / 'chrome/scripts/installManifest.mjs').read_text()

    def consistent(self, destination):
        from lcu.browser import _plugin_digest
        self.assertEqual((destination / '.lcu-browser-plugin').read_text().strip(), _plugin_digest(self.source))
        self.assertEqual(self.private(destination), self.installer.read_text())
        self.assertEqual([p.name for p in destination.glob('.chrome-previous')], [])
        self.assertEqual([p.name for p in destination.iterdir() if p.name.startswith('.lcu-browser-')
                          and p.name not in ('.lcu-browser-host', '.lcu-browser-plugin')], [])

    def test_stamp_symlink_is_replaced_not_followed(self):
        destination = install(self.root)
        victim = self.home / 'victim'
        victim.write_text('precious')
        stamp = destination / '.lcu-browser-plugin'
        stamp.unlink()
        stamp.symlink_to(victim)
        self.installer.write_text('version two')
        install(self.root)
        self.assertEqual(victim.read_text(), 'precious')
        self.assertFalse(stamp.is_symlink())
        self.consistent(destination)

    def test_stamp_symlink_with_a_current_copy_is_also_repaired(self):
        destination = install(self.root)
        victim = self.home / 'victim'
        victim.write_text('precious')
        stamp = destination / '.lcu-browser-plugin'
        stamp.unlink()
        stamp.symlink_to(victim)
        install(self.root)
        self.assertEqual(victim.read_text(), 'precious')
        self.assertFalse(stamp.is_symlink())
        self.consistent(destination)

    def test_interrupted_between_the_renames_is_recovered(self):
        destination = install(self.root)
        (destination / 'chrome').rename(destination / '.chrome-previous')  # chrome missing, copy retired
        self.installer.write_text('version two')
        self.assertEqual(install(self.root), destination)
        self.consistent(destination)

    def test_missing_copy_without_a_retired_one_is_rebuilt(self):
        destination = install(self.root)
        import shutil
        shutil.rmtree(destination / 'chrome')
        install(self.root)
        self.consistent(destination)

    def test_failed_staging_leaves_the_published_copy_and_digest_untouched(self):
        destination = install(self.root)
        self.installer.write_text('version two')
        with mock.patch('lcu.browser.shutil.copytree', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                install(self.root)
        self.assertEqual(self.private(destination), 'version one')
        install(self.root)
        self.consistent(destination)

    def test_interrupted_before_the_digest_is_written_converges(self):
        destination = install(self.root)
        self.installer.write_text('version two')
        with mock.patch('lcu.browser._write_stamp', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                install(self.root)
        self.assertEqual(self.private(destination), 'version two')
        install(self.root)
        self.consistent(destination)

    def test_concurrent_refreshes_publish_one_matching_copy_and_digest(self):
        import threading
        destination = install(self.root)
        self.installer.write_text('version two')
        start = threading.Barrier(6)
        errors = []
        active, overlaps = [0], []
        real = __import__('lcu.browser', fromlist=['x'])._refresh_plugin

        def tracked(source, target):
            active[0] += 1
            overlaps.append(active[0])
            try:
                real(source, target)
            finally:
                active[0] -= 1

        def work():
            try:
                start.wait()
                install(self.root)
            except BaseException as exc:  # pragma: no cover - reported below
                errors.append(exc)

        with mock.patch('lcu.browser._refresh_plugin', side_effect=tracked):
            threads = [threading.Thread(target=work) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(max(overlaps), 1)
        self.consistent(destination)


class BrowserStatusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        resources = self.root / 'app/Contents/Resources'
        scripts = resources / 'plugins/openai-bundled/plugins/chrome/scripts'
        scripts.mkdir(parents=True)
        (scripts / 'extension-ids.json').write_text(json.dumps({'browserDiagnostics': [{
            'browserFamily': 'chrome', 'shortDisplayName': 'Chrome',
            'extensionManagementUrl': 'chrome://extensions', 'storeUrl': 'https://official.example/extension'}]}))
        self.host_dir = self.root / 'private-host'
        self.host_dir.mkdir()
        (self.host_dir / '.lcu-browser-host').write_text(str((self.root / 'app').resolve()) + '\n')
        from lcu.browser import _plugin_digest
        (self.host_dir / '.lcu-browser-plugin').write_text(_plugin_digest(
            resources / 'plugins/openai-bundled/plugins/chrome') + '\n')
        self.relay = self.host_dir / 'lcu-native-host'
        self.script = self.host_dir / 'lcu-native-host.py'
        self.relay.write_text(_posix_wrapper(sys.executable, self.script))
        self.relay.chmod(0o700)
        self.script.write_text('fixture relay')
        source = self.root / 'lcu/native_host.py'
        source.parent.mkdir()
        source.write_bytes(self.script.read_bytes())
        host = self.host_dir / 'chrome/extension-host/macos/arm64/ChatGPT for Chrome'
        host.parent.mkdir(parents=True)
        host.write_text('fixture host')
        host.chmod(0o700)
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_text(json.dumps({'path': str(self.relay)}))
        self.extension = {'enabled': True, 'installed': True, 'selectedProfileDirectory': 'Default'}
        self.output = io.StringIO()
        patches = [
            mock.patch('lcu.runtime.paths', return_value=(None, resources, None, {})),
            mock.patch('lcu.runtime.environment', return_value={'NODE_REPL_NODE_PATH': '/original/node'}),
            mock.patch('lcu.browser.platform.system', return_value='Darwin'),
            mock.patch('lcu.browser.platform.machine', return_value='arm64'),
            mock.patch('sys.stdout', self.output),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def run_status(self):
        results = [subprocess.CompletedProcess([], 0, json.dumps(self.extension), ''),
                   subprocess.CompletedProcess([], 0, json.dumps(
                       {'correct': True, 'manifestPath': str(self.manifest)}), '')]
        return self.run_status_with(results)

    def run_status_with(self, results):
        with mock.patch('lcu.browser.capture.run', side_effect=results):
            return status(self.root)

    def good_manifest(self):
        return subprocess.CompletedProcess([], 0, json.dumps(
            {'correct': True, 'manifestPath': str(self.manifest)}), '')

    def test_large_diagnostic_output_survives_node_exit(self):
        node = shutil.which('node') or str(Path.home() / '.local/share/lcu/current/agent-tools/node/bin/node')
        if not Path(node).is_file():
            self.skipTest('node is not available')
        script = self.root / 'big.js'
        script.write_text("console.log(JSON.stringify({installed:true,enabled:true,pad:'x'.repeat(200000)}));"
                          'process.exit(0);')
        from lcu import capture
        result = capture.run([node, str(script)], timeout=20)
        self.assertGreater(len(result.stdout), 65536)
        self.assertTrue(json.loads(result.stdout)['enabled'])

    def test_unparseable_diagnostic_output_is_reported_honestly(self):
        self.run_status_with([subprocess.CompletedProcess([], 0, 'not json', ''), self.good_manifest()])
        self.assertIn('could not be parsed (8 bytes)', self.output.getvalue())
        self.assertNotIn('returned no result', self.output.getvalue())

    def test_non_object_diagnostic_output_is_a_problem(self):
        self.run_status_with([subprocess.CompletedProcess([], 0, '[1]', ''), self.good_manifest()])
        self.assertIn('could not be parsed', self.output.getvalue())

    def test_diagnostic_stderr_is_shown_when_unparseable(self):
        self.run_status_with([subprocess.CompletedProcess([], 1, '', 'boom happened'), self.good_manifest()])
        self.assertIn('boom happened', self.output.getvalue())

    def test_valid_setup_does_not_claim_live_connection_or_write_files(self):
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertTrue(self.run_status())
        self.assertIn('Live browser connection: not checked', self.output.getvalue())
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_enabled_extension_with_original_host_is_not_lcu_ready(self):
        self.manifest.write_text(json.dumps({'path': '/original/ChatGPT for Chrome'}))
        self.assertFalse(self.run_status())
        self.assertIn('lcu browser install', self.output.getvalue())

    def test_outdated_relay_requires_refresh(self):
        self.script.write_text('old relay')
        self.assertFalse(self.run_status())
        self.assertIn('missing or outdated', self.output.getvalue())

    def test_single_file_install_without_the_script_requires_refresh(self):
        self.script.unlink()
        self.assertFalse(self.run_status())
        self.assertIn('missing or outdated', self.output.getvalue())

    def test_wrapper_that_is_not_ours_or_targets_another_script_requires_refresh(self):
        for text in ('#!/bin/sh\nexit 0\n', '#!/usr/bin/env python3\nprint(1)\n',
                     _posix_wrapper(sys.executable, self.host_dir / 'elsewhere.py')):
            with self.subTest(text=text[:40]):
                self.relay.write_text(text)
                self.output.seek(0)
                self.output.truncate()
                self.assertFalse(self.run_status())
                self.assertIn('missing or outdated', self.output.getvalue())

    def test_wrapper_with_a_damaged_body_requires_refresh(self):
        good = self.relay.read_text()
        for damaged in (good.replace('if [ ! -x "$python" ]', 'if false'),
                        good.replace('exit 127', 'exit 0'),
                        good.replace('python=', 'python=/nonexistent ; python=', 1),
                        good + '# extra\n'):
            with self.subTest(damaged=damaged[:0] or damaged.count('\n')):
                self.assertNotEqual(damaged, good)
                self.relay.write_text(damaged)
                self.output.seek(0)
                self.output.truncate()
                self.assertFalse(self.run_status())
                self.assertIn('missing or outdated', self.output.getvalue())

    def test_missing_wrapper_requires_refresh(self):
        self.relay.unlink()
        self.assertFalse(self.run_status())
        self.assertIn('missing or outdated', self.output.getvalue())

    def test_missing_extension_has_store_link_and_profile(self):
        self.extension.update(enabled=False, installed=False)
        self.assertFalse(self.run_status())
        self.assertIn('not found in Default', self.output.getvalue())
        self.assertIn('https://official.example/extension', self.output.getvalue())

    def test_disabled_extension_is_not_reinstalled(self):
        self.extension['enabled'] = False
        self.assertFalse(self.run_status())
        self.assertIn('Enable it at chrome://extensions', self.output.getvalue())


def _fake_python(path, record, version_ok=True):
    """An interpreter stand-in that logs its use, then delegates to the real one."""
    path.write_text(
        '#!/bin/sh\n'
        f'if [ "$1" = -c ]; then exit {0 if version_ok else 1}; fi\n'
        f'echo "$0" >> {shlex.quote(str(record))}\n'
        f'exec {shlex.quote(sys.executable)} "$@"\n')
    path.chmod(0o700)


@unittest.skipIf(os.name == 'nt', 'The POSIX launcher is a shell script.')
class PosixRelayLauncherTests(unittest.TestCase):
    """Chrome launches native hosts with launchd's short PATH; run the launcher the same way."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        # Spaces in the path, as in macOS "Application Support".
        self.directory = Path(temporary.name).resolve() / 'Application Support/lcu/browser'
        self.directory.mkdir(parents=True)
        self.record = self.directory / 'used'
        self.script = self.directory / 'lcu-native-host.py'
        _write_private(self.directory, self.script,
                       (Path(__file__).resolve().parents[1] / 'lcu/native_host.py').read_bytes())
        system, name = {'Darwin': ('macos', 'ChatGPT for Chrome'),
                        'Linux': ('linux', 'extension-host')}[platform.system()]
        arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
        host = self.directory / 'chrome/extension-host' / system / arch / name
        host.parent.mkdir(parents=True)
        host.write_text('#!/bin/sh\nexec /bin/cat\n')  # Echoes the relayed frames back.
        host.chmod(0o700)
        self.relay = self.directory / 'lcu-native-host'

    def install_wrapper(self, python, **options):
        _write_private(self.directory, self.relay, _posix_wrapper(str(python), self.script, **options).encode())
        self.assertEqual(self.relay.stat().st_mode & 0o777, 0o700)

    def launch(self, path):
        message = json.dumps({'result': {'type': 'extension', 'agentRequestHeaderEnabled': False}}).encode()
        result = subprocess.run(['/usr/bin/env', '-i', f'PATH={path}', str(self.relay)],
                                input=struct.pack('<I', len(message)) + message,
                                capture_output=True, timeout=60)
        return result, message

    def assert_round_trip(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b'')
        size = struct.unpack('<I', result.stdout[:4])[0]
        self.assertEqual(len(result.stdout), 4 + size)  # Nothing but the framed reply on stdout.
        self.assertEqual(json.loads(result.stdout[4:])['result']['agentRequestHeaderEnabled'], True)

    def used(self):
        return self.record.read_text().splitlines() if self.record.exists() else []

    def test_runs_under_the_selected_interpreter_not_the_path_python(self):
        python = self.directory / 'selected python'
        _fake_python(python, self.record)
        self.install_wrapper(python)
        result, _ = self.launch('/usr/bin:/bin')
        self.assert_round_trip(result)
        self.assertEqual(self.used(), [str(python)])

    def test_missing_interpreter_falls_back_to_a_python_found_on_the_path(self):
        bin_dir = self.directory / 'bin'
        bin_dir.mkdir()
        _fake_python(bin_dir / 'python3', self.record, version_ok=False)  # Too old.
        _fake_python(bin_dir / 'python3.14', self.record)
        self.install_wrapper(self.directory / 'removed/python3.12')
        result, _ = self.launch(f'{bin_dir}:/usr/bin:/bin')
        self.assert_round_trip(result)
        self.assertEqual(self.used(), [str(bin_dir / 'python3.14')])

    def test_system_python_is_a_last_resort_only_when_the_relay_can_run_on_it(self):
        empty = self.directory / 'empty'
        empty.mkdir()
        for version_ok in (True, False):
            with self.subTest(version_ok=version_ok):
                self.record.unlink(missing_ok=True)
                system = self.directory / f'system-python-{version_ok}'
                # The probe mirrors the relay's real minimum, not LCU's 3.12 requirement.
                system.write_text(
                    '#!/bin/sh\n'
                    f'if [ "$1" = -c ]; then {shlex.quote(sys.executable)} "$@"; exit $?; fi\n'
                    f'echo "$0" >> {shlex.quote(str(self.record))}\n'
                    f'exec {shlex.quote(sys.executable)} "$@"\n')
                system.chmod(0o700)
                minimum = _RELAY_MINIMUM if version_ok else (99, 0)
                with mock.patch('lcu.browser._RELAY_MINIMUM', minimum):
                    self.install_wrapper(self.directory / 'removed/python', extra_dirs=[str(empty)],
                                         system_python=str(system))
                result, _ = self.launch(str(empty))
                if version_ok:
                    self.assert_round_trip(result)
                    self.assertEqual(self.used(), [str(system)])
                else:
                    self.assertEqual(result.returncode, 127)
                    self.assertEqual(result.stdout, b'')
                    self.assertIn(b'no suitable Python', result.stderr)
                    self.assertEqual(self.used(), [])

    def test_wrapper_quotes_unusual_paths(self):
        python = self.directory / "it's $HOME `x` python"
        _fake_python(python, self.record)
        self.install_wrapper(python)
        result, _ = self.launch('/usr/bin:/bin')
        self.assert_round_trip(result)
        self.assertEqual(self.used(), [str(python)])


class RelaySourceCompatibilityTests(unittest.TestCase):
    def test_relay_source_stays_parseable_by_python_3_8(self):
        source = (Path(__file__).resolve().parents[1] / 'lcu/native_host.py').read_text()
        ast.parse(source, feature_version=_RELAY_MINIMUM)


if __name__ == '__main__':
    unittest.main()
