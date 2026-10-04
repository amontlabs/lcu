"""Approval mode: add and remove only LCU's own harness approval entries."""
import contextlib
import io
import json
import os
import re
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
        self.assertEqual(added['permissions']['allow'], ['Read', 'mcp__lcu__js', 'mcp__lcu__js_reset'])
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
        self.assertEqual(self.read(self.local), {'permissions': {'allow': ['mcp__lcu__js', 'mcp__lcu__js_reset']}})
        self.assertFalse((self.project / '.claude/settings.json').exists())
        self.assertEqual(self.user.read_bytes(), before)
        approval.apply_claude('ask', self.home, project=self.project)
        self.assertEqual(self.read(self.local), {})

    def test_auto_is_idempotent_and_byte_stable(self):
        approval.apply_claude('auto', self.home)
        first = self.user.read_bytes()
        self.assertTrue(approval.apply_claude('auto', self.home).startswith('unchanged'))
        self.assertEqual(self.user.read_bytes(), first)
        self.assertEqual(self.read(self.user)['permissions']['allow'], ['mcp__lcu__js', 'mcp__lcu__js_reset'])

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
        self.assertEqual(self.read(self.user)['permissions']['allow'],
                         ['mcp__lcu__js', 'mcp__other', 'mcp__lcu__js_reset'])
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
        self.assertEqual(permissions['allow'], ['mcp__lcu__js', 'mcp__lcu__js_reset'])
        self.assertEqual(permissions['deny'], list(claude_visibility.HOST_ONLY))
        # The allow rules name only the model-visible tools, and deny wins over allow anyway.
        approval.apply_claude('ask', self.home)
        permissions = self.read(self.user)['permissions']
        self.assertNotIn('allow', permissions)
        self.assertEqual(permissions['deny'], list(claude_visibility.HOST_ONLY))

    def test_allow_entries_are_exactly_the_model_visible_tools(self):
        claude_visibility.install(self.home)
        approval.apply_claude('auto', self.home)
        permissions = self.read(self.user)['permissions']
        self.assertEqual(sorted(permissions['allow']), sorted(f'mcp__lcu__{tool}' for tool in approval.MODEL_TOOLS))
        self.assertNotIn('mcp__lcu', permissions['allow'])
        for rule in claude_visibility.HOST_ONLY:
            self.assertIn(rule, permissions['deny'])
            self.assertNotIn(rule, permissions['allow'])
        # Every host-only or future tool is outside the allow list; a wildcard would cover it.
        self.assertFalse([rule for rule in permissions['allow'] if '*' in rule or rule == 'mcp__lcu'])

    def test_model_tool_lists_agree_across_python_and_adapters(self):
        root = Path(__file__).resolve().parents[1]
        client = (root / 'adapters/client.mjs').read_text()
        relay = (root / 'adapters/claude.mjs').read_text()
        names = lambda text, constant: re.search(constant + r" = new Set\(\[([^\]]*)\]\)", text).group(1)
        expected = ', '.join(f"'{tool}'" for tool in approval.MODEL_TOOLS)
        self.assertEqual(names(client, 'MODEL_TOOLS'), expected)
        self.assertEqual(names(relay, 'PUBLIC_TOOLS'), expected)
        self.assertEqual(approval.OMP_TOOLS, approval.MODEL_TOOLS)
        self.assertIn('|'.join(f'mcp__lcu__{tool}' for tool in approval.MODEL_TOOLS),
                      (root / 'lcu/claude_visibility.py').read_text())
        # Mod-only tools: the same names in the relay and in Python.
        mod_only = ', '.join(f"'{rule.removeprefix('mcp__lcu__')}'" for rule in claude_visibility.MOD_ONLY)
        self.assertEqual(names(relay, 'MOD_ONLY_TOOLS'), mod_only)
        self.assertIn('toolu_plugin_', client)

    def test_tool_categories_are_disjoint_and_each_is_handled_consistently(self):
        claude_visibility.install(self.home)
        approval.apply_claude('auto', self.home)
        permissions = self.read(self.user)['permissions']
        model = {f'mcp__lcu__{tool}' for tool in approval.MODEL_TOOLS}
        host_only, mod_only = set(claude_visibility.HOST_ONLY), set(claude_visibility.MOD_ONLY)
        self.assertFalse(model & host_only or model & mod_only or host_only & mod_only)
        self.assertEqual(set(permissions['allow']), model)
        self.assertEqual(set(permissions['deny']), host_only)
        # Mod-only tools are never allowed and never denied, in any mode.
        for mode in ('auto', 'ask'):
            approval.apply_claude(mode, self.home)
            permissions = self.read(self.user)['permissions']
            for rule in mod_only:
                self.assertNotIn(rule, permissions.get('allow', []))
                self.assertNotIn(rule, permissions.get('deny', []))

    def test_legacy_blanket_rule_is_migrated_by_auto_and_removed_by_ask(self):
        self.write(self.user, {'permissions': {'allow': ['Read']}})
        approval.save_record(self.home, {f'claude-code|{self.user}': {'added': ['mcp__lcu']}})
        self.write(self.user, {'permissions': {'allow': ['Read', 'mcp__lcu']}})
        self.assertTrue(approval.apply_claude('auto', self.home).startswith('added'))
        self.assertEqual(self.read(self.user)['permissions']['allow'], ['Read', 'mcp__lcu__js', 'mcp__lcu__js_reset'])
        self.assertEqual(approval.load_record(self.home)[f'claude-code|{self.user}']['added'],
                         ['mcp__lcu__js', 'mcp__lcu__js_reset'])
        approval.apply_claude('ask', self.home)
        self.assertEqual(self.read(self.user), {'permissions': {'allow': ['Read']}})

    def test_ask_removes_a_recorded_legacy_rule_without_migrating(self):
        self.write(self.user, {'permissions': {'allow': ['Read', 'mcp__lcu']}})
        approval.save_record(self.home, {f'claude-code|{self.user}': {'added': ['mcp__lcu']}})
        self.assertIn('removed', approval.apply_claude('ask', self.home))
        self.assertEqual(self.read(self.user), {'permissions': {'allow': ['Read']}})
        self.assertFalse(approval.load_record(self.home))

    def test_ask_never_removes_exact_rules_the_user_wrote(self):
        original = {'permissions': {'allow': ['mcp__lcu__js', 'mcp__lcu__js_reset']}}
        self.write(self.user, original)
        self.assertTrue(approval.apply_claude('auto', self.home).startswith('unchanged'))
        self.assertIn('kept your own', approval.apply_claude('ask', self.home))
        self.assertEqual(self.read(self.user), original)

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

    TOOLS = {'js': {'approval_mode': 'approve'}, 'js_reset': {'approval_mode': 'approve'}}

    def test_auto_approves_exactly_the_model_tools_and_never_the_server(self):
        policy = self.plan('auto')['policy']
        self.assertEqual(policy, {'tools': self.TOOLS})
        self.assertNotIn('default_tools_approval_mode', policy)
        self.assertEqual(self.plan('ask')['policy'], {})
        self.assertEqual(self.plan(None)['policy'], {})

    def test_ask_removes_only_the_tool_entries_auto_added(self):
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n')
        self.assertEqual(self.cycle('auto')['policy'],
                         {'default_tools_approval_mode': 'prompt', 'tools': self.TOOLS})
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n'
                   '[mcp_servers.lcu.tools.js]\napproval_mode = "approve"\n'
                   '[mcp_servers.lcu.tools.js_reset]\napproval_mode = "approve"\n')
        self.cycle('auto')  # idempotent
        self.assertEqual(self.plan('ask')['policy'], {'default_tools_approval_mode': 'prompt'})
        self.cycle('ask')
        self.assertFalse(approval.load_record(self.home))

    def test_a_tool_mode_the_user_set_is_kept_and_never_removed(self):
        self.write('[mcp_servers.lcu.tools.js]\napproval_mode = "prompt"\n'
                   '[mcp_servers.lcu.tools.js_reset]\napproval_mode = "approve"\n')
        self.assertEqual(self.cycle('auto')['policy']['tools'],
                         {'js': {'approval_mode': 'prompt'}, 'js_reset': {'approval_mode': 'approve'}})
        self.assertFalse(approval.load_record(self.home))
        self.assertEqual(self.plan('ask')['policy']['tools'],
                         {'js': {'approval_mode': 'prompt'}, 'js_reset': {'approval_mode': 'approve'}})

    def test_legacy_server_wide_record_is_migrated_by_auto_and_restored_by_ask(self):
        key = f'codex|{self.config}'
        for mode, expected in (('auto', {'default_tools_approval_mode': 'prompt', 'tools': self.TOOLS}),
                               ('ask', {'default_tools_approval_mode': 'prompt'})):
            approval.save_record(self.home, {key: {'prior': 'prompt'}})
            self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n')
            self.assertEqual(self.plan(mode)['policy'], expected)
        approval.save_record(self.home, {key: {'prior': None}})
        self.write('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n')
        self.assertEqual(self.plan('auto')['policy'], {'tools': self.TOOLS})
        self.assertEqual(self.plan('ask')['policy'], {})
        self.cycle('auto')
        self.assertEqual(approval.load_record(self.home)[key], {'tools': ['js', 'js_reset']})

    def test_registration_policy_merges_tools_over_the_host_contract(self):
        host = {'startup_timeout_sec': 120, 'tools': {'js': {'output_token_limit': 25000}}}
        merged = approval.merge_codex_policy(host, {'tools': self.TOOLS})
        self.assertEqual(merged['tools']['js'], {'output_token_limit': 25000, 'approval_mode': 'approve'})
        self.assertEqual(merged['tools']['js_reset'], {'approval_mode': 'approve'})
        self.assertEqual(approval.merge_codex_policy(host, {}), host)

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

    def test_registration_policy_carries_the_tool_approvals_only_for_auto(self):
        policy, host = self.register('auto')
        self.assertEqual(policy, {**host, 'tools': self.TOOLS})
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

    def test_export_cannot_carry_an_approval_mode(self):
        argv = ['--export', '/tmp/new-export', '--approval', 'auto']
        if os.getuid() == 0:
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
        for name in ('bin/lcu', 'bin/lcu-session'):
            path = self.prefix / 'current' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')
            path.chmod(0o755)
        self.configured = []

    def drive(self, *argv, agents=('codex',), failures=()):
        account = SimpleNamespace(pw_name='fixture', pw_uid=os.getuid(), pw_dir=str(self.home))

        def configure(names, home, command, *args, **kwargs):
            self.configured.append(kwargs.get('approval', 'missing'))
            return list(failures)

        out = io.StringIO()
        with patch.object(setup.sys, 'platform', 'linux'), \
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
        self.assertIn('Codex: `approval_mode = "approve"` for the `js` and `js_reset` tools', output)
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
