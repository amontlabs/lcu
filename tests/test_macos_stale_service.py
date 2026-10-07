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

from lcu.macos_host import (CODESIGN, LSOF, PS, SIGNAL_BUDGET_SECONDS, SKY_SERVICE_NAME, SingleFlight,
                            bundle_change_times, bundle_replaced_at, diagnose_sky_services, list_sky_services,
                            parse_process_start, parse_process_table, SIGNATURE_MISMATCH_MARKERS, PeerLock,
                            executable_path, known_service_executables, lock_holders, recover_response,
                            recover_stale_service, requester_waiting, verify_service_signature)

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


def read_line(connection, limit=65536):
    """One reply line; a closed connection ends the read instead of spinning."""
    data = bytearray()
    while b'\n' not in data and len(data) < limit:
        chunk = connection.recv(4096)
        if not chunk:
            break
        data.extend(chunk)
    return bytes(data)


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

    def test_unicode_separators_in_a_path_cannot_forge_rows_or_fields(self):
        fake = f'999 501 Mon Jan  1 00:00:00 2026 {EXECUTABLE}'
        for separator in ('\u2028', '\u2029', '\x85', '\x0b', '\x0c', '\x1c', '\r'):
            real = f'4242 501 Wed Oct  7 00:34:53 2026 /tmp/x{separator}{fake}'
            services, unparsed = parse_process_table(real)
            self.assertEqual(services, [], repr(separator))
            self.assertEqual(unparsed, 1, repr(separator))
        # A crafted name with a Unicode space inside the start time is not a row either.
        services, unparsed = parse_process_table(f'4242 501 Wed Oct\u2002 7 00:34:53 2026 {EXECUTABLE}')
        self.assertEqual((services, unparsed), ([], 1))
        services, _ = parse_process_table(f'4242 501 Wed Oct  7 00:34:53 2026 {EXECUTABLE}\r')
        self.assertEqual([item['pid'] for item in services], [4242], 'a trailing CR from the terminal is just trimmed')

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

    def test_one_pid_can_be_read_with_ps_p_and_a_vanished_one_is_just_absent(self):
        run = ps(f'4242 501 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        services, unparsed = list_sky_services(run=run, pid=4242)
        self.assertEqual(run.call_args.args[0], ['/bin/ps', '-p', '4242', '-o', 'pid=,uid=,lstart=,comm='])
        self.assertEqual(([service['pid'] for service in services], unparsed), ([4242], 0))
        gone = Mock(return_value=SimpleNamespace(returncode=1, stdout='', stderr=''))
        self.assertEqual(list_sky_services(run=gone, pid=4242), ([], 0))
        with self.assertRaises(ValueError):
            diagnose_sky_services(run=gone, stat=stat_with({}))  # a full listing never fails quietly
        with self.assertRaises(ValueError):
            list_sky_services(run=Mock(return_value=SimpleNamespace(returncode=2, stdout='', stderr='')), pid=4242)

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
        self.assertEqual(run.call_args.args[0], ['/bin/ps', '-axo', 'pid=,uid=,lstart=,comm='])
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

    def test_ps_failure_is_an_error_not_a_guess(self):
        with self.assertRaises(ValueError):
            diagnose_sky_services(run=ps(returncode=1), stat=stat_with({}))

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
        self.events, self.order, self.lock_paths, self.selections = [], [], [], []
        self.table = [self.line(pid, uid, start, path)]
        self.after_check = None
        self.on_holders = None
        self.on_times = None
        self.stat = stat_with(whole_bundle(path, REPLACED))

    @staticmethod
    def line(pid, uid, start, path):
        return f'{pid} {uid} {start} {path}'

    def diagnose(self):
        self.order.append('ps')
        self.selections.append(None)
        return diagnose_sky_services(run=ps(*self.table), stat=self.stat)

    def read_process(self, pid):
        self.order.append('ps-pid')
        self.selections.append(pid)
        return list_sky_services(run=ps(*[line for line in self.table if line.split()[0] == str(pid)]), pid=pid)

    def change_times(self, path):
        self.order.append('times')
        if self.on_times:
            self.on_times()
        return bundle_change_times(path, self.stat)

    def verify(self, pid):
        self.order.append('verify')
        self.verified.append(pid)
        if self.after_check:
            self.after_check()
        if isinstance(self.verdict, Exception):
            raise self.verdict
        return self.verdict

    def holders(self, lock_path):
        self.order.append(f'holders{len(self.lock_paths) + 1}')
        self.lock_paths.append(lock_path)
        if self.on_holders:
            self.on_holders(len(self.lock_paths))
        return set(self.holder_set)

    def kernel_path(self, pid):
        self.order.append('kernel')
        return self.kernel

    def kill(self, pid, sig):
        self.order.append('kill')
        self.events.append('kill')
        self.kills.append((pid, sig))

    def exists(self, pid):
        self.events.append('poll')
        self.polls += 1
        return self.polls <= self.exits_after

    def sleep(self, seconds):
        self.clock += seconds

    def monotonic(self):
        return self.clock

    def run(self, **overrides):
        options = dict(lock_path=LOCK, executables=EXECUTABLES, uid=501, diagnose=self.diagnose,
                       read_process=self.read_process, change_times=self.change_times,
                       verify=self.verify, holders=self.holders, kernel_path=self.kernel_path, kill=self.kill,
                       exists=self.exists, realpath=lambda path: path, sleep=self.sleep, monotonic=self.monotonic,
                       waiting=lambda: True, log=self.logs.append)
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
        self.assertEqual(world.selections, [None, 4242], 'the last process read is for that one pid')
        self.assertEqual(world.lock_paths, [LOCK, LOCK], 'checked before the signature and again before the signal')
        self.assertEqual(len(world.logs), 1)
        self.assertIn('pid 4242', world.logs[0])
        self.assertIn(EXECUTABLE, world.logs[0])
        self.assertRegex(world.logs[0], r'exited after \d+ ms')

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
            lambda world: setattr(world, 'table', [world.line(4242, 501, STALE_START, EXECUTABLE)] * 2),
            lambda world: world.table.append(f'4242 501 not-a-date {EXECUTABLE}'),
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

    def test_a_lock_that_changes_hands_during_the_signature_check_is_not_signaled(self):
        for holders in ({9999}, {4242, 9999}, set()):
            world = FakeWorld()
            world.after_check = lambda world=world, holders=holders: setattr(world, 'holder_set', holders)
            self.assertNothingSignaled(world, world.run(), 'lock changed hands')

    def test_an_incomplete_process_listing_does_nothing(self):
        world = FakeWorld()
        world.table.append(f'5151 501 not-a-date {HOME_EXECUTABLE}')
        self.assertNothingSignaled(world, world.run(), 'incomplete')

    def test_checks_that_took_too_long_are_not_acted_on(self):
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'clock', world.clock + SIGNAL_BUDGET_SECONDS + 0.5)
        self.assertNothingSignaled(world, world.run(), 'too long')
        # The budget is measured on the monotonic clock up to the moment of the signal.
        world = FakeWorld()
        world.on_times = lambda: setattr(world, 'clock', world.clock + SIGNAL_BUDGET_SECONDS + 0.5)
        self.assertNothingSignaled(world, world.run(), 'too long')

    def test_nothing_is_signaled_once_the_requester_stopped_waiting(self):
        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(waiting=lambda: False), 'stopped waiting')
        asked = []
        world = FakeWorld()
        world.run(waiting=lambda: (asked.append(list(world.order)), True)[1])
        self.assertEqual(asked, [world.order[:world.order.index('kill')]], 'asked once, right before the signal')
        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(waiting=Mock(side_effect=OSError('closed'))), 'check failed')

    def test_without_a_requester_nothing_is_ever_signaled(self):
        world = FakeWorld()
        result = world.run(waiting=recover_stale_service.__kwdefaults__['waiting'])
        self.assertNothingSignaled(world, result, 'stopped waiting')

    def test_the_final_reads_follow_every_slow_step_and_the_process_is_read_last(self):
        world = FakeWorld()
        peer = self.Peer(events=world.order)
        self.assertTrue(world.run(exclusive=lambda: peer)['recovered'])
        self.assertEqual(world.order[:world.order.index('kill') + 1],
                         ['enter', 'ps', 'kernel', 'holders1', 'verify', 'record', 'holders2', 'times',
                          'ps-pid', 'kernel', 'kill'])

    def test_a_pid_reused_during_the_final_lock_read_is_not_signaled(self):
        world = FakeWorld()

        def reuse(call):
            if call == 2:
                world.table = [world.line(4242, 501, 'Wed Oct  7 00:40:00 2026', '/usr/bin/other')]
                world.kernel = '/usr/bin/other'

        world.on_holders = reuse
        self.assertNothingSignaled(world, world.run(), 'changed while')

    def test_a_healthy_service_that_took_over_the_pid_and_path_is_not_signaled(self):
        # P exits during the final lock read and its pid goes to a service from the same bundle.
        for start in ('Wed Oct  7 00:40:00 2026', 'Tue Oct  6 12:00:00 2026'):
            world = FakeWorld()
            world.on_holders = lambda call, world=world, start=start: (
                setattr(world, 'table', [world.line(4242, 501, start, EXECUTABLE)]) if call == 2 else None)
            self.assertNothingSignaled(world, world.run(), 'changed while')

    def test_a_bundle_restored_after_the_signature_check_is_not_signaled(self):
        # The mismatch was seen against the replacement; restoring the old bundle gives all
        # three files new change times, so the service still looks stale but is not the same case.
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'stat', stat_with(whole_bundle(world.path, 'Wed Oct 7 00:30:00 2026')))
        self.assertNothingSignaled(world, world.run(), 'bundle changed')

    def test_restored_files_are_noticed_even_when_the_oldest_change_time_is_untouched(self):
        world = FakeWorld()
        base = whole_bundle(world.path, REPLACED)
        plist = str(Path(world.path).parents[1] / 'Info.plist')

        def restore():
            changed = dict(base)
            changed[world.path] = 'Wed Oct 7 00:25:00 2026'
            changed[plist] = 'Wed Oct 7 00:26:00 2026'
            world.stat = stat_with(changed)  # the seal keeps the oldest time

        world.after_check = restore
        self.assertNothingSignaled(world, world.run(), 'bundle changed')
        world = FakeWorld()
        world.after_check = lambda: setattr(world, 'stat', stat_with({}))
        self.assertNothingSignaled(world, world.run(), 'bundle changed')

    class Peer:
        def __init__(self, acquired=True, waited=False, previous=None, events=None):
            self.acquired, self.waited, self.previous = acquired, waited, previous
            self.events, self.recorded = events if events is not None else [], []

        def __enter__(self):
            self.events.append('enter')
            return self

        def __exit__(self, *exc):
            self.events.append('exit')
            return False

        def record(self, outcome):
            self.events.append('record')
            self.recorded.append(outcome)
            return True

    def test_the_peer_lock_is_held_until_the_service_has_exited(self):
        world = FakeWorld(exits_after=3)
        peer = self.Peer(events=world.events)
        self.assertTrue(world.run(exclusive=lambda: peer)['recovered'])
        self.assertEqual(world.events, ['enter', 'record', 'kill', 'poll', 'poll', 'poll', 'poll', 'exit'])

    def test_a_refused_peer_lock_does_nothing(self):
        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(exclusive=lambda: self.Peer(False, True)), 'another LCU')

    def test_the_instance_is_recorded_before_the_signal_and_kept(self):
        world = FakeWorld()
        peer = self.Peer()
        world.run(exclusive=lambda: peer)
        self.assertEqual(peer.recorded, [{'pid': 4242, 'started': epoch(STALE_START)}])
        stuck = FakeWorld(exits_after=10 ** 9)
        peer = self.Peer()
        stuck.run(exclusive=lambda: peer)
        self.assertEqual(peer.recorded, [{'pid': 4242, 'started': epoch(STALE_START)}],
                         'a service that did not exit stays recorded as asked')

    def test_a_host_that_waited_for_another_retries_only_when_no_stale_service_is_left(self):
        world = FakeWorld()
        world.table = []
        result = world.run(exclusive=lambda: self.Peer(True, True))
        self.assertTrue(result['recovered'])
        self.assertEqual(world.kills, [])
        world = FakeWorld()
        world.table = []
        self.assertFalse(world.run(exclusive=lambda: self.Peer(True, False))['recovered'],
                         'a host that did not wait has no link to another recovery')

    def test_a_host_that_waited_still_runs_every_check_when_a_service_is_stale(self):
        world = FakeWorld()
        world.verdict = 'valid'
        self.assertNothingSignaled(world, world.run(exclusive=lambda: self.Peer(True, True)))

    def test_an_attempt_that_ends_without_a_signal_is_cleared_again(self):
        for hook in ('on_holders', 'on_times'):
            world = FakeWorld()
            setattr(world, hook, (lambda *args, world=world: setattr(world, 'table', [])
                                  if not args or args[0] == 2 else None))
            peer = self.Peer()
            self.assertNothingSignaled(world, world.run(exclusive=lambda: peer), 'changed while')
            self.assertEqual(peer.recorded, [{'pid': 4242, 'started': epoch(STALE_START)}, {}])
        world = FakeWorld()
        peer = self.Peer()
        self.assertNothingSignaled(world, world.run(exclusive=lambda: peer, waiting=lambda: False), 'stopped waiting')
        self.assertEqual(peer.recorded[-1], {})

    def test_no_record_no_signal(self):
        class Unwritable(self.Peer):
            def record(self, outcome):
                return False

        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(exclusive=lambda: Unwritable()), 'could not be recorded')

    def test_a_host_that_stops_mid_wait_still_leaves_the_attempt_on_record(self):
        peer = self.Peer()
        world = FakeWorld(exits_after=10 ** 9)

        def host_stops(seconds):
            raise SystemExit('the host process is going away')

        with self.assertRaises(SystemExit):
            world.run(exclusive=lambda: peer, sleep=host_stops)
        self.assertEqual(len(world.kills), 1)
        self.assertEqual(len(world.logs), 1, 'a signal that was sent is always logged')
        self.assertEqual(peer.recorded, [{'pid': 4242, 'started': epoch(STALE_START)}])
        # The next host sees that record and does not signal this instance again.
        world = FakeWorld()
        self.assertNothingSignaled(world, world.run(exclusive=lambda: self.Peer(True, False, peer.recorded[0])),
                                   'already asked')

    def test_one_instance_is_never_signaled_twice_whatever_the_clocks_say(self):
        def peer(previous):
            return lambda: self.Peer(True, False, previous)

        asked = {'pid': 4242, 'started': epoch(STALE_START)}
        for wallclock in (0.0, 1e12, -1e12):
            world = FakeWorld()
            world.clock = wallclock
            self.assertNothingSignaled(world, world.run(exclusive=peer(asked)), 'already asked')
        for other in ({**asked, 'pid': 9999}, {**asked, 'started': 1.0}, {}, {'pid': 4242}):
            world = FakeWorld()
            self.assertTrue(world.run(exclusive=peer(other))['recovered'], other)

    def test_a_service_that_does_not_exit_is_waited_for_a_bounded_time_and_never_force_killed(self):
        import signal
        world = FakeWorld(exits_after=10 ** 9)
        result = world.run()
        self.assertEqual(world.kills, [(4242, signal.SIGTERM)], 'one SIGTERM and no SIGKILL')
        self.assertFalse(result['recovered'])
        self.assertIn('did not exit', result['reason'])
        self.assertLessEqual(world.clock, 3.2)
        self.assertLessEqual(world.polls, 40)
        self.assertEqual(len(world.logs), 1)
        self.assertIn('did not exit', world.logs[0])

    def test_a_failing_exit_probe_is_not_a_recovery(self):
        world = FakeWorld()
        result = world.run(exists=Mock(side_effect=RuntimeError('probe')))
        self.assertFalse(result['recovered'])
        self.assertEqual(len(world.kills), 1)
        self.assertEqual(len(world.logs), 1)

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

    def test_the_default_response_passes_the_lock_path_and_the_requesters_presence(self):
        presence = Mock(return_value=True)
        with patch('lcu.macos_host.sys.platform', 'darwin'), \
             patch('lcu.macos_host.recover_stale_service', return_value={'ok': True, 'recovered': False}) as recover, \
             patch.dict(os.environ, {'LCU_MAC_SERVICE_LOCK': LOCK}):
            recover_response(presence)
            os.environ.pop('LCU_MAC_SERVICE_LOCK')
            recover_response()
        first, second = (call.kwargs for call in recover.call_args_list)
        self.assertEqual((first['lock_path'], first['exclusive'], first['waiting']), (LOCK, PeerLock, presence))
        self.assertIsNone(second['lock_path'])
        self.assertFalse(second['waiting'](), 'no requester means nobody is waiting')

    def test_the_requester_is_waiting_only_while_its_connection_is_open_and_quiet(self):
        here, there = socket.socketpair()
        with here, there:
            self.assertTrue(requester_waiting(here))
            there.shutdown(socket.SHUT_WR)
            self.assertFalse(requester_waiting(here), 'the requester closed its end')
        here, there = socket.socketpair()
        with here, there:
            there.sendall(b'more\n')
            self.assertFalse(requester_waiting(here))
        here, there = socket.socketpair()
        with there:
            here.close()
            self.assertFalse(requester_waiting(here), 'a closed descriptor is not a waiting requester')
        self.assertFalse(requester_waiting(None))

    def test_system_tools_are_used_by_absolute_path(self):
        self.assertEqual((PS, LSOF, CODESIGN), ('/bin/ps', '/usr/sbin/lsof', '/usr/bin/codesign'))


class CodesignAndLockTests(unittest.TestCase):
    @staticmethod
    def run_with(returncode=0, stdout='', stderr=''):
        return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))

    def test_a_healthy_service_is_valid(self):
        run = self.run_with(0, stderr='4242: dynamically valid\n4242: valid on disk\n'
                                       '4242: satisfies its Designated Requirement\n')
        self.assertEqual(verify_service_signature(4242, run=run), 'valid')
        self.assertEqual(run.call_args.args[0], ['/usr/bin/codesign', '--verify', '--strict', '4242'])
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
        self.assertEqual(run.call_args.args[0], ['/usr/sbin/lsof', '-t', '--', LOCK])

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

    def test_a_bundle_alias_is_allowed_but_an_executable_escaping_it_is_not(self):
        environment = {'SKY_CUA_SERVICE_PATH': BUNDLE, 'CODEX_HOME': '/Users/x/.codex'}
        other = '/Applications/Other.app/Contents/MacOS/' + SKY_SERVICE_NAME

        def realpath(path):
            if path == BUNDLE:
                return '/real/ChatGPT/Codex Computer Use.app'
            if path == EXECUTABLE:
                return '/real/ChatGPT/Codex Computer Use.app/Contents/MacOS/' + SKY_SERVICE_NAME
            if path == HOME_EXECUTABLE:
                return other  # a symlink that leaves its bundle
            return path

        self.assertEqual(known_service_executables(environment, realpath=realpath),
                         {'/real/ChatGPT/Codex Computer Use.app/Contents/MacOS/' + SKY_SERVICE_NAME})
        # Another file name, or the bundle itself, is not a service executable either.
        for resolved in ('/real/ChatGPT/Codex Computer Use.app/Contents/MacOS/other',
                         '/real/ChatGPT/Codex Computer Use.app'):
            self.assertEqual(known_service_executables(
                {'SKY_CUA_SERVICE_PATH': BUNDLE},
                realpath=lambda path: '/real/ChatGPT/Codex Computer Use.app' if path == BUNDLE else resolved), set())


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

    def test_the_last_outcome_is_handed_to_the_next_holder(self):
        with tempfile.TemporaryDirectory() as base:
            path = os.path.join(base, 'recovery.lock')
            with PeerLock(path) as first:
                self.assertIsNone(first.previous)
                first.record({'recovered': True, 'pid': 7, 'at': 5.0})
            with PeerLock(path) as second:
                self.assertEqual(second.previous, {'recovered': True, 'pid': 7, 'at': 5.0})
                second.record({'recovered': False, 'at': 9.0})
            with PeerLock(path) as third:
                self.assertEqual(third.previous, {'recovered': False, 'at': 9.0})
            with open(path, 'w') as damaged:
                damaged.write('not json')
            with PeerLock(path) as fourth:
                self.assertIsNone(fourth.previous)

    def test_the_default_lock_file_does_not_depend_on_tmpdir(self):
        if sys.platform == 'darwin':
            with patch.dict(os.environ, {'TMPDIR': '/somewhere/else'}):
                path = PeerLock.default_path()
            self.assertTrue(path.startswith('/'))
            self.assertNotIn('somewhere', path)
            self.assertTrue(path.endswith(f'lcu-stale-service-recovery-{os.getuid()}.lock'))
        else:
            self.assertIsNone(PeerLock.default_path())
        with patch('lcu.macos_host.os.confstr', side_effect=ValueError('unknown')):
            self.assertIsNone(PeerLock.default_path())
            with PeerLock() as lock:
                self.assertFalse(lock.acquired)

    def test_a_short_write_is_not_a_record(self):
        with tempfile.TemporaryDirectory() as base:
            with PeerLock(os.path.join(base, 'recovery.lock')) as lock:
                real = os.pwrite
                with patch('lcu.macos_host.os.pwrite', side_effect=lambda fd, data, offset: real(fd, data[:5], offset)):
                    self.assertFalse(lock.record({'signaled': True, 'recovered': False, 'pid': 4242}))
                self.assertTrue(lock.record({'signaled': True}))
            with PeerLock(os.path.join(base, 'recovery.lock')) as again:
                self.assertEqual(again.previous, {'signaled': True})

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

    def test_the_leaders_arguments_reach_the_work(self):
        seen = []
        flight = SingleFlight(lambda *args: (seen.append(args), {'ok': True})[1])
        self.assertEqual(flight({'deadline_unix_ms': 5}), {'ok': True})
        self.assertEqual(seen, [({'deadline_unix_ms': 5},)])

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
    def test_a_slow_recovery_does_not_delay_turn_cleanup_and_sees_whether_its_requester_waits(self):
        from lcu.macos_host import start_original_host, stop_original_host
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as base:
            client = Path(base) / 'client'
            client.write_text('#!/bin/sh\nexit 0\n')
            client.chmod(0o755)
            # The real host loop with a slow stand-in for the recovery, so nothing real is inspected.
            entry = Path(base) / 'slow_host.py'
            entry.write_text(f'''import sys, time
sys.path.insert(0, {str(root)!r})
import lcu.macos_host as host
def slow_recovery(waiting=None):
    time.sleep(1.5)
    return {{'ok': True, 'recovered': False, 'reason': 'fixture', 'waiting': waiting()}}
host.shared_recovery = host.SingleFlight(slow_recovery, wait_seconds=5)
host.serve(sys.argv[2], sys.argv[3])
''')
            process, temporary, address = start_original_host(
                python=Path(sys.executable), client=client, entry=entry, env=os.environ.copy())
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as slow:
                    slow.settimeout(8)
                    slow.connect(address)
                    slow.sendall(b'{"type":"recover"}\n')
                    time.sleep(0.3)
                    started = time.monotonic()
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                        connection.settimeout(8)
                        connection.connect(address)
                        connection.sendall(b'{"session_id":"s","turn_id":"t"}\n')
                        self.assertEqual(json.loads(read_line(connection)), {'notified': True})
                    self.assertLess(time.monotonic() - started, 1.0)
                    self.assertEqual(json.loads(read_line(slow)),
                                     {'ok': True, 'recovered': False, 'reason': 'fixture', 'waiting': True})
                # A requester that gave up (closed its end) is seen as no longer waiting.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as gone:
                    gone.settimeout(8)
                    gone.connect(address)
                    gone.sendall(b'{"type":"recover"}\n')
                    gone.shutdown(socket.SHUT_WR)
                    self.assertFalse(json.loads(read_line(gone))['waiting'])
                # The removed read-only diagnosis is just an invalid cleanup request now.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(address)
                    connection.sendall(b'{"type":"diagnose"}\n')
                    self.assertFalse(json.loads(read_line(connection))['notified'])
            finally:
                stop_original_host(process, temporary)


if __name__ == '__main__':
    unittest.main()
