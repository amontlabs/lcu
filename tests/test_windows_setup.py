"""Windows setup selects the registered app's exact platform instructions."""

import json
import shutil
import os
from pathlib import Path
import tempfile
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest import mock
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import install_windows
from lcu import setup


class WindowsSetupTests(unittest.TestCase):
    def test_windows_installer_forwards_audio_option_to_shared_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary) / 'LCU'
            release = Path(temporary) / 'release'
            with mock.patch.object(install_windows, 'install', return_value=release) as install, \
                 mock.patch.object(install_windows.subprocess, 'run') as run:
                install_windows.main(['--prefix', str(prefix), '--agent', 'pi', '--audio', '--yes'])
            install.assert_called_once_with(prefix)
            command = run.call_args.args[0]
            self.assertIn('--audio', command)
            self.assertIn('--agent', command)
            self.assertIn('pi', command)

    def test_missing_registered_app_has_official_download_link_before_prefix_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            source = base / 'source'
            source.mkdir()
            (source / 'runtime.lock.json').write_text(json.dumps({'platforms': {'windows': {
                'architectures': {'x64': {}}}}}))
            prefix = base / 'LCU'
            with mock.patch.object(install_windows.platform, 'system', return_value='Windows'), \
                 mock.patch.object(install_windows, 'SOURCE', source), \
                 mock.patch.object(install_windows, 'architecture', return_value='x64'), \
                 mock.patch.object(install_windows, 'verify'), \
                 mock.patch.object(install_windows, 'resolve_installed_windows_app',
                                   side_effect=ValueError(
                                       'Install the official ChatGPT MSIX for this Windows account first.')):
                with self.assertRaisesRegex(ValueError, 'chatgpt.com/download/'):
                    install_windows.install(prefix)
            self.assertFalse(prefix.exists())

    @unittest.skipIf(os.name == 'nt', 'This decoder fixture uses a POSIX executable shebang')
    def test_node_installer_output_decodes_under_legacy_windows_locale(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            home = base / 'home'
            home.mkdir()
            node = base / 'node-fixture'
            node.write_text('#!' + sys.executable + '\n'
                            'import json,sys\n'
                            'args=sys.argv[1:]\n'
                            'if args and args[0].endswith("skills.mjs"):\n'
                            '  print("[]")\n'
                            '  sys.stderr.buffer.write(b"note \\xe2\\x80\\x8f\\n")\n'
                            'elif any("upsertServer" in arg for arg in args):\n'
                            '  print(json.dumps({"path":"' + str(base / 'mcp.json').replace('\\', '\\\\') + '"}))\n')
            node.chmod(0o755)
            adapter = base / 'adapters/claude.mjs'
            adapter.parent.mkdir()
            adapter.write_text('fixture relay')
            shutil.copytree(Path(__file__).resolve().parents[1] / 'adapters/claude-mod', adapter.parent / 'claude-mod')
            with mock.patch.object(setup, 'installer_paths', return_value=(node, base / 'skills.mjs', base / 'mcp.mjs')), \
                 mock.patch.object(setup, 'installed_app_resources', return_value=base / 'resources'), \
                 mock.patch.object(setup, 'host_policy', return_value={}), \
                 mock.patch('subprocess._text_encoding', return_value='cp1252'):
                failures = setup.configure(['claude-code'], home, ['lcu'], base / 'tools', base,
                                           environ={'HOME': str(home), 'PATH': str(base)})
            self.assertEqual(failures, [])

    def test_codex_hooks_use_original_platform_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            resources = base / 'app/resources'
            codex_bin = resources / 'codex-cli/bin'
            codex_bin.mkdir(parents=True)
            release = base / 'release'
            (release / 'adapters').mkdir(parents=True)
            (release / 'adapters/codex.mjs').write_text('fixture relay')
            (release / 'adapters/audio-files.mjs').write_text('fixture helper')
            config = base / 'account/config.toml'
            config.parent.mkdir()
            for system, expected in (('win32', 'codex.exe'), ('linux', 'codex'), ('darwin', 'codex')):
                original_cli = codex_bin / expected
                original_host = codex_bin / ('codex-code-mode-host.exe' if system == 'win32'
                                              else 'codex-code-mode-host')
                original_cli.write_text('original Codex CLI')
                original_host.write_text('original code-mode host')
                def registered(argv, **_options):
                    output = ('[]' if ' list ' in f' {" ".join(map(str, argv))} '
                              else json.dumps({'path': str(config)}))
                    return subprocess.CompletedProcess(argv, 0, output, '')
                with self.subTest(system=system), \
                     mock.patch.object(setup.sys, 'platform', system), \
                     mock.patch.object(setup, 'installer_environment', return_value={'PATH': 'fixture'}), \
                     mock.patch.object(setup, 'installer_paths', return_value=(base / 'node', base / 'skills', base / 'mcp')), \
                     mock.patch.object(setup, 'installed_app_resources', return_value=resources), \
                     mock.patch.object(setup, 'host_policy', return_value={}), \
                     mock.patch.object(setup.subprocess, 'run', side_effect=registered), \
                     mock.patch('lcu.codex_hooks.require_cli_hook_support'), \
                     mock.patch('lcu.codex_hooks.install_hooks') as hooks:
                    self.assertEqual(setup.configure(['codex'], config.parent,
                        ['lcu'], base / 'tools', release), [])
                    self.assertEqual(hooks.call_args.args[0], codex_bin / expected)

    @unittest.skipIf(sys.platform == 'win32', 'Linux discover sessions need a POSIX account')
    def test_linux_discover_setup_keeps_version_probe_on_direct_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary).resolve() / 'lcu'
            binary = prefix / 'current/bin/lcu'
            session = prefix / 'current/bin/lcu-session'
            binary.parent.mkdir(parents=True)
            for path in (binary, session):
                path.write_text('fixture')
                path.chmod(0o755)
            account = SimpleNamespace(pw_name='fixture', pw_uid=os.getuid(), pw_dir=str(prefix.parent))
            with mock.patch.object(setup.sys, 'platform', 'linux'), \
                 mock.patch.object(setup, 'validate', return_value=(account, ['codex'])), \
                 mock.patch.object(setup, 'installer_environment'), \
                 mock.patch.object(setup, 'installer_paths'), \
                 mock.patch.object(setup, 'setup_lock', return_value=nullcontext()), \
                 mock.patch.object(setup, 'configure', return_value=[]), \
                 mock.patch.object(setup.subprocess, 'run') as run:
                setup.main(['--prefix', str(prefix), '--agent', 'codex', '--session', 'discover', '--yes'])
            self.assertEqual(run.call_args_list[0].args[0], [str(binary), '--version'])

    def test_registered_windows_account_and_direct_session_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with mock.patch.object(setup.sys, 'platform', 'win32'), \
                 mock.patch.dict(os.environ, {'USERPROFILE': str(home)}, clear=False):
                args = setup.parser().parse_args(['--prefix', str(home / 'LCU'),
                                                   '--agent', 'codex', '--session', 'direct'])
                account, names = setup.validate(args)
                self.assertEqual((Path(account.pw_dir), names), (home, ['codex']))
                args.session = 'discover'
                with self.assertRaisesRegex(ValueError, 'direct'):
                    setup.validate(args)
                args.session = 'direct'
                args.export = home / 'export'
                with self.assertRaisesRegex(ValueError, 'Windows portable export'):
                    setup.validate(args)

if __name__ == '__main__':
    unittest.main()
