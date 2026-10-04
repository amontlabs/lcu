"""Registration boundaries for the OMP and Hermes native harness packages."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from lcu import setup


class HarnessSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.home.mkdir()
        self.project = self.root / 'project with spaces'
        self.project.mkdir()
        self.release = self.root / 'release'
        adapter = self.release / 'adapters/pi/index.ts'
        adapter.parent.mkdir(parents=True)
        adapter.write_text('export default function () {}')
        hermes = self.release / 'adapters/hermes'
        hermes.mkdir()
        for name in ('plugin.yaml', '__init__.py', 'bridge.mjs'):
            (hermes / name).write_text('fixture ' + name)
        self.command = ['/opt/lcu/current/bin/lcu', '--audio', '--chrome']

    def configure(self, name, *, scope='user', run=None, executable='/bin/omp', env=None):
        with patch.object(setup, 'installer_paths', return_value=(Path('/original/node'), Path('/skills'), Path('/mcp'))), \
             patch.object(setup, 'installed_app_resources', return_value=self.root / 'resources'), \
             patch('shutil.which', return_value=executable), \
             patch('subprocess.run', side_effect=run or (lambda argv, **kw: subprocess.CompletedProcess(argv, 0, '', ''))):
            return setup.configure([name], self.home, self.command,
                                   self.root / 'tools', self.release, scope=scope,
                                   project=self.project if scope == 'project' else None,
                                   environ={'PATH': '/bin', **(env or {})})

    def test_detect_uses_client_path_without_setup_scope_state(self):
        def which(executable):
            return '/mock/bin/omp' if executable == 'omp' else None
        with patch('lcu.setup.shutil.which', side_effect=which):
            self.assertEqual(setup.detect(self.home), ['omp'])

    def test_validate_rejects_profile_scoped_agents_for_project_scope(self):
        for name in ('omp', 'hermes'):
            with self.subTest(agent=name):
                argv = ['--prefix', str(self.root / 'prefix'), '--scope', 'project',
                        '--project', str(self.project), '--agent', name]
                if getattr(os, 'getuid', lambda: None)() == 0:
                    argv += ['--user', 'root']
                args = setup.parser().parse_args(argv)
                with self.assertRaisesRegex(ValueError, 'project scope is not supported'):
                    setup.validate(args)

    def test_omp_native_link_preserves_scope_and_command_without_a_skill(self):
        calls = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, '', '')

        for profile in ('blue', 'green'):
            self.assertEqual(self.configure('omp', run=run, env={'OMP_PROFILE': profile}), [])
            argv, options = calls[-1]
            self.assertEqual(argv[:3], ['/bin/omp', 'plugin', 'link'])
            package = Path(argv[3])
            manifest = json.loads((package / 'package.json').read_text())
            self.assertEqual(manifest['omp']['extensions'], ['./index.ts'])
            wrapper = (package / 'index.ts').read_text()
            specifier = json.loads(wrapper.split('import lcu from ', 1)[1].split(';', 1)[0])
            self.assertTrue(specifier.startswith('.'))
            self.assertEqual((package / specifier).resolve(), self.release / 'adapters/pi/index.ts')
            self.assertIn(json.dumps(self.command), wrapper)
            self.assertIn('connectOnLoad: true', wrapper)
            self.assertIn('ompEssentialTools: true', wrapper)
            self.assertFalse((package / 'skills').exists())
            self.assertEqual(options['cwd'], self.home)
            self.assertEqual(options['env']['HOME'], str(self.home))
        self.assertNotEqual(calls[0][0][-1], calls[1][0][-1])
        self.assertFalse((self.project / '.pi').exists())

    def test_omp_rejects_project_scope_without_installing_globally(self):
        calls = []
        failures = self.configure('omp', scope='project', run=lambda *args, **kwargs: calls.append(args))
        self.assertIn('project scope is not supported', failures[0][2])
        self.assertEqual(calls, [])
        self.assertFalse((self.home / '.local/share/lcu/omp').exists())

    def test_missing_omp_fails_without_creating_a_package(self):
        failures = self.configure('omp', executable=None)
        self.assertEqual(failures[0][:2], ('omp', 'plugin'))
        self.assertIn('not on the target account PATH', failures[0][2])
        self.assertFalse((self.home / '.local/share/lcu/omp').exists())

    def test_omp_installer_failure_is_reported(self):
        def run(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 9, '', 'plugin failed')
        failures = self.configure('omp', run=run)
        self.assertIn('plugin failed', failures[0][2])

    def test_hermes_registers_local_plugin_and_command_without_a_skill(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, '', '')
        self.assertEqual(self.configure('hermes', executable='/bin/hermes', run=run), [])
        self.assertEqual(calls[0][0], ['/bin/hermes', 'plugins', 'enable', 'lcu-cua'])
        self.assertEqual(calls[0][1]['env']['HERMES_HOME'], str(self.home / '.hermes'))
        package = self.home / '.hermes/plugins/lcu-cua'
        self.assertEqual(json.loads((package / 'lcu-config.json').read_text()), {
            'command': self.command, 'node': str(Path('/original/node')),
            'bridge': str(self.release / 'adapters/hermes/bridge.mjs'),
        })
        self.assertFalse((package / 'skills').exists())

    def test_hermes_rejects_project_scope_without_installing_globally(self):
        failures = self.configure('hermes', scope='project', executable='/bin/hermes')
        self.assertIn('project scope is not supported', failures[0][2])
        self.assertFalse((self.home / '.hermes').exists())

    def test_hermes_explicit_profile_owns_both_plugin_and_enable(self):
        profile = self.root / 'custom hermes profile'
        calls = []
        def run(argv, **kwargs):
            calls.append(kwargs)
            return subprocess.CompletedProcess(argv, 0, '', '')
        self.assertEqual(self.configure('hermes', executable='/bin/hermes', run=run,
                                       env={'HERMES_HOME': str(profile)}), [])
        self.assertTrue((profile / 'plugins/lcu-cua/lcu-config.json').is_file())
        self.assertEqual(calls[0]['env']['HERMES_HOME'], str(profile))
        self.assertFalse((self.home / '.hermes').exists())

    def test_profile_paths_must_be_absolute(self):
        for name, variable in (('hermes', 'HERMES_HOME'), ('omp', 'PI_CODING_AGENT_DIR')):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'must be absolute'):
                self.configure(name, env={variable: 'relative/profile'})

    def test_hermes_plugin_symlink_is_never_followed(self):
        plugins = self.home / '.hermes/plugins'
        plugins.mkdir(parents=True)
        other = self.root / 'other-plugin'
        other.mkdir()
        (other / 'keep.txt').write_text('untouched')
        (plugins / 'lcu-cua').symlink_to(other, target_is_directory=True)
        failures = self.configure('hermes', executable='/bin/hermes')
        self.assertIn('symlink', failures[0][2])
        self.assertEqual((other / 'keep.txt').read_text(), 'untouched')

    def test_registration_refuses_an_unowned_plugin_directory(self):
        package = self.home / '.hermes/plugins/lcu-cua'
        package.mkdir(parents=True)
        (package / '__init__.py').write_text('user plugin')
        failures = self.configure('hermes', executable='/bin/hermes')
        self.assertIn('unowned plugin directory', failures[0][2])
        self.assertEqual((package / '__init__.py').read_text(), 'user plugin')

    def test_failed_reinstallation_restores_previous_package(self):
        self.assertEqual(self.configure('hermes', executable='/bin/hermes'), [])
        package = self.home / '.hermes/plugins/lcu-cua'
        previous = {p.relative_to(package): p.read_bytes() for p in package.rglob('*') if p.is_file()}
        self.command = ['/changed/runtime']
        failures = self.configure('hermes', executable='/bin/hermes',
            run=lambda argv, **kw: subprocess.CompletedProcess(argv, 1, '', 'enable failed'))
        self.assertIn('enable failed', failures[0][2])
        self.assertEqual({p.relative_to(package): p.read_bytes() for p in package.rglob('*') if p.is_file()}, previous)

    def test_failed_package_swap_restores_previous_package(self):
        self.assertEqual(self.configure('hermes', executable='/bin/hermes'), [])
        package = self.home / '.hermes/plugins/lcu-cua'
        previous = (package / 'lcu-config.json').read_bytes()
        replace = os.replace
        def fail_stage(source, target):
            if Path(source).name == 'next':
                raise OSError('fixture rename failure')
            return replace(source, target)
        with patch('lcu.harness_setup.os.replace', side_effect=fail_stage):
            failures = self.configure('hermes', executable='/bin/hermes')
        self.assertIn('fixture rename failure', failures[0][2])
        self.assertEqual((package / 'lcu-config.json').read_bytes(), previous)


if __name__ == '__main__':
    unittest.main()
