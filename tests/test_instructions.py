import io
import shutil
import json
import os
from contextlib import nullcontext
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import setup
from lcu.setup import (agent_scopes, configure, export_bundle, host_policy, remove_generated_skill, remove_old_skill,
                       installed_app_resources, load_setup_state, parser, save_setup_state,
                       setup_state_path, validate)
from lcu.setup_clients import CLIENTS

class InstalledInstructionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.root = Path(self.temp.name)
        self.release = self.root / 'release'
        self.app = self.release / 'app'
        self.resources = self.app / 'resources'
        self.modules = self.resources / 'cua_node/lib/node_modules'
        self.home = self.root / 'home'
        self.home.mkdir()
        self.release.mkdir()
        (self.release / 'installation.json').write_text('{"version":"fixture","app":"app"}')
        host_plugin = self.resources / 'plugins/openai-bundled/plugins/unified-computer-use'
        host_plugin.mkdir(parents=True)
        (host_plugin / '.mcp.json').write_text('{"mcpServers":{"cua_repl":{"type":"stdio","command":"node","args":[]}}}')
        required = {
            '@oai/cua/docs/tinysky-alt-core-cua-repl.md': 'original core guide',
            '@oai/cua/docs/tinysky-alt-confirmations.md': 'original policy guide',
            '@oai/cua-repl/instructions/linux/description.md': 'original Linux description',
            '@oai/cua-repl/instructions/linux/computer.md': 'original Linux computer docs',
            '@oai/cua-repl/instructions/macos/description.md': 'inactive macOS description',
            '@oai/browser-desktop/environment-docs/codex-app/api.json': '{"api":[]}',
            '@oai/browser-desktop/environment-docs/codex-app/documents.json': '{"documents":[]}',
            '@oai/browser-desktop/environment-docs/codex-app/capabilities/tab/cdp.md': 'effective Chrome docs',
            '@oai/sky/docs/skills/oai_sky_lib/linux/SKILL.md': 'original Linux skill',
            '@oai/sky/docs/sky-full-desktop-api.md': 'original native API',
            '@oai/sky/docs/sky-window-api.md': 'original window API',
            '@oai/sky/docs/sky-window2-api.md': 'original window API version two',
        }
        for relative, text in required.items():
            path = self.modules / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        chrome = self.resources / 'plugins/openai-bundled/plugins/chrome'
        for relative, text in {
            'docs/api.json': '{"apis":[]}',
            'docs/documents.json': '{"documents":[]}',
            'docs/capabilities/tab/cdp.md': 'original Chrome capability',
            'skills/control-chrome/SKILL.md': 'original Chrome skill',
        }.items():
            path = chrome / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def tearDown(self):
        self.temp.cleanup()

    def test_setup_removes_the_skill_generated_by_earlier_versions(self):
        # Official Codex computer use registers no skill, so LCU no longer generates one.
        remove_generated_skill(self.home)  # Nothing to remove is not an error.
        old = self.home / '.local/share/lcu/skills/lcu'
        (old / 'references/upstream/cua/docs').mkdir(parents=True)
        (old / 'SKILL.md').write_text('Before the first call, read the copied guides.')
        (old / 'references/upstream/cua/docs/tinysky-alt-core-cua-repl.md').write_text('copied guide')
        remove_generated_skill(self.home)
        self.assertFalse((self.home / '.local/share/lcu/skills').exists())

    def test_old_skill_cleanup_removes_only_lcus_own_skill(self):
        installed = self.root / 'installed/lcu'
        installed.mkdir(parents=True)
        calls = []

        def run(argv, **kwargs):
            calls.append(argv[2:])
            if argv[2] == 'list':
                return SimpleNamespace(returncode=0, stdout=json.dumps(listing), stderr='')
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        cases = (
            ([], None, 'none'),
            ([{'name': 'lcu', 'path': str(installed)}],
             'description: Control macOS desktop windows through the original Codex computer-use runtime.', 'removed'),
            ([{'name': 'lcu', 'path': str(installed)}],
             'description: Read and operate Linux desktop windows using the LCU MCP computer-use tools.', 'removed'),
            ([{'name': 'lcu', 'path': str(installed)}], 'description: Someone else\'s unrelated skill.', 'kept'),
            ([{'name': 'lcu', 'path': str(installed)}],
             'description: My notes. See the original Codex computer-use runtime docs.\nname: other', 'kept'),
        )
        for listing, text, expected in cases:
            with self.subTest(expected=expected, text=text):
                calls.clear()
                if text:
                    (installed / 'SKILL.md').write_text(f'---\nname: lcu\n{text}\n---\n')
                with patch('lcu.setup.subprocess.run', side_effect=run):
                    self.assertEqual(remove_old_skill('node', 'skills', self.root, {}, ['--global']), expected)
                self.assertEqual(calls[0], ['list', '--json', '--global'])
                # Removal is for every agent, so the shared .agents/skills copy goes too.
                self.assertEqual(calls[1:], [['remove', 'lcu', '--yes', '--global']] if expected == 'removed' else [])

    def test_export_carries_no_skill_and_no_upstream_payload(self):
        destination = self.root / 'export'
        with patch('lcu.setup.host_policy', return_value={}), patch('lcu.codex_hooks.export_files', return_value={}):
            export_bundle(destination, ['/usr/bin/lcu'], self.release)
        self.assertFalse((destination / 'skills').exists())
        contents = b'\n'.join(path.read_bytes() for path in destination.rglob('*') if path.is_file())
        self.assertNotIn(b'original core guide', contents)
        self.assertNotIn(b'original Chrome skill', contents)
        self.assertNotIn(str(self.root).encode(), contents)
        self.assertNotIn(b'/usr/bin/lcu', contents)
        metadata = json.loads((destination / 'lcu-bootstrap.json').read_text())
        self.assertNotIn('instructionSources', metadata)
        self.assertNotIn('preCallRequirement', metadata)
        command = json.loads((destination / 'mcp.json').read_text())['mcpServers']['lcu']
        self.assertEqual(command['command'], '/bin/sh')
        self.assertIn('LCU_PREFIX', command['args'][1])
        self.assertIn('LCU_SESSION_MODE', command['args'][1])

    def test_exported_command_resolves_destination_prefix_and_session(self):
        destination = self.root / 'export'
        with patch('lcu.setup.host_policy', return_value={}), patch('lcu.codex_hooks.export_files', return_value={}):
            export_bundle(destination, ['/producer/private/lcu'], self.release)
        command = json.loads((destination / 'mcp.json').read_text())['mcpServers']['lcu']
        prefix = self.root / 'destination'
        bin_dir = prefix / 'current/bin'
        bin_dir.mkdir(parents=True)
        for name in ('lcu', 'lcu-session'):
            script = bin_dir / name
            script.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            script.chmod(0o755)
        env = {**os.environ, 'LCU_PREFIX': str(prefix), 'LCU_SESSION_MODE': 'direct'}
        result = subprocess.run([command['command'], *command['args'], 'doctor'],
                                env=env, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, 'doctor\n')
        env['LCU_SESSION_MODE'] = 'discover'
        result = subprocess.run([command['command'], *command['args'], 'doctor'],
                                env=env, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, f'--user\n{pwd.getpwuid(os.getuid()).pw_name}\n--\n{bin_dir / "lcu"}\ndoctor\n')

    def test_codex_export_routes_through_bundled_node_and_audio_relay(self):
        destination = self.root / 'codex-export'
        captured = {}
        policy = {'enabled_tools': ['js', 'js_reset', 'turn_ended'],
                  'omit_tools_from': ['code_mode', 'deferred'], 'startup_timeout_sec': 120,
                  'tools': {'js': {'output_token_limit': 25000}}}

        def export_files(command, _host_root):
            captured['command'] = command
            return {}

        with patch('lcu.setup.host_policy', return_value=policy), \
                patch('lcu.codex_hooks.export_files', side_effect=export_files):
            export_bundle(destination, ['/producer/private/lcu'], self.release)

        config = json.loads((destination / 'codex.mcp.json').read_text())['mcpServers']['lcu']
        self.assertEqual(config['command'], '/bin/sh')
        self.assertEqual(config['args'][0], '-c')
        self.assertIn('current/agent-tools/node/bin/node', config['args'][1])
        self.assertIn('current/adapters/codex.mjs', config['args'][1])
        self.assertIn('current/bin/lcu', config['args'][1])
        self.assertEqual(config['enabled_tools'], policy['enabled_tools'])
        self.assertEqual(config['omit_tools_from'], policy['omit_tools_from'])
        self.assertEqual(captured['command'], [config['command'], *config['args']])
        self.assertNotIn('/producer/private/lcu', '\n'.join(config['args']))

        prefix = self.root / 'destination'
        bin_dir = prefix / 'current/bin'
        node = prefix / 'current/agent-tools/node/bin/node'
        adapter = prefix / 'current/adapters/codex.mjs'
        server = bin_dir / 'lcu'
        session = bin_dir / 'lcu-session'
        for path in (node, adapter, server, session):
            path.parent.mkdir(parents=True, exist_ok=True)
        node.write_text('#!' + sys.executable + '\nimport sys\nprint("\\n".join(sys.argv[1:]))\n')
        session.write_text('#!' + sys.executable + '\nimport sys\nprint("\\n".join(sys.argv[1:]))\n')
        for path in (node, session):
            path.chmod(0o755)
        env = {**os.environ, 'LCU_PREFIX': str(prefix), 'LCU_SESSION_MODE': 'direct'}
        result = subprocess.run([config['command'], *config['args'], '--check'],
                                env=env, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, f'{adapter}\n{server}\n--check\n')

        env['LCU_SESSION_MODE'] = 'discover'
        result = subprocess.run([config['command'], *config['args'], '--check'],
                                env=env, text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, f'--user\n{pwd.getpwuid(os.getuid()).pw_name}\n--\n'
                         f'{node}\n{adapter}\n{server}\n--check\n')

    def test_claude_setup_forwards_command_and_installs_host_visibility_hooks(self):
        tool_root = self.root / 'agent-tools'
        tool_root.mkdir()
        node, skill_cli, mcp_cli = (tool_root / name for name in ('node', 'skills.mjs', 'mcp.mjs'))
        adapter = self.release / 'adapters/claude.mjs'
        adapter.parent.mkdir(parents=True)
        adapter.write_text('fixture relay')
        shutil.copytree(Path(__file__).resolve().parents[1] / 'adapters/claude-mod', adapter.parent / 'claude-mod')
        project = self.root / 'project'
        project.mkdir()
        user_settings = self.home / '.claude/settings.json'
        user_settings.parent.mkdir()
        user_settings.write_text(json.dumps({
            'model': 'sonnet',
            'permissions': {'allow': ['Read'], 'deny': ['Bash(rm *)']},
            'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'keep-me'}]}]},
        }))
        calls = []
        selected_scope = {'value': 'user'}

        def run(argv, **kwargs):
            calls.append(argv)
            if argv[1:3] == [str(skill_cli), 'list']:
                self.assertEqual('--global' in argv, selected_scope['value'] == 'user')
                return SimpleNamespace(returncode=0, stdout='[]')
            return SimpleNamespace(returncode=0, stdout='{}')

        def register(scope, command):
            calls.clear()
            selected_scope['value'] = scope
            with patch('lcu.setup.installer_paths', return_value=(node, skill_cli, mcp_cli)), \
                    patch('lcu.setup.preflight_mcp'), patch('lcu.setup.subprocess.run', side_effect=run):
                failures = configure(['claude-code'], self.home,
                                     command, tool_root, self.release, scope=scope,
                                     project=project if scope == 'project' else None,
                                     environ={'HOME': str(self.home)})
            self.assertEqual(failures, [])
            self.assertEqual(len(calls), 2)
            mcp_call = next(argv for argv in calls if argv[1:3] == ['--input-type=module', '-e'])
            self.assertEqual(mcp_call[4], str(mcp_cli))
            self.assertEqual(mcp_call[5:7], ['claude-code', scope])
            return json.loads(mcp_call[-2])

        base_command = ['/usr/bin/lcu', '--session', 'direct']
        self.assertEqual(register('user', base_command), [str(node), str(adapter), *base_command])
        configured_user = user_settings.read_bytes()
        user_data = json.loads(configured_user)
        self.assertEqual(user_data['model'], 'sonnet')
        self.assertEqual(user_data['permissions']['allow'], ['Read'])
        self.assertEqual(user_data['permissions']['deny'], ['Bash(rm *)',
                         'mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir',
                         'mcp__lcu__set_turn_context'])
        self.assertEqual(user_data['hooks']['UserPromptSubmit'][0]['hooks'][0]['command'], 'keep-me')
        self.assertEqual(user_data['hooks']['PreToolUse'][0]['matcher'],
                         'mcp__lcu__js|mcp__lcu__js_reset')
        context_hook = user_data['hooks']['PreToolUse'][0]['hooks'][0]
        self.assertEqual((context_hook['type'], context_hook['server'], context_hook['tool']),
                         ('mcp_tool', 'lcu', 'set_turn_context'))
        self.assertEqual(context_hook['input']['session_id'], '${session_id}')
        self.assertEqual(context_hook['input']['turn_id'], '${prompt_id}')
        self.assertEqual(context_hook['input']['tool_use_id'], '${tool_use_id}')
        cleanup_hook = user_data['hooks']['Stop'][0]['hooks'][0]
        self.assertEqual((cleanup_hook['type'], cleanup_hook['server'], cleanup_hook['tool']),
                         ('mcp_tool', 'lcu', 'turn_ended'))
        self.assertEqual(cleanup_hook['input']['session_id'], '${session_id}')
        self.assertEqual(cleanup_hook['input']['turn_id'], '${prompt_id}')
        register('user', base_command)
        self.assertEqual(user_settings.read_bytes(), configured_user)

        project_command = [*base_command, '--chrome', '--audio']
        self.assertEqual(register('project', project_command),
                         [str(node), str(adapter), *project_command])
        project_settings = project / '.claude/settings.local.json'
        self.assertTrue(project_settings.is_file())
        self.assertFalse((project / '.claude/settings.json').exists())
        self.assertEqual(json.loads(project_settings.read_text())['permissions']['deny'], [
            'mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir',
            'mcp__lcu__set_turn_context'])
        configured_project = project_settings.read_bytes()
        register('project', project_command)
        self.assertEqual(project_settings.read_bytes(), configured_project)
        self.assertEqual(user_settings.read_bytes(), configured_user)
        # The approval mod is a plugin folder in the skills directory of each selected scope.
        self.assertTrue((self.home / '.claude/skills/lcu-approve/.claude-plugin/plugin.json').is_file())
        self.assertTrue((project / '.claude/skills/lcu-approve/hooks/register.tsx').is_file())

    def test_codex_setup_wraps_original_lcu_command_and_retains_host_policy(self):
        original_codex = self.resources / 'codex-cli/bin/codex'
        original_host = self.resources / 'codex-cli/bin/codex-code-mode-host'
        original_codex.parent.mkdir(parents=True, exist_ok=True)
        original_codex.write_text('original Codex CLI')
        original_host.write_text('original code-mode host')
        tool_root = self.root / 'agent-tools'
        tool_root.mkdir()
        node, skill_cli, mcp_cli = (tool_root / name for name in ('node', 'skills.mjs', 'mcp.mjs'))
        adapter = self.release / 'adapters/codex.mjs'
        helper = self.release / 'adapters/audio-files.mjs'
        adapter.parent.mkdir(parents=True)
        adapter.write_text('fixture relay')
        helper.write_text('fixture helper')
        original = ['/opt/lcu/current/bin/lcu', '--chrome', '--audio', '--session=direct']
        calls = []
        policy = {'enabled_tools': ['js', 'js_reset', 'turn_ended'],
                  'omit_tools_from': ['code_mode', 'deferred'], 'startup_timeout_sec': 120,
                  'tools': {'js': {'output_token_limit': 25000}}}
        config = self.home / '.codex/config.toml'
        config.parent.mkdir(parents=True)

        def run(argv, **_kwargs):
            calls.append(argv)
            if argv[1:3] == [str(skill_cli), 'list']:
                return SimpleNamespace(returncode=0, stdout='[]')
            return SimpleNamespace(returncode=0, stdout=json.dumps({'path': str(config)}))

        with patch('lcu.setup.installer_paths', return_value=(node, skill_cli, mcp_cli)), \
                patch('lcu.setup.host_policy', return_value=policy), \
                patch('lcu.setup.preflight_mcp'), \
                patch('lcu.setup.subprocess.run', side_effect=run), \
                patch('lcu.codex_hooks.require_cli_hook_support'), \
                patch('lcu.codex_hooks.install_hooks') as install_hooks:
            failures = configure(['codex'], self.home, original,
                                 tool_root, self.release, environ={'HOME': str(self.home)})

        self.assertEqual(failures, [])
        self.assertEqual(len(calls), 2)
        mcp_call = next(argv for argv in calls if argv[1:3] == ['--input-type=module', '-e'])
        self.assertEqual(json.loads(mcp_call[-2]), [str(node), str(adapter), *original])
        self.assertEqual(json.loads(mcp_call[-1]), policy)
        self.assertEqual(install_hooks.call_args.args[0], original_codex)
        self.assertEqual(install_hooks.call_args.args[1], config)

    def test_pi_registration_removes_old_skill_and_uses_offline_local_package(self):
        self.assertEqual(set(CLIENTS), {'codex', 'claude-code', 'pi', 'omp', 'hermes'})
        tool_root = self.root / 'agent-tools'
        node, skill_cli, mcp_cli = (tool_root / name for name in ('node', 'skills.mjs', 'mcp.mjs'))
        (self.release / 'adapters/pi').mkdir(parents=True)
        (self.release / 'adapters/pi/index.ts').write_text('fixture')
        selected_commands = self.home / '.local/share/lcu/pi/commands.json'
        selected_commands.parent.mkdir(parents=True)
        selected_commands.write_text(json.dumps({'projects': {'/existing/project': ['/usr/bin/lcu']},
                                                 'preserved': True}))
        calls = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            if argv[1:3] == [str(skill_cli), 'list']:
                return SimpleNamespace(returncode=0, stdout='[]')
            self.assertEqual(argv[1:3], ['install', str(self.home / '.local/share/lcu/pi/extension.mjs')])
            self.assertEqual(kwargs['env']['PI_OFFLINE'], '1')
            return SimpleNamespace(returncode=0, stdout='Installed')

        with patch('lcu.setup.installer_paths', return_value=(node, skill_cli, mcp_cli)), \
                patch('lcu.setup.shutil.which', return_value='/bin/pi'), \
                patch('lcu.setup.subprocess.run', side_effect=run):
            failures = configure(['pi'], self.home,
                                 ['/usr/bin/lcu', '--audio'], tool_root, self.release,
                                 environ={'HOME': str(self.home)})
        self.assertEqual(failures, [])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0][0], '/bin/pi')
        wrapper = (self.home / '.local/share/lcu/pi/extension.mjs').read_text()
        self.assertIn((self.release / 'adapters/pi/index.ts').as_uri(), wrapper)
        self.assertIn('realpathSync(process.cwd())', wrapper)
        self.assertNotIn('.pi/lcu-command.json', wrapper)
        self.assertEqual(json.loads((self.home / '.local/share/lcu/pi/commands.json').read_text()),
                         {'projects': {'/existing/project': ['/usr/bin/lcu']},
                          'preserved': True, 'user': ['/usr/bin/lcu', '--audio']})

    def test_selected_app_descriptor_and_resources_are_required(self):
        self.assertEqual(installed_app_resources(self.release), self.resources.resolve())
        self.assertEqual(host_policy(self.release), {'type': 'stdio'})
        (self.release / 'installation.json').unlink()
        with self.assertRaisesRegex(ValueError, 'descriptor missing'):
            installed_app_resources(self.release)

    def test_legacy_browser_host_flag_fails_with_chrome_migration(self):
        args = parser().parse_args(['--browser-host'])
        with self.assertRaisesRegex(ValueError, 'setup --agent AGENT --chrome'):
            validate(args)

    def test_chrome_export_only_adds_runtime_flag_when_selected(self):
        with patch('lcu.setup.host_policy', return_value={}), patch('lcu.codex_hooks.export_files', return_value={}):
            export_bundle(self.root / 'native-export', ['/usr/bin/lcu'], self.release)
            export_bundle(self.root / 'chrome-export', ['/usr/bin/lcu', '--chrome'],
                          self.release, chrome=True)
            export_bundle(self.root / 'audio-export', ['/usr/bin/lcu', '--audio'],
                          self.release, audio=True)
        native = json.loads((self.root / 'native-export/mcp.json').read_text())['mcpServers']['lcu']
        browser = json.loads((self.root / 'chrome-export/mcp.json').read_text())['mcpServers']['lcu']
        audio = json.loads((self.root / 'audio-export/mcp.json').read_text())['mcpServers']['lcu']
        self.assertNotIn('--chrome', native['args'])
        self.assertEqual(browser['args'][-1], '--chrome')
        self.assertEqual(audio['args'][-1], '--audio')
        metadata = json.loads((self.root / 'chrome-export/lcu-bootstrap.json').read_text())
        self.assertIn('--chrome', metadata['destinationSetup'])
        audio_metadata = json.loads((self.root / 'audio-export/lcu-bootstrap.json').read_text())
        self.assertIn('--audio', audio_metadata['destinationSetup'])

    def test_setup_state_round_trips_and_rejects_malformed(self):
        self.assertEqual(load_setup_state(self.home), {'chrome': False, 'audio': False, 'approval': 'ask',
                                                       'pending': [], 'pending_context': None})
        save_setup_state(self.home, chrome=True, audio=False)
        self.assertEqual(load_setup_state(self.home), {'chrome': True, 'audio': False, 'approval': 'ask',
                                                       'pending': [], 'pending_context': None})
        self.assertEqual(json.loads(setup_state_path(self.home).read_text()),
                         {'chrome': True, 'audio': False, 'approval': 'ask'})
        save_setup_state(self.home, chrome=True, audio=False, approval='auto')
        self.assertEqual(load_setup_state(self.home)['approval'], 'auto')
        # A state file from before approval modes existed means ask.
        setup_state_path(self.home).write_text('{"chrome": true, "audio": false}')
        self.assertEqual(load_setup_state(self.home), {'chrome': True, 'audio': False, 'approval': 'ask',
                                                       'pending': [], 'pending_context': None})
        setup_state_path(self.home).write_text('{"chrome": true, "audio": false, "approval": "yolo"}')
        with self.assertRaisesRegex(ValueError, 'Malformed LCU setup state'):
            load_setup_state(self.home)
        setup_state_path(self.home).write_text('{ not json')
        with self.assertRaisesRegex(ValueError, 'Malformed LCU setup state'):
            load_setup_state(self.home)
        setup_state_path(self.home).write_text('{"chrome": "yes", "audio": false}')
        with self.assertRaisesRegex(ValueError, 'Malformed LCU setup state'):
            load_setup_state(self.home)

    def test_conflicting_chrome_and_audio_flags_are_rejected(self):
        for pair in (['--chrome', '--no-chrome'], ['--audio', '--no-audio']):
            args = parser().parse_args([*pair, '--agent', 'codex'])
            with self.assertRaisesRegex(ValueError, 'not both'):
                validate(args)

    def test_list_agents_shows_user_only_scope_for_native_harness_plugins(self):
        self.assertEqual(agent_scopes('omp'), 'user')
        self.assertEqual(agent_scopes('hermes'), 'user')
        self.assertEqual(agent_scopes('codex'), 'user, project')
        with patch('sys.stdout', io.StringIO()) as out:
            setup.main(['--list-agents'])
        listing = out.getvalue()
        self.assertRegex(listing, r'omp .*\(user\)')
        self.assertRegex(listing, r'hermes .*\(user\)')
        self.assertRegex(listing, r'codex .*\(user, project\)')

    def test_setup_persists_and_reuses_chrome_opt_in(self):
        prefix = self.root / 'prefix'
        binary = prefix / 'current/bin/lcu'
        session = prefix / 'current/bin/lcu-session'
        binary.parent.mkdir(parents=True)
        for path in (binary, session):
            path.write_text('fixture')
            path.chmod(0o755)
        account = SimpleNamespace(pw_name='fixture', pw_uid=os.getuid(), pw_dir=str(self.home))
        captured = []

        def fake_configure(names, home, command, *args, **kwargs):
            captured.append(command)
            return []

        def run(argv, **kwargs):
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        def drive(argv):
            with patch.object(setup.sys, 'platform', 'linux'), \
                 patch.object(setup, 'validate', return_value=(account, ['codex'])), \
                 patch.object(setup, 'installer_environment'), \
                 patch.object(setup, 'installer_paths'), \
                 patch.object(setup, 'setup_lock', return_value=nullcontext()), \
                 patch.object(setup, 'configure', side_effect=fake_configure), \
                 patch('lcu.browser.install'), \
                 patch.object(setup.subprocess, 'run', side_effect=run), \
                 patch('sys.stdout', io.StringIO()):
                setup.main(['--prefix', str(prefix), '--agent', 'codex', '--session', 'direct', *argv])

        drive(['--chrome', '--yes'])
        self.assertEqual(json.loads((self.home / '.local/state/lcu/setup.json').read_text()),
                         {'chrome': True, 'audio': False, 'approval': 'ask'})
        self.assertIn('--chrome', captured[-1])
        drive(['--yes'])
        self.assertIn('--chrome', captured[-1])
        drive(['--no-chrome', '--yes'])
        self.assertNotIn('--chrome', captured[-1])
        self.assertEqual(json.loads((self.home / '.local/state/lcu/setup.json').read_text()),
                         {'chrome': False, 'audio': False, 'approval': 'ask'})
        # A saved decline is a choice: an interactive rerun does not prompt again.
        prompts = []

        def answer(question):
            prompts.append(question)
            return 'y'

        with patch.object(setup.sys.stdin, 'isatty', return_value=True), \
                patch('builtins.input', side_effect=answer):
            drive([])
        self.assertEqual(prompts, ['Apply this setup? [y/N] '])
        self.assertNotIn('--chrome', captured[-1])
