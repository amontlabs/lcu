"""Tested app/runtime pair records: status, warnings and the machine-readable report."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import doctor, setup, status, tested

REPO = Path(__file__).resolve().parents[1]
PAIR = {'platform': 'linux', 'architecture': 'arm64', 'app_version': '26.915.31945',
        'runtime': '0.0.16/20260915001755-492f19756c31'}


def entry(**changes):
    return {'platform': 'linux', 'architecture': 'arm64', 'app_version': '26.915.31945',
            'runtime': '0.0.16/20260915001755-492f19756c31', 'lcu_version': '0.7.0',
            'app_sha256': 'b' * 64, 'evidence': 'docs/releases/0.7.0.md', **changes}


class TestedVersionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def record(self, *entries, **extra):
        (self.root / tested.RECORD).write_text(json.dumps({'format': 1, 'entries': list(entries), **extra}))

    def test_tested_pair_reports_the_lcu_version_and_package_hash(self):
        self.record(entry(), entry(architecture='x64', app_sha256='c' * 64))
        result = tested.assess(self.root, **PAIR)
        self.assertEqual((result['status'], result['tested']), ('tested', True))
        self.assertEqual(result['tested_with_lcu'], '0.7.0')
        self.assertEqual(result['app_sha256'], 'b' * 64)
        self.assertIsNone(result['warning'])
        self.assertIn('Tested pair: yes', tested.status_lines(result)[0])

    def test_untested_app_version_warns_and_lists_the_tested_pairs(self):
        self.record(entry())
        result = tested.assess(self.root, **{**PAIR, 'app_version': '26.999.1'})
        self.assertEqual((result['status'], result['tested']), ('untested', False))
        self.assertIn('LCU will still use it', result['warning'])
        self.assertIn('ChatGPT 26.915.31945 with CUA 0.0.16/20260915001755-492f19756c31', result['warning'])
        self.assertEqual(result['tested_pairs'], [{'app_version': '26.915.31945', 'runtime': PAIR['runtime'],
                                                    'lcu_version': '0.7.0'}])
        self.assertEqual(tested.status_lines(result)[0], 'Tested pair: no.')

    def test_native_input_lists_toolkits_only_for_the_exact_pair(self):
        self.record(entry(native_input=['gtk4']), entry(architecture='x64', app_sha256='c' * 64))
        self.assertEqual(tested.native_input(self.root, **PAIR), ('gtk4',))
        self.assertEqual(tested.native_input(self.root, **{**PAIR, 'app_version': '26.999.1'}), ())
        self.assertEqual(tested.native_input(self.root, **{**PAIR, 'architecture': 'x64'}), ())

    def test_native_input_is_empty_without_a_usable_record(self):
        self.assertEqual(tested.native_input(self.root, **PAIR), ())
        (self.root / tested.RECORD).write_text('{broken')
        self.assertEqual(tested.native_input(self.root, **PAIR), ())

    def test_an_unknown_native_input_toolkit_invalidates_the_record(self):
        for value in (['gtk3'], 'gtk4', [1]):
            with self.subTest(value=value):
                self.record(entry(native_input=value))
                entries, problem = tested.load_entries(self.root)
                self.assertIsNone(entries)
                self.assertIn('invalid entry', problem)

    def test_the_runtime_must_match_as_well_as_the_app_version(self):
        self.record(entry())
        self.assertEqual(tested.assess(self.root, **{**PAIR, 'runtime': '0.0.99/other'})['status'], 'untested')

    def test_another_architecture_or_platform_is_not_covered(self):
        self.record(entry())
        arch = tested.assess(self.root, **{**PAIR, 'architecture': 'x64'})
        self.assertEqual(arch['status'], 'untested')
        self.assertIn('No pair is recorded for this platform and architecture', arch['warning'])
        self.assertEqual(tested.assess(self.root, **{**PAIR, 'platform': 'darwin'})['status'], 'untested')

    def test_missing_record_is_unknown_and_never_an_error(self):
        result = tested.assess(self.root, **PAIR)
        self.assertEqual((result['status'], result['tested']), ('unknown', None))
        self.assertIn('is missing', result['warning'])
        self.assertIn('LCU will still use it', result['warning'])

    def test_unreadable_or_invalid_record_is_unknown(self):
        for content in ('not json', json.dumps({'format': 2, 'entries': []}), json.dumps({'format': 1}),
                        json.dumps({'format': 1, 'entries': [{'platform': 'linux'}]}),
                        json.dumps({'format': 1, 'entries': [entry(app_sha256='nothex')]})):
            with self.subTest(content=content):
                (self.root / tested.RECORD).write_text(content)
                result = tested.assess(self.root, **PAIR)
                self.assertEqual(result['status'], 'unknown')
                self.assertTrue(result['warning'])

    def test_the_checked_in_record_is_valid_and_has_no_duplicate_pairs(self):
        entries, problem = tested.load_entries(REPO)
        self.assertIsNone(problem)
        keys = [(e['platform'], e['architecture'], e['app_version'], e['runtime']) for e in entries]
        self.assertEqual(len(keys), len(set(keys)))
        for e in entries:
            self.assertTrue((REPO / e['evidence']).is_file(), e['evidence'])

    def test_report_never_raises_for_an_unreadable_app(self):
        out = io.StringIO()
        tested.report(self.root, file=out)
        self.assertIn('Tested pair: unknown', out.getvalue())

    def make_release(self, platform='linux', architecture='arm64'):
        (self.root / 'installation.json').write_text(json.dumps({'platform': platform,
                                                                  'architecture': architecture, 'app': 'app'}))
        (self.root / 'bundle.json').write_text(json.dumps({'version': '9.9.9'}))

    def run_status(self, *argv, metadata=None):
        resolved = (self.root / 'app', self.root / 'app/resources', self.root / 'app/resources/cua_node',
                    metadata or {'version': PAIR['app_version'], 'runtime': PAIR['runtime']})
        out = io.StringIO()
        with patch('lcu.runtime.paths', return_value=resolved), patch.object(status, 'saved_setup', return_value=None), \
             contextlib.redirect_stdout(out):
            status.main(self.root, list(argv))
        return out.getvalue()

    def test_status_json_exposes_the_tested_state(self):
        self.make_release()
        self.record(entry())
        report = json.loads(self.run_status('--json'))
        self.assertEqual(report['lcu_version'], '9.9.9')
        self.assertEqual(report['app'], {'path': str(self.root / 'app'), 'version': PAIR['app_version'],
                                          'runtime': PAIR['runtime']})
        self.assertTrue(report['compatibility']['tested'])
        untested = json.loads(self.run_status('--json', metadata={'version': '27.1.1', 'runtime': PAIR['runtime']}))
        self.assertEqual(untested['compatibility']['status'], 'untested')
        self.assertFalse(untested['compatibility']['tested'])
        self.assertIn('not a pair LCU has tested', untested['compatibility']['warning'])

    def test_status_text_prints_the_warning_for_an_untested_pair(self):
        self.make_release()
        self.record(entry())
        text = self.run_status(metadata={'version': '27.1.1', 'runtime': PAIR['runtime']})
        self.assertIn('Original app: ChatGPT 27.1.1', text)
        self.assertIn('Warning: ChatGPT 27.1.1', text)

    def test_status_without_a_selected_app_fails_with_json_error(self):
        out = io.StringIO()
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stdout(out):
            status.main(self.root, ['--json'])
        self.assertEqual(raised.exception.code, 1)
        self.assertIn('installation.json', json.loads(out.getvalue())['error'])

    def test_doctor_reports_the_pair_and_still_runs_for_an_untested_one(self):
        self.make_release()
        self.record(entry())
        out = io.StringIO()
        resolved = (self.root / 'app', self.root / 'app/resources', self.root / 'app/resources/cua_node',
                    {'version': '27.1.1', 'runtime': PAIR['runtime']})
        with contextlib.redirect_stdout(out):
            code = doctor.main(self.root, ['--non-interactive'], resolved=resolved, env={})
        self.assertEqual(code, 2)  # no desktop session in this environment, not the version
        self.assertIn('Original app: ChatGPT 27.1.1', out.getvalue())
        self.assertIn('Warning: ChatGPT 27.1.1 with CUA', out.getvalue())
        self.assertIn('LCU will still use it', out.getvalue())

    def test_status_and_doctor_report_an_app_changed_since_install(self):
        self.make_release()
        self.record(entry())
        descriptor = json.loads((self.root / 'installation.json').read_text())
        descriptor.update(package_version=PAIR['app_version'], runtime=PAIR['runtime'])
        (self.root / 'installation.json').write_text(json.dumps(descriptor))
        self.assertIsNone(json.loads(self.run_status('--json'))['changed_since_install'])
        upgraded = {'version': '27.2.0', 'runtime': PAIR['runtime']}
        report = json.loads(self.run_status('--json', metadata=upgraded))
        self.assertIn('differs from the one recorded', report['changed_since_install'])
        self.assertIn(PAIR['app_version'], report['changed_since_install'])
        self.assertIn('stop them, restart them', self.run_status(metadata=upgraded))
        out = io.StringIO()
        resolved = (self.root / 'app', self.root / 'app/resources', self.root / 'app/resources/cua_node', upgraded)
        with contextlib.redirect_stdout(out):
            doctor.main(self.root, ['--non-interactive'], resolved=resolved, env={})
        self.assertIn('differs from the one recorded', out.getvalue())

    def test_status_and_doctor_name_the_diagnostic_log_and_its_policy(self):
        self.make_release()
        self.record(entry())
        log_dir = str(self.root / 'diagnostics')
        with patch.dict('os.environ', {'LCU_LOG_DIR': log_dir}):
            self.assertEqual(json.loads(self.run_status('--json'))['diagnostic_log'], {
                'dir': log_dir, 'enabled': True, 'retention_days': 7, 'max_total_mb': 20, 'max_file_mb': 2})
            self.assertIn(f'Diagnostic log: {log_dir}', self.run_status())
            out = io.StringIO()
            resolved = (self.root / 'app', self.root / 'app/resources', self.root / 'app/resources/cua_node',
                        {'version': PAIR['app_version'], 'runtime': PAIR['runtime']})
            with contextlib.redirect_stdout(out):
                doctor.main(self.root, ['--non-interactive'], resolved=resolved, env={})
        self.assertIn(f'Diagnostic log: {log_dir} (metadata only; kept 7 days, at most 20 MB in total '
                      'and 2 MB per file', out.getvalue())
        with patch.dict('os.environ', {'LCU_DIAGNOSTIC_LOG': '0'}):
            self.assertFalse(json.loads(self.run_status('--json'))['diagnostic_log']['enabled'])
            self.assertIn('Diagnostic log: off', self.run_status())

    @unittest.skipIf(sys.platform == 'win32', 'Drives the Linux setup path with a POSIX account')
    def test_setup_reports_an_untested_pair_and_still_registers(self):
        prefix = self.root / 'prefix'
        current = prefix / 'current'
        for name in ('bin/lcu', 'bin/lcu-session'):
            (current / name).parent.mkdir(parents=True, exist_ok=True)
            (current / name).write_text('fixture')
            (current / name).chmod(0o755)
        self.root = current
        self.make_release()
        self.record(entry())
        home = prefix / 'home'
        home.mkdir()
        account = SimpleNamespace(pw_name='fixture', pw_uid=os.getuid(), pw_dir=str(home))
        resolved = (current / 'app', current / 'app/resources', current / 'app/resources/cua_node',
                    {'version': '27.1.1', 'runtime': PAIR['runtime']})
        out = io.StringIO()
        with patch.object(setup.sys, 'platform', 'linux'), \
             patch.object(setup, 'validate', return_value=(account, ['codex'])), \
             patch.object(setup, 'installer_environment'), patch.object(setup, 'installer_paths'), \
             patch.object(setup, 'configure', return_value=[]) as configure, \
             patch('lcu.runtime.paths', return_value=resolved), \
             patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')), \
             contextlib.redirect_stdout(out):
            setup.main(['--prefix', str(prefix), '--agent', 'codex', '--session', 'direct', '--yes'])
        self.assertIn('Tested pair: no.', out.getvalue())
        self.assertIn('Warning: ChatGPT 27.1.1', out.getvalue())
        configure.assert_called_once()


if __name__ == '__main__':
    unittest.main()
