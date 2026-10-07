"""Detect a Computer Use service that outlived an update of its app bundle."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

if sys.platform == 'win32':
    raise unittest.SkipTest('macOS private host')

from lcu.macos_host import (SKY_SERVICE_NAME, SingleFlight, bundle_replaced_at, diagnose_response,
                            diagnose_sky_services, parse_process_start, parse_process_table,
                            SIGNATURE_MISMATCH_MARKERS, PeerLock, executable_path, known_service_executables, lock_holders,
                            recover_response, recover_stale_service, verify_service_signature)

BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app'
EXECUTABLE = f'{BUNDLE}/Contents/MacOS/{SKY_SERVICE_NAME}'
PLIST = f'{BUNDLE}/Contents/Info.plist'
SEAL = f'{BUNDLE}/Contents/_CodeSignature/CodeResources'


def epoch(text):
    return parse_process_start(text.split())


def ps(*lines, returncode=0):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout='\n'.join(lines) + '\n', stderr=''))


def stat_with(times):
    def stat(path):
        if str(path) not in times:
            raise FileNotFoundError(path)
        return SimpleNamespace(st_ctime=epoch(times[str(path)]) if isinstance(times[str(path)], str)
                               else times[str(path)])
    return stat


def whole_bundle(executable, when):
    """Every file the diagnosis reads, with one change time."""
    contents = Path(executable).parents[1]
    return {str(executable): when, str(contents / 'Info.plist'): when,
            str(contents / '_CodeSignature' / 'CodeResources'): when}


class ProcessTableTests(unittest.TestCase):
    def test_parses_pid_start_and_a_path_with_spaces(self):
        services, unparsed = parse_process_table('\n'.join([
            '    1 501 Tue Oct  6 08:00:00 2026     /sbin/launchd',
            f'45404 501 Wed Oct  7 00:34:53 2026     {EXECUTABLE}',
            '  999 501 Wed Oct  7 01:00:00 2026     /usr/bin/ssh',
        ]))
        self.assertEqual(unparsed, 0)
        self.assertEqual(services, [{'pid': 45404, 'uid': 501, 'path': EXECUTABLE,
                                     'started': epoch('Wed Oct 7 00:34:53 2026')}])

    def test_keeps_non_ascii_path_characters(self):
        path = f'/Users/Jos\u00e9/ChatGPT.app/Contents/MacOS/{SKY_SERVICE_NAME}'
        services, _ = parse_process_table(f'7 501 Wed Oct  7 00:34:53 2026 {path}')
        self.assertEqual(services[0]['path'], path)

    def test_counts_unparseable_service_lines_instead_of_guessing(self):
        services, unparsed = parse_process_table('\n'.join([
            f'oops Wed Oct  7 00:34:53 2026 {EXECUTABLE}',
            f'45404 501 Wed Smarch  7 00:34:53 2026 {EXECUTABLE}',
            f'45405 501 Wed Oct  7 25:34:53 2026 {EXECUTABLE}',
            f'45406 501 Wed Oct  7 00:34:53 2026 relative/{SKY_SERVICE_NAME}',
            f'45407 501 Wed Oct  7 00:34:53 2026 /x/{SKY_SERVICE_NAME}Helper',
            f'45408 {SKY_SERVICE_NAME}',
            f'45409 x Wed Oct  7 00:34:53 2026 {EXECUTABLE}',
            'garbage with no service name',
        ]))
        self.assertEqual(services, [])
        self.assertEqual(unparsed, 7)


class BundleTimeTests(unittest.TestCase):
    def test_uses_the_oldest_change_among_executable_plist_and_seal(self):
        stat = stat_with({EXECUTABLE: 300.0, PLIST: 250.0, SEAL: 280.0})
        self.assertEqual(bundle_replaced_at(EXECUTABLE, stat), 250.0)

    def test_one_file_with_a_metadata_change_does_not_read_as_a_replacement(self):
        # chmod or an extended attribute on the executable alone: the plist and seal keep their old ctime.
        stat = stat_with({EXECUTABLE: 900.0, PLIST: 100.0, SEAL: 100.0})
        self.assertEqual(bundle_replaced_at(EXECUTABLE, stat), 100.0)
        run = ps(f'45404 501 Thu Jan  1 00:10:00 1970 {EXECUTABLE}')
        self.assertEqual(diagnose_sky_services(run=run, stat=stat)['stale'], [])

    def test_a_missing_or_unreadable_file_makes_the_time_unknown_not_a_guess(self):
        for present in ({EXECUTABLE: 900.0}, {EXECUTABLE: 900.0, PLIST: 900.0},
                        {EXECUTABLE: 900.0, SEAL: 900.0}, {PLIST: 250.0, SEAL: 250.0}):
            self.assertIsNone(bundle_replaced_at(EXECUTABLE, stat_with(present)), present)
        run = ps(f'45404 501 Thu Jan  1 00:10:00 1970 {EXECUTABLE}')
        diagnosis = diagnose_sky_services(run=run, stat=stat_with({EXECUTABLE: 900.0}))
        self.assertEqual(diagnosis['stale'], [])
        self.assertTrue(diagnosis['services'][0]['bundle_missing'])
        self.assertIsNone(bundle_replaced_at('/' + SKY_SERVICE_NAME, stat_with({'/' + SKY_SERVICE_NAME: 5.0})))


class StartTimeTests(unittest.TestCase):
    def test_start_time_is_read_as_utc_whatever_the_local_zone(self):
        if not hasattr(time, 'tzset'):
            self.skipTest('no tzset')
        previous = os.environ.get('TZ')
        self.addCleanup(lambda: (os.environ.__setitem__('TZ', previous) if previous is not None
                                 else os.environ.pop('TZ', None), time.tzset()))
        # 02:30 happens twice on 2026-10-25 in Paris; a UTC reading has no ambiguity.
        for zone in ('Europe/Paris', 'America/New_York', 'UTC'):
            os.environ['TZ'] = zone
            time.tzset()
            self.assertEqual(parse_process_start('Sun Oct 25 02:30:00 2026'.split()), 1792895400.0)

    def test_ps_is_asked_for_utc_times(self):
        run = ps()
        diagnose_sky_services(run=run, stat=stat_with({}))
        self.assertEqual(run.call_args.kwargs['env']['TZ'], 'UTC')


class DiagnoseTests(unittest.TestCase):
    def test_flags_a_service_started_before_its_bundle_was_replaced(self):
        run = ps(f'45404 501 Tue Oct  6 11:00:00 2026   {EXECUTABLE}')
        stat = stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'))
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [45404])
        self.assertTrue(diagnosis['services'][0]['stale'])
        self.assertNotIn('message', diagnosis)
        self.assertEqual(run.call_args.args[0], ['ps', '-axo', 'pid=,uid=,lstart=,comm='])
        env = run.call_args.kwargs['env']
        self.assertEqual((env['LC_TIME'], env['LC_CTYPE'], env['TZ']), ('C', 'UTF-8', 'UTC'))
        self.assertNotIn('LC_ALL', env)

    def test_a_service_started_after_the_replacement_is_fresh(self):
        run = ps(f'45404 501 Wed Oct  7 00:34:53 2026   {EXECUTABLE}')
        stat = stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'))
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [])
        self.assertNotIn('message', diagnosis)
        self.assertFalse(diagnosis['services'][0]['stale'])

    def test_a_change_within_the_start_time_resolution_is_not_stale(self):
        start = epoch('Wed Oct 7 00:34:53 2026')
        run = ps(f'45404 501 Wed Oct  7 00:34:53 2026   {EXECUTABLE}')
        for replaced, stale in ((start + 1.9, False), (start + 2.5, True)):
            diagnosis = diagnose_sky_services(run=run, stat=stat_with(whole_bundle(EXECUTABLE, replaced)))
            self.assertEqual(diagnosis['stale'] == [45404], stale, replaced)

    def test_no_service_running(self):
        diagnosis = diagnose_sky_services(run=ps('    1 501 Tue Oct  6 08:00:00 2026 /sbin/launchd'),
                                          stat=stat_with({}))
        self.assertEqual(diagnosis, {'services': [], 'stale': [], 'unparsed': 0})

    def test_missing_bundle_is_reported_but_not_flagged(self):
        diagnosis = diagnose_sky_services(run=ps(f'45404 501 Tue Oct  6 11:00:00 2026 {EXECUTABLE}'),
                                          stat=stat_with({}))
        self.assertEqual(diagnosis['stale'], [])
        self.assertTrue(diagnosis['services'][0]['bundle_missing'])
        self.assertIsNone(diagnosis['services'][0]['bundle_replaced'])

    def test_unparseable_output_flags_nothing(self):
        diagnosis = diagnose_sky_services(run=ps(f'??? {EXECUTABLE}', 'not a process table'),
                                          stat=stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026')))
        self.assertEqual((diagnosis['services'], diagnosis['stale'], diagnosis['unparsed']), ([], [], 1))

    def test_only_the_older_of_two_services_is_flagged(self):
        other = '/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/' + SKY_SERVICE_NAME
        run = ps(f'45404 501 Wed Oct  7 00:34:53 2026 {other}',
                 f'  200 501 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        stat = stat_with({**whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'),
                          **whole_bundle(other, 'Wed Oct 7 00:34:50 2026')})
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [200])
        self.assertEqual([service['pid'] for service in diagnosis['services']], [45404, 200])

    def test_ps_failure_is_an_error_response_not_a_guess(self):
        with self.assertRaises(ValueError):
            diagnose_sky_services(run=ps(returncode=1), stat=stat_with({}))
        with patch('lcu.macos_host.diagnose_sky_services', side_effect=subprocess.TimeoutExpired('ps', 2)):
            reply = diagnose_response()
        self.assertFalse(reply['ok'])
        self.assertIn('ps', reply['error'])

    def test_real_file_times_compare_with_process_start(self):
        with tempfile.TemporaryDirectory() as base:
            executable = Path(base) / 'Codex Computer Use.app/Contents/MacOS' / SKY_SERVICE_NAME
            executable.parent.mkdir(parents=True)
            executable.write_text('service')
            (executable.parents[1] / 'Info.plist').write_text('plist')
            (executable.parents[1] / '_CodeSignature').mkdir()
            (executable.parents[1] / '_CodeSignature' / 'CodeResources').write_text('seal')
            changed = os.stat(executable).st_ctime
            older = time.strftime('%a %b %e %H:%M:%S %Y', time.gmtime(changed - 600))
            newer = time.strftime('%a %b %e %H:%M:%S %Y', time.gmtime(changed + 600))
            self.assertEqual(diagnose_sky_services(run=ps(f'10 501 {older} {executable}'))['stale'], [10])
            self.assertEqual(diagnose_sky_services(run=ps(f'10 501 {newer} {executable}'))['stale'], [])

    def test_the_diagnosis_only_lists_processes_and_never_signals_one(self):
        run = ps(f'45404 501 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        with patch('os.kill') as kill, patch('os.killpg') as killpg:
            diagnose_sky_services(run=run, stat=stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026')))
        kill.assert_not_called()
        killpg.assert_not_called()
        run.assert_called_once()


HOME_BUNDLE = '/Users/x/.codex/computer-use/Codex Computer Use.app'
HOME_EXECUTABLE = f'{HOME_BUNDLE}/Contents/MacOS/{SKY_SERVICE_NAME}'
LOCK = '/Users/x/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock.lock'
EXECUTABLES = {EXECUTABLE, HOME_EXECUTABLE}
STALE_START = 'Tue Oct  6 11:00:00 2026'
REPLACED = 'Wed Oct 7 00:21:00 2026'


class FakeWorld:
    """A process table, file times, lock holders, codesign and a kill that only records."""

    def __init__(self, *, pid=4242, uid=501, path=EXECUTABLE, start=STALE_START, holders=None,
                 verdict='invalid', exits_after=1):
        self.pid, self.uid, self.path, self.start = pid, uid, path, start
        self.holder_set = {pid} if holders is None else holders
        self.verdict = verdict
        self.exits_after = exits_after
        self.kills, self.polls, self.clock, self.logs, self.verified = [], 0, 0.0, [], []
        self.kernel = path
        self.table = [self.line(pid, uid, start, path)]
        self.after_check = None
        self.stat = stat_with(whole_bundle(path, REPLACED))

    @staticmethod
    def line(pid, uid, start, path):
        return f'{pid} {uid} {start} {path}'

    def diagnose(self):
        diagnosis = diagnose_sky_services(run=ps(*self.table), stat=self.stat)
        return diagnosis

    def verify(self, pid):
        self.verified.append(pid)
        if self.after_check:
            self.after_check()
        if isinstance(self.verdict, Exception):
            raise self.verdict
        return self.verdict

    def holders(self, lock_path):
        self.lock_paths = getattr(self, 'lock_paths', []) + [lock_path]
        return self.holder_set

    def kernel_path(self, pid):
        return self.kernel

    def kill(self, pid, sig):
        self.kills.append((pid, sig))

    def exists(self, pid):
        self.polls += 1
        return self.polls <= self.exits_after

    def sleep(self, seconds):
        self.clock += seconds

    def monotonic(self):
        return self.clock

    def run(self, **overrides):
        options = dict(lock_path=LOCK, executables=EXECUTABLES, uid=501, diagnose=self.diagnose,
                       verify=self.verify, holders=self.holders, kernel_path=self.kernel_path, kill=self.kill, exists=self.exists,
                       realpath=lambda path: path, sleep=self.sleep, monotonic=self.monotonic,
                       log=self.logs.append)
        options.update(overrides)
        return recover_stale_service(**options)


class RecoveryTests(unittest.TestCase):
    def assertNothingSignaled(self, world, result, reason=None):
        self.assertFalse(result['recovered'], result)
        self.assertEqual(world.kills, [], 'no process may be signaled')
        self.assertEqual(world.logs, [])
        if reason:
            self.assertIn(reason, result['reason'])

    def test_a_provably_stale_lock_holder_gets_one_sigterm_and_is_waited_for(self):
        import signal
        world = FakeWorld(exits_after=3)
        result = world.run()
        self.assertEqual(world.kills, [(4242, signal.SIGTERM)])
        self.assertEqual(result['recovered'], True)
        self.assertEqual((result['pid'], result['path']), (4242, EXECUTABLE))
        self.assertEqual(world.verified, [4242])
        self.assertEqual(world.lock_paths, [LOCK, LOCK], 'checked before the slow checks and again before the signal')
        self.assertEqual(len(world.logs), 1)
        self.assertIn('pid 4242', world.logs[0])
        self.assertIn(EXECUTABLE, world.logs[0])
        self.assertRegex(world.logs[0], r'after \d+ ms')

    def test_the_apps_own_copy_is_a_known_bundle_too(self):
        world = FakeWorld(path=HOME_EXECUTABLE)
        self.assertTrue(world.run()['recovered'])
        self.assertEqual(len(world.kills), 1)

    def test_a_healthy_or_unverifiable_service_is_never_signaled(self):
        for verdict in ('valid', 'unknown', RuntimeError('codesign missing'),
                        subprocess.TimeoutExpired('codesign', 4), OSError('no codesign')):
            world = FakeWorld(verdict=verdict)
            self.assertNothingSignaled(world, world.run())

    def test_a_fresh_service_is_never_a_candidate(self):
        world = FakeWorld(start='Wed Oct  7 00:34:53 2026')
        self.assertNothingSignaled(world, world.run(), 'no stale service')
        self.assertEqual(world.verified, [], 'a fresh service is not even checked')

    def test_no_service_and_a_failing_process_listing_do_nothing(self):
        world = FakeWorld()
        world.table = []
        self.assertNothingSignaled(world, world.run(), 'no stale service')
        broken = FakeWorld()
        result = broken.run(diagnose=Mock(side_effect=subprocess.TimeoutExpired('ps', 2)))
        self.assertNothingSignaled(broken, result, 'check failed')

    def test_pid_one_or_this_process_is_never_signaled(self):
        for pid in (1, 0, os.getpid()):
            world = FakeWorld(pid=pid)
            self.assertNothingSignaled(world, world.run())

    def test_a_process_of_another_user_is_never_signaled(self):
        world = FakeWorld(uid=0)
        self.assertNothingSignaled(world, world.run(), 'another user')
        world = FakeWorld(uid=502)
        self.assertNothingSignaled(world, world.run(), 'another user')

    def test_a_process_with_another_name_is_never_signaled(self):
        world = FakeWorld(path=EXECUTABLE.replace(SKY_SERVICE_NAME, 'ChatGPT'))
        world.table = [world.line(4242, 501, STALE_START, world.path)]
        self.assertNothingSignaled(world, world.run(), 'no stale service')
        # Even if a table somehow produced one, the executable name is checked again.
        world = FakeWorld()
        crafted = {'services': [{'pid': 4242, 'uid': 501, 'path': EXECUTABLE.replace(SKY_SERVICE_NAME, 'ChatGPT'),
                                 'started': 1.0, 'stale': True}]}
        self.assertNothingSignaled(world, world.run(diagnose=lambda: crafted), 'known Computer Use bundle')

    def test_a_service_outside_the_known_bundles_is_never_signaled(self):
        for path in ('/Applications/Other.app/Contents/MacOS/' + SKY_SERVICE_NAME,
                     '/tmp/Codex Computer Use.app/Contents/MacOS/' + SKY_SERVICE_NAME):
            world = FakeWorld(path=path)
            self.assertNothingSignaled(world, world.run(), 'known Computer Use bundle')
        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(executables=set()), 'known Computer Use bundle')

    def test_a_symlinked_path_is_compared_by_real_path(self):
        world = FakeWorld(path='/tmp/link/Contents/MacOS/' + SKY_SERVICE_NAME)
        result = world.run(realpath=lambda path: EXECUTABLE if path.startswith('/tmp/link') else path)
        self.assertTrue(result['recovered'])

    def test_more_than_one_stale_service_does_nothing(self):
        world = FakeWorld()
        world.table.append(world.line(5151, 501, STALE_START, HOME_EXECUTABLE))
        world.stat = stat_with({**whole_bundle(EXECUTABLE, REPLACED), **whole_bundle(HOME_EXECUTABLE, REPLACED)})
        self.assertNothingSignaled(world, world.run(), 'more than one')

    def test_a_healthy_second_service_does_not_stop_recovery_of_the_stale_holder(self):
        world = FakeWorld()
        world.table.append(world.line(5151, 501, 'Wed Oct  7 00:34:53 2026', HOME_EXECUTABLE))
        world.stat = stat_with({**whole_bundle(EXECUTABLE, REPLACED), **whole_bundle(HOME_EXECUTABLE, 'Wed Oct 7 00:34:50 2026')})
        self.assertTrue(world.run()['recovered'])
        self.assertEqual([pid for pid, _ in world.kills], [4242])

    def test_only_the_sole_holder_of_the_lock_is_signaled(self):
        for holders in (set(), {4242, 9999}, {9999}, None):
            world = FakeWorld(holders=set() if holders is None else holders)
            result = world.run(holders=(lambda path: None) if holders is None else world.holders)
            self.assertNothingSignaled(world, result, 'only holder')
            self.assertEqual(world.verified, [], 'the signature is not even checked without the lock')

    def test_a_missing_lock_path_does_nothing(self):
        world = FakeWorld()
        result = world.run(lock_path=None, holders=lock_holders)
        self.assertNothingSignaled(world, result, 'only holder')

    def test_a_reused_pid_or_a_changed_service_between_check_and_signal_is_not_signaled(self):
        for change in (
            lambda world: setattr(world, 'table', [world.line(4242, 501, 'Wed Oct  7 00:40:00 2026', EXECUTABLE)]),
            lambda world: setattr(world, 'table', [world.line(4242, 501, STALE_START, HOME_EXECUTABLE)]),
            lambda world: setattr(world, 'table', [world.line(4242, 502, STALE_START, EXECUTABLE)]),
            lambda world: setattr(world, 'table', []),
            lambda world: setattr(world, 'table', [world.line(7777, 501, STALE_START, EXECUTABLE)]),
        ):
            world = FakeWorld()
            world.stat = stat_with({**whole_bundle(EXECUTABLE, REPLACED), **whole_bundle(HOME_EXECUTABLE, REPLACED)})
            world.after_check = lambda world=world, change=change: change(world)
            self.assertNothingSignaled(world, world.run(), 'changed while')

    def test_the_kernel_reported_executable_must_be_the_known_one(self):
        # argv[0], which ps shows, can be chosen by any process of the same user.
        for kernel in (None, '/bin/sleep', '/tmp/evil/Contents/MacOS/' + SKY_SERVICE_NAME, HOME_EXECUTABLE + 'x'):
            world = FakeWorld()
            world.kernel = kernel
            self.assertNothingSignaled(world, world.run(), 'kernel')
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'kernel', '/bin/sleep')
        self.assertNothingSignaled(world, world.run(), 'changed while')

    def test_a_lock_that_changes_hands_during_the_slow_checks_is_not_signaled(self):
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'holder_set', {9999})
        self.assertNothingSignaled(world, world.run(), 'changed while')
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'holder_set', {4242, 9999})
        self.assertNothingSignaled(world, world.run(), 'changed while')

    def test_an_incomplete_process_listing_does_nothing(self):
        world = FakeWorld()
        world.table.append(f'5151 501 not-a-date {HOME_EXECUTABLE}')
        self.assertNothingSignaled(world, world.run(), 'incomplete')

    def test_observations_that_took_too_long_are_not_acted_on(self):
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'clock', world.clock + 10)
        self.assertNothingSignaled(world, world.run(), 'too long')

    def test_only_one_lcu_host_recovers_at_a_time(self):
        class Peer:
            def __init__(self, acquired, waited):
                self.acquired, self.waited = acquired, waited

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(exclusive=lambda: Peer(False, True)), 'another LCU')
        # Waited for a peer that recovered: nothing stale is left, and the request may retry.
        gone = FakeWorld()
        gone.table = []
        result = gone.run(exclusive=lambda: Peer(True, True))
        self.assertEqual((result['recovered'], gone.kills), (True, []))
        # Waited for a peer, but a stale service is still there: the full checks apply.
        still = FakeWorld()
        self.assertTrue(still.run(exclusive=lambda: Peer(True, True))['recovered'])
        self.assertEqual(len(still.kills), 1)
        # Never waited and nothing stale: no claim of recovery.
        none = FakeWorld()
        none.table = []
        self.assertFalse(none.run(exclusive=lambda: Peer(True, False))['recovered'])

    def test_a_service_that_does_not_exit_is_waited_for_a_bounded_time_and_never_force_killed(self):
        import signal
        world = FakeWorld(exits_after=10 ** 9)
        result = world.run()
        self.assertEqual(world.kills, [(4242, signal.SIGTERM)], 'one SIGTERM and no SIGKILL')
        self.assertFalse(result['recovered'])
        self.assertIn('did not exit', result['reason'])
        self.assertLessEqual(world.clock, 3.2)
        self.assertLessEqual(world.polls, 40)
        self.assertEqual(world.logs, [])

    def test_a_failing_exit_probe_is_not_a_recovery(self):
        world = FakeWorld()
        result = world.run(exists=Mock(side_effect=RuntimeError('probe')))
        self.assertFalse(result['recovered'])
        self.assertEqual(len(world.kills), 1)

    def test_the_signal_is_sigterm_to_one_positive_pid_through_kill_and_nothing_else(self):
        import signal
        world = FakeWorld()
        with patch('os.killpg') as killpg:
            world.run()
        killpg.assert_not_called()
        (pid, sig), = world.kills
        self.assertIs(type(pid), int)
        self.assertGreater(pid, 1)
        self.assertEqual(sig, signal.SIGTERM)
        self.assertNotEqual(sig, signal.SIGKILL)

    def test_the_exit_probe_refuses_pids_that_are_not_one_process(self):
        from lcu.macos_host import _process_exists
        for pid in (0, 1, -1, -4242, True, '4242', None):
            with patch('os.kill') as kill:
                with self.assertRaises(ValueError):
                    _process_exists(pid)
            kill.assert_not_called()

    def test_non_macos_never_looks_for_or_signals_anything(self):
        with patch('lcu.macos_host.sys.platform', 'linux'), patch('os.kill') as kill, \
             patch('lcu.macos_host.subprocess.run') as run:
            self.assertEqual(recover_response(), {'ok': True, 'recovered': False, 'reason': 'not macOS'})
        kill.assert_not_called()
        run.assert_not_called()

    def test_the_default_response_without_a_lock_location_does_nothing(self):
        with patch('lcu.macos_host.sys.platform', 'darwin'), \
             patch('lcu.macos_host.diagnose_sky_services', return_value={'services': []}), \
             patch('os.kill') as kill, patch.dict(os.environ, {}, clear=False):
            os.environ.pop('LCU_MAC_SERVICE_LOCK', None)
            result = recover_response()
        self.assertFalse(result['recovered'])
        kill.assert_not_called()


class CodesignAndLockTests(unittest.TestCase):
    @staticmethod
    def run_with(returncode=0, stdout='', stderr=''):
        return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))

    def test_a_healthy_service_is_valid(self):
        run = self.run_with(0, stderr='4242: dynamically valid\n4242: valid on disk\n'
                                       '4242: satisfies its Designated Requirement\n')
        self.assertEqual(verify_service_signature(4242, run=run), 'valid')
        self.assertEqual(run.call_args.args[0], ['codesign', '--verify', '--strict', '4242'])
        self.assertIsInstance(run.call_args.kwargs['timeout'], int)

    def test_only_a_running_versus_disk_mismatch_is_invalid(self):
        mismatch = '4242: the code on disk does not match what is running'
        self.assertEqual(verify_service_signature(4242, run=self.run_with(1, stderr=mismatch)), 'invalid')
        for result in (self.run_with(1, stderr='4242: no such process'),
                       self.run_with(1, stderr=''),
                       self.run_with(1, stderr='4242: invalid signature (code or signature have been modified)'),
                       self.run_with(1, stderr='4242: a sealed resource is missing or invalid'),
                       self.run_with(1, stderr='4242: invalid or unsupported format for signature'),
                       self.run_with(2, stderr=mismatch),
                       self.run_with(3, stderr=mismatch),
                       Mock(side_effect=subprocess.TimeoutExpired('codesign', 4)),
                       Mock(side_effect=OSError('missing'))):
            self.assertEqual(verify_service_signature(4242, run=result), 'unknown')
        self.assertEqual(SIGNATURE_MISMATCH_MARKERS, ('the code on disk does not match what is running',))

    def test_codesign_runs_with_english_messages(self):
        run = self.run_with(0)
        verify_service_signature(4242, run=run)
        self.assertEqual(run.call_args.kwargs['env']['LC_TIME'], 'C')
        self.assertNotIn('LC_ALL', run.call_args.kwargs['env'])

    def test_lock_holders_parses_lsof_terse_output(self):
        self.assertEqual(lock_holders(LOCK, run=self.run_with(0, stdout='4242\n')), {4242})
        self.assertEqual(lock_holders(LOCK, run=self.run_with(0, stdout='4242\n7\n')), {4242, 7})
        self.assertEqual(lock_holders(LOCK, run=self.run_with(1, stdout='')), set())
        run = self.run_with(0, stdout='4242\n')
        lock_holders(LOCK, run=run)
        self.assertEqual(run.call_args.args[0], ['lsof', '-t', '--', LOCK])

    def test_lock_holders_is_unknown_unless_lsof_answered_cleanly(self):
        for run in (self.run_with(2, stdout=''), self.run_with(0, stdout='lsof: WARNING\n'),
                    self.run_with(1, stdout='4242\n'),  # status 1 may mean an error, not a complete list
                    self.run_with(0, stdout='4242\n', stderr='lsof: WARNING: can not stat() file system\n'),
                    self.run_with(1, stdout='', stderr='lsof: status error\n'),
                    self.run_with(0, stdout=''),
                    Mock(side_effect=subprocess.TimeoutExpired('lsof', 3)), Mock(side_effect=OSError('x'))):
            self.assertIsNone(lock_holders(LOCK, run=run))
        for path in (None, '', 'relative/computeruse.sock.lock'):
            self.assertIsNone(lock_holders(path, run=self.run_with(0, stdout='1\n')))

    def test_the_kernel_executable_path_is_only_asked_for_real_processes_on_macos(self):
        with patch('lcu.macos_host.sys.platform', 'linux'):
            self.assertIsNone(executable_path(os.getpid()))
        for pid in (0, 1, -1, True, '1', None):
            self.assertIsNone(executable_path(pid))
        if sys.platform == 'darwin':
            path = executable_path(os.getpid())
            self.assertTrue(path and os.path.isabs(path) and os.path.exists(path), path)
            self.assertIsNone(executable_path(2 ** 30))

    def test_known_executables_are_the_configured_service_and_the_apps_copy(self):
        environment = {'SKY_CUA_SERVICE_PATH': BUNDLE, 'CODEX_HOME': '/Users/x/.codex'}
        self.assertEqual(known_service_executables(environment, realpath=lambda path: path),
                         {EXECUTABLE, HOME_EXECUTABLE})
        self.assertEqual(known_service_executables({'SKY_CUA_SERVICE_PATH': 'relative.app'}), set())
        self.assertEqual(known_service_executables({}), set())


class PeerLockTests(unittest.TestCase):
    def test_a_second_holder_waits_a_bounded_time_and_then_is_refused(self):
        with tempfile.TemporaryDirectory() as base:
            path = os.path.join(base, 'recovery.lock')
            clock, sleeps = [0.0], []
            with PeerLock(path) as first:
                self.assertTrue(first.acquired)
                self.assertFalse(first.waited)
                second = PeerLock(path, wait_seconds=1, sleep=lambda seconds: (sleeps.append(seconds), clock.__setitem__(0, clock[0] + seconds)),
                                  monotonic=lambda: clock[0])
                with second as held:
                    self.assertFalse(held.acquired)
                    self.assertTrue(held.waited)
                self.assertLessEqual(clock[0], 1.1)
            with PeerLock(path) as later:
                self.assertTrue(later.acquired)

    def test_an_unusable_lock_file_means_not_acquired(self):
        with tempfile.TemporaryDirectory() as base:
            target = os.path.join(base, 'real')
            open(target, 'w').close()
            link = os.path.join(base, 'link')
            os.symlink(target, link)
            with PeerLock(link) as lock:
                self.assertFalse(lock.acquired, 'a symlink is never followed')
            with PeerLock(os.path.join(base, 'missing-dir', 'x.lock')) as lock:
                self.assertFalse(lock.acquired)


class SingleFlightTests(unittest.TestCase):
    def test_a_burst_of_callers_shares_one_run_and_the_next_burst_runs_again(self):
        from threading import Event, Lock, Thread
        release, started, runs = Event(), Event(), []

        def work():
            runs.append(1)
            started.set()
            release.wait(5)
            return {'ok': True, 'run': len(runs)}

        flight = SingleFlight(work)

        class CountingLock:
            """Counts finished lock sections, so followers are known to have joined the run."""
            def __init__(self):
                self.inner, self.sections = Lock(), 0

            def __enter__(self):
                self.inner.acquire()

            def __exit__(self, *exc):
                self.sections += 1
                self.inner.release()

        flight.lock = CountingLock()
        results = []
        threads = [Thread(target=lambda: results.append(flight())) for _ in range(8)]
        threads[0].start()
        self.assertTrue(started.wait(5))
        for thread in threads[1:]:
            thread.start()
        # The leader's first section plus one per follower; none can lead once this holds.
        deadline = time.monotonic() + 5
        while flight.lock.sections < 8 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(flight.lock.sections, 8)
        release.set()
        for thread in threads:
            thread.join(5)
        self.assertEqual(len(runs), 1)
        self.assertEqual(results, [{'ok': True, 'run': 1}] * 8)
        self.assertEqual(flight()['run'], 2)

    def test_a_failing_run_frees_the_flight_and_waiters_do_not_hang(self):
        calls = []

        def work():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError('boom')
            return {'ok': True}

        flight = SingleFlight(work, wait_seconds=0.1)
        with self.assertRaises(RuntimeError):
            flight()
        self.assertEqual(flight(), {'ok': True})


class HostRequestTests(unittest.TestCase):
    def test_host_answers_a_diagnose_request_without_a_session(self):
        from lcu.macos_host import start_original_host, stop_original_host
        with tempfile.TemporaryDirectory() as base:
            client = Path(base) / 'client'
            client.write_text('#!/bin/sh\nexit 0\n')
            client.chmod(0o755)
            process, temporary, address = start_original_host(
                python=Path(sys.executable), client=client,
                entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py', env=os.environ.copy())
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(address)
                    connection.sendall(b'{"type":"diagnose"}\n')
                    response = bytearray()
                    while b'\n' not in response:
                        response.extend(connection.recv(4096))
                reply = json.loads(response)
                self.assertTrue(reply['ok'], reply)
                self.assertIsInstance(reply['services'], list)
                self.assertIsInstance(reply['stale'], list)
                # The host keeps serving turn cleanup afterwards.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(address)
                    connection.sendall(b'{"session_id":"s","turn_id":"t"}\n')
                    self.assertEqual(json.loads(connection.recv(1024)), {'notified': True})
            finally:
                stop_original_host(process, temporary)

    def test_a_slow_diagnosis_does_not_delay_turn_cleanup(self):
        from lcu.macos_host import start_original_host, stop_original_host
        with tempfile.TemporaryDirectory() as base:
            client = Path(base) / 'client'
            client.write_text('#!/bin/sh\nexit 0\n')
            client.chmod(0o755)
            fake_ps = Path(base) / 'bin' / 'ps'
            fake_ps.parent.mkdir()
            fake_ps.write_text('#!/bin/sh\nsleep 1.5\n')
            fake_ps.chmod(0o755)
            env = {**os.environ, 'PATH': f'{fake_ps.parent}{os.pathsep}{os.environ["PATH"]}'}
            process, temporary, address = start_original_host(
                python=Path(sys.executable), client=client,
                entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py', env=env)
            try:
                slow = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                slow.settimeout(8)
                slow.connect(address)
                slow.sendall(b'{"type":"diagnose"}\n')
                time.sleep(0.2)
                started = time.monotonic()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(address)
                    connection.sendall(b'{"session_id":"s","turn_id":"t"}\n')
                    self.assertEqual(json.loads(connection.recv(1024)), {'notified': True})
                self.assertLess(time.monotonic() - started, 1.0)
                response = bytearray()
                while b'\n' not in response:
                    response.extend(slow.recv(4096))
                self.assertTrue(json.loads(response)['ok'])
                slow.close()
            finally:
                stop_original_host(process, temporary)


if __name__ == '__main__':
    unittest.main()
