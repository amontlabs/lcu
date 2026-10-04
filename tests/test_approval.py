"""Approval mode: add and remove only LCU's own harness approval entries."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import approval, claude_visibility, setup
import setup_host


class ClaudeApprovalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / 'home'
        self.project = self.root / 'project'
        self.home.mkdir()
        self.project.mkdir()
        self.user = self.home / '.claude/settings.json'
        self.local = self.project / '.claude/settings.local.json'

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + '\n')

    def read(self, path):
        return json.loads(path.read_text())

    def test_auto_adds_the_server_rule_at_user_scope_and_ask_removes_exactly_it(self):
        original = {'model': 'sonnet', 'permissions': {'allow': ['Read'], 'deny': ['Bash(rm *)'], 'ask': ['Edit']},
                    'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'keep-me'}]}]}}
        self.write(self.user, original)
        self.assertIn('added', approval.apply_claude('auto', self.home))
        added = self.read(self.user)
        self.assertEqual(added['permissions']['allow'], ['Read', 'mcp__lcu'])
        self.assertEqual({k: v for k, v in added.items() if k != 'permissions'},
                         {k: v for k, v in original.items() if k != 'permissions'})
        self.assertEqual(added['permissions']['deny'], ['Bash(rm *)'])
        self.assertEqual(added['permissions']['ask'], ['Edit'])
        self.assertIn('removed', approval.apply_claude('ask', self.home))
        self.assertEqual(self.read(self.user), original)

    def test_project_scope_uses_settings_local_and_leaves_user_settings_alone(self):
        self.write(self.user, {'permissions': {'allow': ['Read']}})
        before = self.user.read_bytes()
        approval.apply_claude('auto', self.home, project=self.project)
        self.assertEqual(self.read(self.local), {'permissions': {'allow': ['mcp__lcu']}})
        self.assertFalse((self.project / '.claude/settings.json').exists())
        self.assertEqual(self.user.read_bytes(), before)
        approval.apply_claude('ask', self.home, project=self.project)
        self.assertEqual(self.read(self.local), {})

    def test_auto_is_idempotent_and_byte_stable(self):
        approval.apply_claude('auto', self.home)
        first = self.user.read_bytes()
        self.assertTrue(approval.apply_claude('auto', self.home).startswith('unchanged'))
        self.assertEqual(self.user.read_bytes(), first)
        self.assertEqual(self.read(self.user)['permissions']['allow'], ['mcp__lcu'])

    def test_ask_without_a_rule_or_file_writes_nothing(self):
        self.assertTrue(approval.apply_claude('ask', self.home).startswith('unchanged'))
        self.assertFalse(self.user.exists())
        self.write(self.user, {'permissions': {'allow': ['Read']}})
        before = self.user.read_bytes()
        approval.apply_claude('ask', self.home)
        self.assertEqual(self.user.read_bytes(), before)

    def test_ask_keeps_other_lcu_tool_rules_and_other_servers(self):
        self.write(self.user, {'permissions': {'allow': ['mcp__lcu__js', 'mcp__other']}})
        approval.apply_claude('auto', self.home)
        approval.apply_claude('ask', self.home)
        self.assertEqual(self.read(self.user)['permissions']['allow'], ['mcp__lcu__js', 'mcp__other'])

    def test_ask_keeps_a_rule_the_user_wrote_before_auto(self):
        original = {'permissions': {'allow': ['Read', 'mcp__lcu']}}
        self.write(self.user, original)
        self.assertTrue(approval.apply_claude('auto', self.home).startswith('unchanged'))
        self.assertIn('kept your own', approval.apply_claude('ask', self.home))
        self.assertEqual(self.read(self.user), original)

    def test_ask_without_a_record_never_removes_an_identical_rule(self):
        original = {'permissions': {'allow': ['mcp__lcu']}}
        self.write(self.user, original)
        approval.apply_claude('ask', self.home)
        self.assertEqual(self.read(self.user), original)

    def test_records_are_per_settings_path(self):
        self.write(self.local, {'permissions': {'allow': ['mcp__lcu']}})
        approval.apply_claude('auto', self.home)  # user scope: added
        approval.apply_claude('auto', self.home, project=self.project)  # project: user's own rule
        approval.apply_claude('ask', self.home, project=self.project)
        self.assertEqual(self.read(self.local), {'permissions': {'allow': ['mcp__lcu']}})
        approval.apply_claude('ask', self.home)
        self.assertEqual(self.read(self.user), {})

    def test_host_only_tools_stay_denied_alongside_the_allow_rule(self):
        claude_visibility.install(self.home)
        approval.apply_claude('auto', self.home)
        permissions = self.read(self.user)['permissions']
        self.assertEqual(permissions['allow'], ['mcp__lcu'])
        self.assertEqual(permissions['deny'], list(claude_visibility.HOST_ONLY))
        # Claude Code evaluates deny before allow, so the blanket rule does not expose them.
        approval.apply_claude('ask', self.home)
        permissions = self.read(self.user)['permissions']
        self.assertNotIn('allow', permissions)
        self.assertEqual(permissions['deny'], list(claude_visibility.HOST_ONLY))

    def test_malformed_settings_are_rejected_without_a_write(self):
        for content in ('{ not json', '[]', '{"permissions": []}', '{"permissions": {"allow": "x"}}',
                        '{"permissions": {"allow": [1]}}'):
            with self.subTest(content=content):
                self.user.parent.mkdir(parents=True, exist_ok=True)
                self.user.write_text(content)
                with self.assertRaises(ValueError):
                    approval.apply_claude('auto', self.home)
                self.assertEqual(self.user.read_text(), content)


class FakeOmpConfig:
    """Stands in for `omp config get|set|reset tools.approval`."""
    def __init__(self, value=None):
        self.value = dict(value or {})
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv[2:])
        action, key = argv[2], argv[3]
        assert key == 'tools.approval', argv
        if action == 'get':
            return subprocess.CompletedProcess(argv, 0, json.dumps({'key': key, 'value': self.value}), '')
        if action == 'set':
            self.value = json.loads(argv[4])
        elif action == 'reset':
            self.value = {}
        else:
            raise AssertionError(argv)
        return subprocess.CompletedProcess(argv, 0, '', '')

    @property
    def writes(self):
        return [call for call in self.calls if call[0] != 'get']


class OmpApprovalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve()

    def apply(self, mode, fake, env=None):
        with patch('lcu.approval.shutil.which', return_value='/bin/omp'), \
             patch('lcu.approval.subprocess.run', side_effect=fake) as run:
            outcome = approval.apply_omp(mode, self.home, env={'PATH': '/bin', **(env or {})})
        self.fake_run = run
        return outcome

    def test_auto_allows_both_tools_and_keeps_other_policies(self):
        fake = FakeOmpConfig({'bash': 'prompt'})
        self.apply('auto', fake)
        self.assertEqual(fake.value, {'bash': 'prompt', 'js': 'allow', 'js_reset': 'allow'})

    def test_auto_is_idempotent(self):
        fake = FakeOmpConfig({'js': 'allow', 'js_reset': 'allow'})
        self.assertEqual(self.apply('auto', fake), 'unchanged')
        self.assertEqual(fake.writes, [])

    def test_auto_keeps_a_users_explicit_non_allow_policy(self):
        fake = FakeOmpConfig({'js': 'deny'})
        outcome = self.apply('auto', fake)
        self.assertEqual(fake.value, {'js': 'deny', 'js_reset': 'allow'})
        self.assertIn('kept your `js: deny`', outcome)

    def test_ask_removes_only_the_allow_entries_it_added(self):
        fake = FakeOmpConfig({'bash': 'prompt'})
        self.apply('auto', fake)
        self.apply('ask', fake)
        self.assertEqual(fake.value, {'bash': 'prompt'})
        fake = FakeOmpConfig({'js': 'deny'})
        self.apply('auto', fake)
        self.apply('ask', fake)
        self.assertEqual(fake.value, {'js': 'deny'})

    def test_ask_keeps_preexisting_allow_entries(self):
        fake = FakeOmpConfig({'js': 'allow', 'bash': 'prompt'})
        self.apply('auto', fake)
        self.assertEqual(fake.value, {'js': 'allow', 'js_reset': 'allow', 'bash': 'prompt'})
        self.apply('ask', fake)
        self.assertEqual(fake.value, {'js': 'allow', 'bash': 'prompt'})
        # And with no auto at all, an allow entry is never LCU's to remove.
        fake = FakeOmpConfig({'js': 'allow', 'js_reset': 'allow'})
        self.apply('ask', fake)
        self.assertEqual(fake.writes, [])

    def test_omp_records_are_per_profile(self):
        fake = FakeOmpConfig()
        self.apply('auto', fake, env={'OMP_PROFILE': 'blue'})
        other = FakeOmpConfig({'js': 'allow', 'js_reset': 'allow'})
        self.apply('ask', other, env={'OMP_PROFILE': 'green'})
        self.assertEqual(other.writes, [])
        self.apply('ask', fake, env={'OMP_PROFILE': 'blue'})
        self.assertEqual(fake.value, {})

    def test_ask_resets_the_setting_when_nothing_else_remains(self):
        fake = FakeOmpConfig()
        self.apply('auto', fake)
        fake.calls.clear()
        self.apply('ask', fake)
        self.assertEqual(fake.writes, [['reset', 'tools.approval']])
        self.assertEqual(self.apply('ask', fake), 'unchanged')

    def test_environment_selects_the_profile(self):
        fake = FakeOmpConfig()
        self.apply('auto', fake, env={'OMP_PROFILE': 'blue'})
        self.assertEqual(self.fake_run.call_args.kwargs['env']['OMP_PROFILE'], 'blue')

    def test_missing_omp_and_unexpected_output_fail_clearly(self):
        with patch('lcu.approval.shutil.which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'not on the target account PATH'):
                approval.apply_omp('auto', self.home, env={'PATH': '/bin'})
        bad = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, '[]', '')
        with patch('lcu.approval.shutil.which', return_value='/bin/omp'), \
             patch('lcu.approval.subprocess.run', side_effect=bad):
            with self.assertRaisesRegex(ValueError, 'unexpected'):
                approval.apply_omp('auto', self.home, env={'PATH': '/bin'})

    @unittest.skipUnless(shutil.which('omp'), 'OMP is not installed')
    def test_real_omp_round_trip_in_an_isolated_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'PI_CODING_AGENT_DIR': str(home / 'agent'),
                   'NO_COLOR': '1'}
            subprocess.run(['omp', 'config', 'set', 'tools.approval', '{"bash":"prompt"}'],
                           env=env, check=True, capture_output=True, timeout=60)

            def current():
                out = subprocess.run(['omp', 'config', 'get', 'tools.approval', '--json'], env=env,
                                     check=True, capture_output=True, text=True, timeout=60).stdout
                return json.loads(out)['value']

            approval.apply_omp('auto', home, env=env)
            self.assertEqual(current(), {'bash': 'prompt', 'js': 'allow', 'js_reset': 'allow'})
            approval.apply_omp('ask', home, env=env)
            self.assertEqual(current(), {'bash': 'prompt'})


class CodexApprovalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / 'home'
        self.project = self.root / 'project'
        self.home.mkdir()
        self.project.mkdir()
        self.config = self.home / '.codex/config.toml'

    def plan(self, mode, scope='user'):
        return approval.codex_plan(mode, self.home, scope=scope, project=self.project,
                                   env={'HOME': str(self.home)})

    def write(self, text, path=None):
        path = path or self.config
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def cycle(self, mode, scope='user'):
        plan = self.plan(mode, scope)
        approval.apply(mode, 'codex', self.home, scope=scope, project=self.project,
                       env={'HOME': str(self.home)}, plan=plan)
        return plan

    def test_policy_is_only_present_for_auto_when_nothing_was_there(self):
        self.assertEqual(self.plan('auto')['policy'], {'default_tools_approval_mode': 'approve'})
        self.assertEqual(self.plan('ask')['policy'], {})
        self.assertEqual(self.plan(None)['policy'], {})

    def test_ask_restores_the_previous_value_auto_replaced(self):
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n')
        self.assertEqual(self.cycle('auto')['policy'], {'default_tools_approval_mode': 'approve'})
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n')
        # Reapplying auto keeps the original prior value.
        self.cycle('auto')
        restored = self.plan('ask')
        self.assertEqual(restored['policy'], {'default_tools_approval_mode': 'prompt'})
        self.cycle('ask')
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n')
        self.assertFalse(approval.load_record(self.home))  # nothing recorded now: the value is the user's

    def test_ask_after_auto_with_no_prior_value_registers_without_one(self):
        self.cycle('auto')
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n')
        self.assertEqual(self.plan('ask')['policy'], {})

    def test_value_not_recorded_by_lcu_is_preserved_by_ask_and_default(self):
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n')
        for mode in ('ask', None):
            self.assertEqual(self.plan(mode)['policy'], {'default_tools_approval_mode': 'approve'})

    def test_project_scope_reads_and_records_the_project_config(self):
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n')
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "never"\n', self.project / '.codex/config.toml')
        self.cycle('auto', 'project')
        self.assertEqual(self.plan('ask', 'user')['policy'], {'default_tools_approval_mode': 'prompt'})
        self.assertEqual(self.plan('ask', 'project')['policy'], {'default_tools_approval_mode': 'never'})

    def register(self, mode):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        home, release, tools = root / 'home', root / 'release', root / 'tools'
        (release / 'adapters').mkdir(parents=True)
        home.mkdir()
        (release / 'adapters/codex.mjs').write_text('relay')
        (release / 'adapters/audio-files.mjs').write_text('helper')
        config = home / '.codex/config.toml'
        host = {'enabled_tools': ['js'], 'startup_timeout_sec': 120}
        calls = []

        def run(argv, **_):
            calls.append(argv)
            return SimpleNamespace(returncode=0, stdout=json.dumps({'path': str(config)}))

        with patch('lcu.setup.installer_paths', return_value=(tools / 'node', tools / 's.mjs', tools / 'm.mjs')), \
             patch('lcu.setup.installed_app_resources', return_value=root / 'resources'), \
             patch('lcu.setup.host_policy', return_value=host), patch('lcu.setup.preflight_mcp'), \
             patch('lcu.setup.subprocess.run', side_effect=run), \
             patch('lcu.setup.remove_old_skill', return_value='none'), \
             patch('lcu.codex_hooks.require_cli_hook_support'), patch('lcu.codex_hooks.install_hooks'), \
             patch('lcu.app_layout.locate_codex_tools', return_value=SimpleNamespace(cli=root / 'codex')):
            failures = setup.configure(['codex'], home, ['/opt/lcu/current/bin/lcu'], tools, release,
                                       environ={'HOME': str(home)}, approval=mode)
        self.assertEqual(failures, [])
        return json.loads(next(argv for argv in calls if '--input-type=module' in argv)[-1]), host

    def test_registration_policy_carries_the_approval_default_only_for_auto(self):
        policy, host = self.register('auto')
        self.assertEqual(policy, {**host, 'default_tools_approval_mode': 'approve'})
        for mode in ('ask', None):
            policy, host = self.register(mode)
            self.assertEqual(policy, host)


class ConfigureApprovalTests(unittest.TestCase):
    def test_pi_and_hermes_record_nothing_to_configure(self):
        self.assertIn('no permission system', approval.apply('auto', 'pi', Path('/h'), scope='user',
                                                             project=None, env={}))
        self.assertIn('pre_tool_call', approval.apply('ask', 'hermes', Path('/h'), scope='user',
                                                      project=None, env={}))

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            approval.apply('yolo', 'pi', Path('/h'), scope='user', project=None, env={})

    @unittest.skipIf(setup_host.WINDOWS, 'Windows setup refuses --export before checking --approval')
    def test_export_cannot_carry_an_approval_mode(self):
        argv = ['--export', '/tmp/new-export', '--approval', 'auto']
        if setup_host.is_root():
            argv += ['--user', 'root']
        args = setup.parser().parse_args(argv)
        with self.assertRaisesRegex(ValueError, 'cannot be combined with --export'):
            setup.validate(args)


class SetupApprovalPersistenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.prefix = self.root / 'prefix'
        self.home = self.root / 'home'
        self.home.mkdir()
        setup_host.make_runtime(self.prefix)
        self.configured = []

    def drive(self, *argv, agents=('codex',), failures=()):
        account = setup_host.account(self.home)

        def configure(names, home, command, *args, **kwargs):
            self.configured.append(kwargs.get('approval', 'missing'))
            return list(failures)

        out = io.StringIO()
        with patch.object(setup.sys, 'platform', setup_host.PLATFORM), \
             patch.object(setup, 'validate', return_value=(account, list(agents))), \
             patch.object(setup, 'installer_environment'), patch.object(setup, 'installer_paths'), \
             patch.object(setup, 'configure', side_effect=configure), \
             patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')), \
             contextlib.redirect_stdout(out):
            try:
                setup.main(['--prefix', str(self.prefix), '--session', 'direct', '--yes', '--no-chrome', *argv])
            except SystemExit:
                pass
        return out.getvalue()

    def saved(self):
        return setup.load_setup_state(self.home)['approval']

    def test_default_leaves_harness_settings_alone_and_saves_ask(self):
        output = self.drive()
        self.assertEqual(self.configured, [None])
        self.assertEqual(self.saved(), 'ask')
        self.assertNotIn('Approval mode', output)

    def test_auto_is_applied_remembered_and_reapplied_by_later_setups(self):
        output = self.drive('--approval', 'auto', agents=('codex', 'pi'))
        self.assertEqual(self.configured, ['auto'])
        self.assertEqual(self.saved(), 'auto')
        self.assertIn('Approval mode auto', output)
        self.assertIn('Codex: `default_tools_approval_mode = "approve"`', output)
        self.assertIn('Pi and Hermes have no such gate', output)
        self.assertIn('Native-app and Chrome approvals from the original runtime are unchanged', output)
        output = self.drive()
        self.assertEqual(self.configured, ['auto', 'auto'])
        self.assertIn('Keeping automatic approval', output)

    def test_explicit_ask_removes_entries_and_is_remembered(self):
        self.drive('--approval', 'auto')
        output = self.drive('--approval', 'ask')
        self.assertEqual(self.configured, ['auto', 'ask'])
        self.assertEqual(self.saved(), 'ask')
        self.assertIn('Approval mode ask: remove only the entries', output)
        self.drive()
        self.assertEqual(self.configured[-1], None)

    def test_failed_registration_does_not_remember_the_mode_and_retry_keeps_it(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.drive('--approval', 'auto', failures=[('codex', 'approval', 'boom')])
        self.assertFalse(setup.setup_state_path(self.home).exists())
        self.assertIn('--approval auto', stderr.getvalue())

    def test_parser_accepts_only_known_modes(self):
        self.assertEqual(setup.parser().parse_args(['--approval', 'auto']).approval, 'auto')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            setup.parser().parse_args(['--approval', 'yolo'])


if __name__ == '__main__':
    unittest.main()
