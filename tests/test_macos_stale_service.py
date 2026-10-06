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
                            stale_service_message)

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
            '    1 Tue Oct  6 08:00:00 2026     /sbin/launchd',
            f'45404 Wed Oct  7 00:34:53 2026     {EXECUTABLE}',
            '  999 Wed Oct  7 01:00:00 2026     /usr/bin/ssh',
        ]))
        self.assertEqual(unparsed, 0)
        self.assertEqual(services, [{'pid': 45404, 'path': EXECUTABLE,
                                     'started': epoch('Wed Oct 7 00:34:53 2026')}])

    def test_keeps_non_ascii_path_characters(self):
        path = f'/Users/Jos\u00e9/ChatGPT.app/Contents/MacOS/{SKY_SERVICE_NAME}'
        services, _ = parse_process_table(f'7 Wed Oct  7 00:34:53 2026 {path}')
        self.assertEqual(services[0]['path'], path)

    def test_counts_unparseable_service_lines_instead_of_guessing(self):
        services, unparsed = parse_process_table('\n'.join([
            f'oops Wed Oct  7 00:34:53 2026 {EXECUTABLE}',
            f'45404 Wed Smarch  7 00:34:53 2026 {EXECUTABLE}',
            f'45405 Wed Oct  7 25:34:53 2026 {EXECUTABLE}',
            f'45406 Wed Oct  7 00:34:53 2026 relative/{SKY_SERVICE_NAME}',
            f'45407 Wed Oct  7 00:34:53 2026 /x/{SKY_SERVICE_NAME}Helper',
            f'45408 {SKY_SERVICE_NAME}',
            'garbage with no service name',
        ]))
        self.assertEqual(services, [])
        self.assertEqual(unparsed, 6)


class BundleTimeTests(unittest.TestCase):
    def test_uses_the_oldest_change_among_executable_plist_and_seal(self):
        stat = stat_with({EXECUTABLE: 300.0, PLIST: 250.0, SEAL: 280.0})
        self.assertEqual(bundle_replaced_at(EXECUTABLE, stat), 250.0)

    def test_one_file_with_a_metadata_change_does_not_read_as_a_replacement(self):
        # chmod or an extended attribute on the executable alone: the plist and seal keep their old ctime.
        stat = stat_with({EXECUTABLE: 900.0, PLIST: 100.0, SEAL: 100.0})
        self.assertEqual(bundle_replaced_at(EXECUTABLE, stat), 100.0)
        run = ps(f'45404 Thu Jan  1 00:10:00 1970 {EXECUTABLE}')
        self.assertEqual(diagnose_sky_services(run=run, stat=stat)['stale'], [])

    def test_a_missing_or_unreadable_file_makes_the_time_unknown_not_a_guess(self):
        for present in ({EXECUTABLE: 900.0}, {EXECUTABLE: 900.0, PLIST: 900.0},
                        {EXECUTABLE: 900.0, SEAL: 900.0}, {PLIST: 250.0, SEAL: 250.0}):
            self.assertIsNone(bundle_replaced_at(EXECUTABLE, stat_with(present)), present)
        run = ps(f'45404 Thu Jan  1 00:10:00 1970 {EXECUTABLE}')
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
        run = ps(f'45404 Tue Oct  6 11:00:00 2026   {EXECUTABLE}')
        stat = stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'))
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [45404])
        self.assertTrue(diagnosis['services'][0]['stale'])
        self.assertEqual(diagnosis['message'], stale_service_message([45404]))
        self.assertTrue(diagnosis['message'].startswith('A Computer Use service (pid 45404) started before '
                                                        'ChatGPT was updated still holds the connection. '))
        self.assertTrue(diagnosis['message'].endswith('wait, or quit it, then retry.'))
        self.assertEqual(run.call_args.args[0], ['ps', '-axo', 'pid=,lstart=,comm='])
        env = run.call_args.kwargs['env']
        self.assertEqual((env['LC_TIME'], env['LC_CTYPE'], env['TZ']), ('C', 'UTF-8', 'UTC'))
        self.assertNotIn('LC_ALL', env)

    def test_a_service_started_after_the_replacement_is_fresh(self):
        run = ps(f'45404 Wed Oct  7 00:34:53 2026   {EXECUTABLE}')
        stat = stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'))
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [])
        self.assertNotIn('message', diagnosis)
        self.assertFalse(diagnosis['services'][0]['stale'])

    def test_a_change_within_the_start_time_resolution_is_not_stale(self):
        start = epoch('Wed Oct 7 00:34:53 2026')
        run = ps(f'45404 Wed Oct  7 00:34:53 2026   {EXECUTABLE}')
        for replaced, stale in ((start + 1.9, False), (start + 2.5, True)):
            diagnosis = diagnose_sky_services(run=run, stat=stat_with(whole_bundle(EXECUTABLE, replaced)))
            self.assertEqual(diagnosis['stale'] == [45404], stale, replaced)

    def test_no_service_running(self):
        diagnosis = diagnose_sky_services(run=ps('    1 Tue Oct  6 08:00:00 2026 /sbin/launchd'),
                                          stat=stat_with({}))
        self.assertEqual(diagnosis, {'services': [], 'stale': [], 'unparsed': 0})

    def test_missing_bundle_is_reported_but_not_flagged(self):
        diagnosis = diagnose_sky_services(run=ps(f'45404 Tue Oct  6 11:00:00 2026 {EXECUTABLE}'),
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
        run = ps(f'45404 Wed Oct  7 00:34:53 2026 {other}',
                 f'  200 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        stat = stat_with({**whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'),
                          **whole_bundle(other, 'Wed Oct 7 00:34:50 2026')})
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [200])
        self.assertEqual([service['pid'] for service in diagnosis['services']], [45404, 200])

    def test_several_stale_services_are_all_named(self):
        message = stale_service_message([7, 9])
        self.assertIn('(pids 7, 9)', message)
        self.assertEqual(message, 'Computer Use services (pids 7, 9) started before ChatGPT was updated '
                                  'still hold the connection. They quit on their own about a minute after '
                                  'they are last used: wait, or quit them, then retry.')

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
            self.assertEqual(diagnose_sky_services(run=ps(f'10 {older} {executable}'))['stale'], [10])
            self.assertEqual(diagnose_sky_services(run=ps(f'10 {newer} {executable}'))['stale'], [])

    def test_the_diagnosis_only_lists_processes_and_never_signals_one(self):
        run = ps(f'45404 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        with patch('os.kill') as kill, patch('os.killpg') as killpg:
            diagnose_sky_services(run=run, stat=stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026')))
        kill.assert_not_called()
        killpg.assert_not_called()
        run.assert_called_once()


class SingleFlightTests(unittest.TestCase):
    def test_a_burst_of_callers_shares_one_run_and_the_next_burst_runs_again(self):
        from threading import Event, Thread
        release, started, runs = Event(), Event(), []

        def work():
            runs.append(1)
            started.set()
            release.wait(5)
            return {'ok': True, 'run': len(runs)}

        flight = SingleFlight(work)
        results = []
        threads = [Thread(target=lambda: results.append(flight())) for _ in range(8)]
        threads[0].start()
        self.assertTrue(started.wait(5))
        for thread in threads[1:]:
            thread.start()
        time.sleep(0.2)
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
