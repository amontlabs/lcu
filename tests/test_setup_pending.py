"""Harnesses installed after setup: --allow-missing, the pending record and --reconcile."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import setup, status
import setup_host

ALL = ('pi', 'codex', 'claude-code', 'omp', 'hermes')


class Fixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.prefix = self.root / 'prefix'
        self.home = self.root / 'home'
        self.home.mkdir()
        setup_host.make_runtime(self.prefix)
        self.installed = set()
        self.registered = []
        self.failing = set()
        self.account = setup_host.account(self.home)

    def configure(self, names, home, command, *args, **kwargs):
        self.registered.append({'names': list(names), 'command': command, **kwargs})
        failures = []
        for name in names:
            if name in self.failing:
                failures.append((name, 'plugin', 'boom'))
            else:
                print(f'{name} registered')
        return failures

    def which(self, executable, path=None):
        return f'/fixture/{executable}' if executable in {setup.CLIENTS[n].executable for n in self.installed} else None

    def run_main(self, *argv, agents=ALL, reconcile=False):
        out, err = io.StringIO(), io.StringIO()
        code = 0
        patches = [patch.object(setup.sys, 'platform', setup_host.PLATFORM),
                   patch.object(setup, 'installer_environment'), patch.object(setup, 'installer_paths'),
                   patch.object(setup, 'configure', side_effect=self.configure),
                   patch.object(setup.shutil, 'which', side_effect=self.which),
                   patch.object(setup.subprocess, 'run',
                                return_value=SimpleNamespace(returncode=0, stdout='', stderr=''))]
        if not reconcile:
            patches.append(patch.object(setup, 'validate', return_value=(self.account, list(agents))))
        elif setup_host.WINDOWS:
            # Windows setup selects the signed-in account and its profile.
            patches += [patch.object(setup.getpass, 'getuser', return_value=self.account.pw_name),
                        patch.dict(os.environ, {'USERPROFILE': self.account.pw_dir})]
        else:
            patches += [patch.object(setup.pwd, 'getpwuid', return_value=self.account),
                        patch.object(setup.pwd, 'getpwnam', return_value=self.account)]
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            stack.enter_context(contextlib.redirect_stdout(out))
            stack.enter_context(contextlib.redirect_stderr(err))
            try:
                setup.main(['--prefix', str(self.prefix), '--session', 'direct', '--yes', '--no-chrome',
                            *argv] if not reconcile else ['--prefix', str(self.prefix), '--reconcile',
                                *(['--user', 'fixture'] if setup_host.is_root() else []), *argv])
            except SystemExit as exc:
                code = exc.code or 0
        return code, out.getvalue(), err.getvalue()

    def state(self):
        return setup.load_setup_state(self.home)

    def write_state(self, document):
        path = setup.setup_state_path(self.home)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document))


class StateSchemaTests(Fixture):
    def test_old_file_without_new_fields_loads_with_nothing_pending(self):
        self.write_state({'chrome': True, 'audio': False})
        self.assertEqual(self.state(), {'chrome': True, 'audio': False, 'approval': 'ask',
                                        'pending': [], 'pending_context': None})

    def test_round_trip_and_unpending_state_omits_the_new_fields(self):
        context = {'scope': 'user', 'project': None, 'session': 'direct'}
        setup.save_setup_state(self.home, chrome=False, audio=True, approval='auto', pending=['pi', 'pi', 'omp'],
                               pending_context=context)
        self.assertEqual(self.state()['pending'], ['pi', 'omp'])
        self.assertEqual(self.state()['pending_context'], context)
        setup.save_setup_state(self.home, chrome=False, audio=True)
        self.assertEqual(json.loads(setup.setup_state_path(self.home).read_text()),
                         {'chrome': False, 'audio': True, 'approval': 'ask'})

    def test_malformed_pending_is_rejected(self):
        for pending in ('pi', ['codex'], [1], ['nope']):
            with self.subTest(pending=pending):
                self.write_state({'chrome': False, 'audio': False, 'pending': pending})
                with self.assertRaisesRegex(ValueError, 'Malformed'):
                    self.state()
        self.write_state({'chrome': False, 'audio': False, 'pending': ['pi'], 'pending_context': {'scope': 'x'}})
        with self.assertRaisesRegex(ValueError, 'Malformed'):
            self.state()


class AllowMissingTests(Fixture):
    def test_missing_harnesses_are_skipped_and_recorded_and_exit_is_zero(self):
        self.installed = {'pi'}
        code, out, err = self.run_main('--allow-missing', '--approval', 'auto')
        self.assertEqual(code, 0, err)
        self.assertEqual(self.registered[0]['names'], ['pi', 'codex', 'claude-code'])
        self.assertEqual(self.registered[0]['approval'], 'auto')
        self.assertIn('Oh My Pi: not installed; will register when it appears', out)
        self.assertIn('Hermes: not installed; will register when it appears', out)
        self.assertIn('Registered now: pi, codex, claude-code.', out)
        self.assertIn('Pending (not installed): omp, hermes.', out)
        state = self.state()
        self.assertEqual((state['approval'], state['pending']), ('auto', ['omp', 'hermes']))
        self.assertEqual(state['pending_context'], {'scope': 'user', 'project': None, 'session': 'direct'})

    def test_everything_missing_still_registers_codex_and_claude(self):
        code, out, _ = self.run_main('--allow-missing')
        self.assertEqual(code, 0)
        self.assertEqual(self.registered[0]['names'], ['codex', 'claude-code'])
        self.assertEqual(self.state()['pending'], ['pi', 'omp', 'hermes'])

    def test_real_failure_is_nonzero_and_retry_keeps_the_flag(self):
        self.installed = {'pi', 'omp'}
        self.failing = {'omp'}
        code, out, err = self.run_main('--allow-missing')
        self.assertEqual(code, 1)
        self.assertIn('--allow-missing', err)
        self.assertIn('--agent omp', err)

    def test_without_the_flag_a_missing_harness_is_still_attempted(self):
        code, _, _ = self.run_main()
        self.assertEqual(self.registered[0]['names'], list(ALL))
        self.assertEqual(self.state()['pending'], [])

    def test_explicit_registration_clears_a_pending_entry_and_keeps_others(self):
        self.run_main('--allow-missing')
        self.installed = {'omp'}
        self.run_main('--allow-missing', agents=('omp',))
        self.assertEqual(self.state()['pending'], ['pi', 'hermes'])

    def test_later_approval_updates_the_saved_mode_and_keeps_pending(self):
        self.run_main('--allow-missing')
        self.run_main('--approval', 'auto', agents=('codex',))
        state = self.state()
        self.assertEqual((state['approval'], state['pending']), ('auto', ['pi', 'omp', 'hermes']))

    @unittest.skipIf(setup_host.WINDOWS, 'Windows setup refuses --export before checking --allow-missing')
    def test_export_and_allow_missing_conflict(self):
        args = setup.parser().parse_args(['--export', '/tmp/x', '--allow-missing'])
        with self.assertRaisesRegex(ValueError, 'cannot be combined with --export'):
            setup.validate(args)


class ReconcileTests(Fixture):
    def pend(self, names=('pi', 'omp', 'hermes'), **saved):
        self.write_state({'chrome': saved.get('chrome', False), 'audio': saved.get('audio', True),
                          'approval': saved.get('approval', 'auto'), 'pending': list(names),
                          'pending_context': {'scope': 'user', 'project': None, 'session': 'direct'}})

    def test_no_pending_is_a_silent_noop_without_lock_or_subprocess(self):
        with patch.object(setup, 'setup_lock', side_effect=AssertionError('locked')):
            code, out, err = self.run_main(reconcile=True)
        self.assertEqual((code, out, err, self.registered), (0, '', '', []))
        self.assertFalse(setup.setup_state_path(self.home).exists())

    def test_pending_without_binary_is_a_silent_noop(self):
        self.pend()
        before = setup.setup_state_path(self.home).read_bytes()
        code, out, err = self.run_main(reconcile=True)
        self.assertEqual((code, out, err, self.registered), (0, '', '', []))
        self.assertEqual(setup.setup_state_path(self.home).read_bytes(), before)

    def test_installed_pending_harness_is_registered_with_saved_settings_and_removed(self):
        self.pend(approval='auto', audio=True)
        self.installed = {'omp', 'codex'}
        code, out, err = self.run_main(reconcile=True)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.registered), 1)
        call = self.registered[0]
        self.assertEqual(call['names'], ['omp'])
        self.assertEqual(call['command'], [*setup_host.direct_command(self.prefix), '--audio'])
        self.assertEqual((call['approval'], call['scope']), ('auto', 'user'))
        self.assertIn('Registered: omp', out)
        state = self.state()
        self.assertEqual(state['pending'], ['pi', 'hermes'])
        self.assertEqual((state['approval'], state['audio']), ('auto', True))
        # Idempotent: the next run has nothing to do.
        self.registered.clear()
        self.assertEqual(self.run_main(reconcile=True), (0, '', ''))
        self.assertEqual(self.registered, [])

    def test_saved_ask_leaves_approval_alone(self):
        self.pend(approval='ask')
        self.installed = {'pi'}
        self.run_main(reconcile=True)
        self.assertIsNone(self.registered[0]['approval'])

    @unittest.skipIf(setup_host.WINDOWS, 'Windows has only direct sessions')
    def test_saved_project_scope_and_session_are_used(self):
        project = self.root / 'project'
        project.mkdir()
        self.write_state({'chrome': False, 'audio': False, 'approval': 'ask', 'pending': ['pi'],
                          'pending_context': {'scope': 'project', 'project': str(project), 'session': 'discover'}})
        self.installed = {'pi'}
        code, _, err = self.run_main(reconcile=True)
        self.assertEqual(code, 0, err)
        call = self.registered[0]
        self.assertEqual((call['scope'], call['project']), ('project', project))
        self.assertEqual(call['command'][0], str(self.prefix / 'current/bin/lcu-session'))

    def test_partial_failure_keeps_only_the_failed_harness_pending_and_exits_nonzero(self):
        self.pend()
        self.installed = {'pi', 'omp'}
        self.failing = {'omp'}
        code, out, err = self.run_main(reconcile=True)
        self.assertEqual(code, 1)
        self.assertIn('still pending: omp, hermes', err)
        self.assertEqual(self.state()['pending'], ['omp', 'hermes'])

    def test_never_touches_harnesses_that_are_not_pending(self):
        self.pend(names=('hermes',))
        self.installed = set(ALL)
        self.run_main(reconcile=True)
        self.assertEqual(self.registered[0]['names'], ['hermes'])

    def test_binary_in_a_user_directory_outside_path_is_found(self):
        self.pend(names=('pi',))
        (self.home / '.bun/bin').mkdir(parents=True)
        tool = self.home / ('.bun/bin/pi.cmd' if setup_host.WINDOWS else '.bun/bin/pi')
        tool.write_text('#!/bin/sh\n')
        tool.chmod(0o755)
        self.assertTrue(setup.harness_installed('pi', self.home, '/nonexistent'))
        self.assertFalse(setup.harness_installed('omp', self.home, '/nonexistent'))

    def test_options_that_would_override_the_saved_setup_are_rejected(self):
        for flag in (['--approval', 'auto'], ['--agent', 'pi'], ['--chrome'], ['--allow-missing'],
                     ['--scope', 'project']):
            with self.subTest(flag=flag):
                argv = ['--reconcile', *flag]
                if setup_host.is_root():
                    argv += ['--user', 'root']
                with self.assertRaisesRegex(ValueError, 'cannot be combined'):
                    setup.validate(setup.parser().parse_args(argv))

    def test_a_held_lock_blocks_reconcile_and_the_waiter_then_finds_nothing_to_do(self):
        self.pend(names=('pi',))
        self.installed = {'pi'}
        result = {}
        finished = threading.Event()

        def run():
            result['value'] = self.run_main(reconcile=True)
            finished.set()

        # Hold the lock from a separate process, as a concurrent setup would.
        holder = subprocess.Popen([sys.executable, '-c', (
            'import sys\n'
            f'sys.path.insert(0,{str(Path(setup.__file__).parents[1])!r})\n'
            'from pathlib import Path\nfrom lcu import setup\n'
            f'with setup.setup_lock(Path({str(self.home)!r})):\n'
            ' print("held",flush=True)\n sys.stdin.read()')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.kill)
        self.assertEqual(holder.stdout.readline().strip(), 'held')
        thread = threading.Thread(target=run)
        thread.start()
        self.assertFalse(finished.wait(0.7), 'reconcile must wait for the setup lock')
        self.assertEqual(self.registered, [])
        # The lock holder finishes the registration itself and clears the pending entry.
        setup.save_setup_state(self.home, chrome=False, audio=True, approval='auto')
        holder.stdin.close()
        thread.join(10)
        self.assertTrue(finished.is_set())
        self.assertEqual(result['value'], (0, '', ''))
        self.assertEqual(self.registered, [])


class StatusTests(Fixture):
    def test_status_reports_pending_machine_readably(self):
        with patch.object(status.Path, 'home', return_value=self.home):
            self.assertIsNone(status.saved_setup())
            setup.save_setup_state(self.home, chrome=False, audio=False, pending=['pi'],
                                   pending_context={'scope': 'user', 'project': None, 'session': 'direct'})
            self.assertEqual(status.saved_setup()['pending'], ['pi'])


if __name__ == '__main__':
    unittest.main()
