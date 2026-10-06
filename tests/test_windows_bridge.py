"""The retained Windows install-time bridge (scripts/install_windows.py) and
the compatibility windows_launcher.py trampoline. Ported from the copy-related cases of tests/test_build_windows.py
and tests/test_windows_setup.py; fixtures only."""
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = _load('install_windows', 'install_windows.py')


def _load_trampoline():
    loader = importlib.machinery.SourceFileLoader('windows_launcher_trampoline',
                                                  str(ROOT / 'scripts/windows_launcher.py'))
    spec = importlib.util.spec_from_loader('windows_launcher_trampoline', loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def _official(base):
    official = base / 'official-app'
    official.mkdir()
    (official / 'AppxManifest.xml').write_text(
        '<Package><Identity Name="OpenAI.Codex" '
        'Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" '
        'Version="27.100.1.0" ProcessorArchitecture="x64"/></Package>')
    for relative in bridge.WINDOWS_REQUIRED_FILES:
        file = official / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        data = relative.encode()
        if relative.endswith('cua_node/manifest.json'):
            data = json.dumps({'platform': 'windows', 'arch': 'x64',
                               'runtime_archive_version': 'runtime-fixture'}).encode()
        file.write_bytes(data)
    (official / 'app/resources/NOTICE.txt').write_text('original notice')
    inventory = bridge.application_inventory(official)
    return official, SimpleNamespace(app=official, version='27.100.1.0', runtime_version='runtime-fixture',
                                     inventory=inventory, inventory_digest=bridge.inventory_sha256(inventory))


class WindowsBridgeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.source = self.base / 'source'
        self.source.mkdir()
        (self.source / 'runtime.lock.json').write_text(json.dumps({'platforms': {'windows': {
            'architectures': {'x64': {}}}}}))
        self.prefix = self.base / 'LCU'

    def _windows(self, **patches):
        stack = [mock.patch.object(bridge.platform, 'system', return_value='Windows'),
                 mock.patch.object(bridge.platform, 'machine', return_value='AMD64'),
                 mock.patch.object(bridge, 'SOURCE', self.source),
                 mock.patch.object(bridge, 'architecture', return_value='x64'),
                 mock.patch.object(bridge, 'verify')]
        stack += [mock.patch.object(bridge, name, **value) for name, value in patches.items()]
        return stack

    def test_missing_registered_app_has_official_download_link_before_prefix_writes(self):
        patches = self._windows(resolve_installed_windows_app={'side_effect': ValueError(
            'Install the official ChatGPT MSIX for this Windows account first.')})
        with contextlib_exit(patches), mock.patch('sys.stderr', io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'chatgpt.com/download/'):
                bridge.prepare_generation(self.prefix)
        self.assertFalse(self.prefix.exists())

    def test_installer_selects_registered_msix_before_mutating_prefix(self):
        patches = self._windows(resolve_installed_windows_app={'side_effect': ValueError('MSIX is not registered')})
        with contextlib_exit(patches), mock.patch('sys.stderr', io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'MSIX is not registered'):
                bridge.prepare_generation(self.prefix)
        self.assertFalse(self.prefix.exists())

    def test_stages_full_package_and_keeps_generations_on_invalid_copy(self):
        official, selected = _official(self.base)
        patches = self._windows(resolve_installed_windows_app={'return_value': selected},
                                checked_prefix={'return_value': self.prefix})
        with contextlib_exit(patches), mock.patch('sys.stderr', io.StringIO()) as stderr:
            generation, _ = bridge.prepare_generation(self.prefix)
            self.assertEqual(generation, self.prefix / 'apps' / selected.inventory_digest)
            self.assertIn('Copying the original application', stderr.getvalue())
            self.assertEqual(json.loads((generation / 'inventory.json').read_text()), selected.inventory)
            self.assertEqual((generation / 'inventory.json').read_text(),
                             json.dumps(selected.inventory, sort_keys=True, separators=(',', ':')) + '\n')
            self.assertEqual((generation / 'app/app/resources/NOTICE.txt').read_text(), 'original notice')
            self.assertTrue((self.prefix / '.lcu-install').is_file())
            # A second run reuses the validated generation.
            self.assertEqual(bridge.prepare_generation(self.prefix)[0], generation)
            # A failed copy leaves no stage behind.
            (generation / 'inventory.json').unlink()
            for child in sorted(generation.rglob('*'), reverse=True):
                child.unlink() if child.is_file() else child.rmdir()
            generation.rmdir()
            with mock.patch.object(bridge, '_validated_copy', side_effect=ValueError('copied bytes changed')):
                with self.assertRaisesRegex(ValueError, 'copied bytes changed'):
                    bridge.prepare_generation(self.prefix)
            self.assertEqual(list((self.prefix / 'apps').iterdir()), [])
            generation, _ = bridge.prepare_generation(self.prefix)
            (generation / 'app' / bridge.WINDOWS_REQUIRED_FILES[2]).write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'differs from selected source inventory'):
                bridge.prepare_generation(self.prefix)
            (generation / 'inventory.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'differs from the selected Store app'):
                bridge.prepare_generation(self.prefix)
        self.assertEqual((official / 'app/resources/NOTICE.txt').read_text(), 'original notice')

    def test_hands_over_to_the_private_node_with_the_generation_and_original_arguments(self):
        generation = self.prefix / 'apps' / ('a' * 64)
        environ = {'NODE_OPTIONS': '--require /evil.cjs', 'KEEP': 'x', '__LCU_Q_NODE_PATH': 'injected'}
        with mock.patch.object(bridge, 'prepare_generation', return_value=(generation, None)) as prepare, \
             mock.patch.dict(bridge.os.environ, environ, clear=True), \
             mock.patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(returncode=3)) as run:
            status = bridge.main(['--prefix', str(self.prefix), '--agent', 'pi', '--audio'])
        self.assertEqual(status, 3)
        prepare.assert_called_once_with(self.prefix)
        self.assertEqual(run.call_args.args[0], [
            str(generation / 'app/app/resources/cua_node/bin/node.exe'), '--disable-warning=ExperimentalWarning',
            str(bridge.SOURCE / 'scripts/install_windows.mjs'), '--app-generation', str(generation),
            '--legacy-python', sys.executable, '--prefix', str(self.prefix), '--agent', 'pi', '--audio'])
        self.assertFalse(run.call_args.kwargs['check'])
        # Review R4: Node's startup variables are quarantined (scripts/startup_env.mjs restores them).
        self.assertEqual(run.call_args.kwargs['env'], {
            'KEEP': 'x', '__LCU_Q_NODE_OPTIONS': '--require /evil.cjs', '__LCU_Q': 'NODE_OPTIONS'})

    @unittest.skipUnless(shutil.which('node'), 'needs node')
    def test_a_caller_preload_never_runs_in_the_installer_node(self):
        generation = self.base / 'apps' / ('a' * 64)
        node = generation / 'app/app/resources/cua_node/bin/node.exe'
        node.parent.mkdir(parents=True)
        node.write_text(f'#!/bin/sh\nexec "{shutil.which("node")}" "$@"\n')
        node.chmod(0o755)
        marker = self.base / 'preload.cjs'
        marker.write_text("process.stdout.write('CALLER_PRELOAD_EXECUTED\\n');\n")
        archive = self.base / 'archive'
        (archive / 'scripts').mkdir(parents=True)
        (archive / 'scripts/startup_env.mjs').write_bytes((ROOT / 'scripts/startup_env.mjs').read_bytes())
        (archive / 'lcu').mkdir()
        (archive / 'lcu/startup_vars.mjs').write_bytes((ROOT / 'lcu/startup_vars.mjs').read_bytes())
        (archive / 'scripts/install_windows.mjs').write_text(
            "import './startup_env.mjs';\n"
            "process.stdout.write(`INSTALLER ${process.env.NODE_OPTIONS === undefined ? 'clean' : process.env.NODE_OPTIONS}\\n`);\n")
        env = dict(os.environ, NODE_OPTIONS=f'--require {marker}')
        with mock.patch.object(bridge, 'prepare_generation', return_value=(generation, None)), \
             mock.patch.object(bridge, 'SOURCE', archive), mock.patch.dict(bridge.os.environ, env, clear=True):
            captured = subprocess.run
            outputs = []
            def run(command, **kwargs):
                done = captured(command, capture_output=True, text=True, **kwargs)
                outputs.append(done)
                return done
            with mock.patch.object(bridge.subprocess, 'run', side_effect=run):
                status = bridge.main(['--runtime-only'])
        self.assertEqual(status, 0, outputs[0].stderr)
        # The installer entry restores the caller's value (for its children) after Node started without it.
        self.assertEqual(outputs[0].stdout, f'INSTALLER --require {marker}\n')

    def test_python_312_is_required_before_any_write(self):
        patches = self._windows(resolve_installed_windows_app={'side_effect': AssertionError('selection reached')})
        with contextlib_exit(patches), mock.patch.object(bridge.sys, 'version_info', (3, 11, 9)):
            with self.assertRaisesRegex(ValueError, r'^Python 3\.12 or later is required\.$'):
                bridge.prepare_generation(self.prefix)
        self.assertFalse(self.prefix.exists())

    def test_bad_arguments_fail_before_the_copy(self):
        with mock.patch.object(bridge, 'prepare_generation', side_effect=AssertionError('copy reached')), \
             mock.patch('sys.stderr', io.StringIO()) as stderr:
            for argv, message in ((['--runtime-only', '--agent', 'codex'], '--runtime-only cannot include agent setup options'),
                                  ([], 'Choose --agent NAME or --runtime-only. Agents: codex, claude-code, pi, omp, hermes'),
                                  (['--app-generation', 'x', '--runtime-only'], 'unrecognized arguments: --app-generation x')):
                with self.assertRaises(SystemExit) as raised:
                    bridge.main(argv)
                self.assertEqual(raised.exception.code, 2)
                self.assertIn(f'install_windows.py: error: {message}', stderr.getvalue())

    def test_rejects_redirected_prefix_ancestor(self):
        link = self.base / 'junction'
        target = self.base / 'other'
        target.mkdir()
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'linked Windows installation path'):
            bridge.checked_prefix(link / 'lcu')

    def test_rejects_windows_junction_prefix_ancestor(self):
        prefix = self.base / 'junction' / 'lcu'
        junction = prefix.parent
        if not hasattr(Path, 'is_junction'):
            self.skipTest('Path.is_junction needs Python 3.12')
        with mock.patch.object(Path, 'is_junction', autospec=True, side_effect=lambda path: path == junction):
            with self.assertRaisesRegex(ValueError, 'linked Windows installation path'):
                bridge.checked_prefix(prefix)

    def test_internal_copy_paths_use_windows_extended_length_spelling(self):
        self.assertEqual(bridge._extended_windows_name('C:\\LCU\\apps\\app'), '\\\\?\\C:\\LCU\\apps\\app')
        self.assertEqual(bridge._extended_windows_name('\\\\server\\share\\app'), '\\\\?\\UNC\\server\\share\\app')
        self.assertEqual(bridge._extended_windows_name('\\\\?\\C:\\already'), '\\\\?\\C:\\already')

    def test_description_and_help_match_the_previous_installer(self):
        self.assertEqual(bridge.build_parser().description,
                         "Install thin LCU beside the current user's official Windows Store app.")
        self.assertEqual(bridge.build_parser().prog, 'install_windows.py')


class WindowsLauncherTrampolineTests(unittest.TestCase):
    def _managed(self, prefix):
        official = prefix.parent / 'official'
        node = official / 'app/resources/cua_node/bin/node.exe'
        node.parent.mkdir(parents=True)
        node.write_text('#!/bin/sh\nexit 0\n')
        (official / 'app/resources/NOTICE é.txt').write_text('notice')
        inventory = bridge.application_inventory(official)
        digest = bridge.inventory_sha256(inventory)
        generation = prefix / 'apps' / digest
        shutil.copytree(official, generation / 'app')
        (generation / 'inventory.json').write_text(json.dumps(inventory, sort_keys=True, separators=(',', ':')) + '\n')
        release = prefix / 'releases' / '1.0.0-abc'
        (release / 'lcu').mkdir(parents=True)
        (release / 'lcu/entry.mjs').write_text('')
        (release / 'installation.json').write_text(json.dumps({'app': str(generation / 'app'), 'sha256': digest}))
        (prefix / 'current.json').write_text(json.dumps({'release': release.name}))
        return release, generation, digest

    def test_selects_release_and_routes_node_and_legacy_releases(self):
        launcher = _load_trampoline()
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary).resolve() / 'prefix'
            prefix.mkdir()
            release = prefix / 'releases' / '0.3.0-123abc'
            (release / 'bin').mkdir(parents=True)
            (release / 'bin/lcu').write_text('fixture')
            (prefix / 'current.json').write_text(json.dumps({'release': release.name}))
            self.assertEqual(launcher.selected_release(prefix), release)
            self.assertEqual(launcher.release_command(prefix, release, ['--version'], {'NODE_OPTIONS': 'x'}),
                             ([sys.executable, '-B', str(release / 'bin/lcu'), '--version'], {'NODE_OPTIONS': 'x'}))
            (prefix / 'current.json').write_text(json.dumps({'release': '../elsewhere'}))
            with self.assertRaisesRegex(ValueError, 'Invalid selected'):
                launcher.selected_release(prefix)

    def test_node_release_runs_only_from_the_validated_generation_with_quarantined_env(self):
        launcher = _load_trampoline()
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary).resolve() / 'prefix'
            prefix.mkdir()
            release, generation, digest = self._managed(prefix)
            node = generation / 'app/app/resources/cua_node/bin/node.exe'
            command, env = launcher.release_command(prefix, release, ['status'], {'NODE_OPTIONS': '--require x', 'K': '1'})
            self.assertEqual(command, [str(node), '--disable-warning=ExperimentalWarning',
                                       str(release / 'lcu/entry.mjs'), 'lcu', 'status'])
            self.assertEqual(env, {'K': '1', '__LCU_Q_NODE_OPTIONS': '--require x', '__LCU_Q': 'NODE_OPTIONS'})
            # Review R3 probe: an app outside the prefix with no digest, then wrong digest / tampered node.exe.
            outside = Path(temporary) / 'outside'
            outside.mkdir()
            (release / 'installation.json').write_text(json.dumps({'app': str(outside)}))
            with self.assertRaisesRegex(ValueError, 'descriptor is incomplete or unsupported'):
                launcher.release_command(prefix, release, [])
            (release / 'installation.json').write_text(json.dumps({'app': str(outside), 'sha256': digest}))
            with self.assertRaisesRegex(ValueError, 'not the managed private generation'):
                launcher.release_command(prefix, release, [])
            (release / 'installation.json').write_text(json.dumps({'app': str(generation / 'app'), 'sha256': digest}))
            node.write_text('#!/bin/sh\necho TAMPERED\n')
            with self.assertRaisesRegex(ValueError, 'differs from selected source inventory'):
                launcher.release_command(prefix, release, [])
            (generation / 'inventory.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'does not match its descriptor'):
                launcher.release_command(prefix, release, [])


class contextlib_exit:
    """Enter a list of patchers together."""
    def __init__(self, patchers):
        self.patchers = patchers

    def __enter__(self):
        for patcher in self.patchers:
            patcher.start()

    def __exit__(self, *exc):
        for patcher in reversed(self.patchers):
            patcher.stop()


if __name__ == '__main__':
    unittest.main()
