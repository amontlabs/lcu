import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

if sys.platform == 'win32':
    raise unittest.SkipTest('Linux and macOS app layouts; test_windows_runtime covers Windows')

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu.runtime import environment, main, paths
from lcu.browser import install


class UpstreamRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.root = base / 'releases/release'
        self.root.mkdir(parents=True)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_installation import _application_fixture
        self.app = _application_fixture(base / 'usr/lib/chatgpt', runtime_version='fixture-runtime-new').resolve()
        (self.root / 'app').symlink_to(self.app, target_is_directory=True)
        (self.root / 'runtime.lock.json').write_text(json.dumps({
            'runtime': 'fixture-runtime', 'version': '26.915.31945',
            'architectures': {'arm64': {'sha256': 'fixture-digest'}},
        }))
        (self.root / 'installation.json').write_text(json.dumps({
            'app': str(self.app), 'architecture': 'arm64', 'package_version': '26.924.22138',
            'runtime': 'fixture-runtime-new',
        }))

    def tearDown(self):
        self.temporary.cleanup()

    def test_default_enables_original_computer_surface(self):
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        self.assertEqual(env['CUA_REPL_ENABLED_SURFACES'], 'computer')
        self.assertEqual(env['CUA_REPL_BROWSER_ENV'], 'codex-app')
        self.assertEqual(env['CODEX_CLI_PATH'], str(self.root / 'app/resources/codex'))
        self.assertEqual(env['BROWSER_USE_AVAILABLE_BACKENDS'], 'chrome')
        self.assertEqual(env['NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS'], '1000')
        self.assertEqual(env['BROWSER_USE_TINYSKY_ENABLED'], '1')
        self.assertEqual(env['BROWSER_USE_CODEX_APP_BUILD_FLAVOR'], 'prod')
        self.assertEqual(env['BROWSER_USE_CODEX_APP_VERSION'], '26.924.22138')
        self.assertEqual(env['BROWSER_USE_DISABLE_AMBIENT_NETWORK'], '1')
        self.assertNotIn('SKY_ENABLE_AUDIO', env)
        self.assertNotIn('NODE_REPL_ENABLE_AUDIO', env)

    def test_audio_opt_in_sets_both_original_runtime_flags(self):
        with patch.dict(os.environ, {'SKY_ENABLE_AUDIO': '0', 'NODE_REPL_ENABLE_AUDIO': '0'}, clear=True):
            env = environment(self.root, audio=True)
        self.assertEqual(env['SKY_ENABLE_AUDIO'], '1')
        self.assertEqual(env['NODE_REPL_ENABLE_AUDIO'], '1')

    def test_audio_off_preserves_explicit_caller_environment_policy(self):
        settings = {'SKY_ENABLE_AUDIO': '1', 'NODE_REPL_ENABLE_AUDIO': '1'}
        with patch.dict(os.environ, settings, clear=True):
            env = environment(self.root)
        self.assertEqual(env['SKY_ENABLE_AUDIO'], '1')
        self.assertEqual(env['NODE_REPL_ENABLE_AUDIO'], '1')

    def test_caller_configuration_and_policies_survive(self):
        settings = {'CUA_REPL_BROWSER_ENV': 'orbit', 'CUA_REPL_ENABLED_SURFACES': 'browser',
                    'OAI_SKY_CONFIG_PATH': '/desktop/options.json', 'OAI_SKY_LINUX_BIN': '/engine/sky',
                    'NODE_REPL_JS_BANNER': 'configured startup', 'NODE_REPL_TRUSTED_SERVICES': '{"custom":"service"}',
                    'NODE_REPL_REQUEST_META': '{"test":"context"}', 'NODE_REPL_FORCE_STRICT_AUTO_REVIEW': '1',
                    'NODE_REPL_ENFORCE_MODEL_CHECK': '1', 'CODEX_CLI_PATH': '/host/codex',
                    'BROWSER_USE_AVAILABLE_BACKENDS': 'chrome,cdp,iab', 'BROWSER_USE_CONFIG_PATH': '/browser.json',
                    'NODE_REPL_ENABLE_NETWORK_ISOLATION': '1', 'NODE_REPL_DISABLE_ANALYTICS': '0',
                    'BROWSER_USE_TINYSKY_ENABLED': '0', 'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS': '2300',
                    'BROWSER_USE_DISABLE_AMBIENT_NETWORK': '0',
                    'BROWSER_USE_CODEX_APP_BUILD_FLAVOR': 'alpha', 'BROWSER_USE_CODEX_APP_VERSION': 'fixture'}
        with patch.dict(os.environ, settings, clear=True):
            env = environment(self.root)
        for key, value in settings.items():
            if key == 'NODE_REPL_REQUEST_META':
                self.assertEqual(json.loads(env[key]), json.loads(value))
                continue
            self.assertEqual(env[key], value, key)

    def test_generic_connection_identity_has_no_invented_policy_or_model(self):
        with patch.dict(os.environ, {}, clear=True):
            first = environment(self.root)
            second = environment(self.root)
        metadata = json.loads(first['NODE_REPL_REQUEST_META'])
        self.assertEqual(set(metadata), {'x-codex-turn-metadata'})
        turn = metadata['x-codex-turn-metadata']
        self.assertEqual(set(turn), {'session_id', 'turn_id'})
        self.assertNotEqual(first['NODE_REPL_REQUEST_META'], second['NODE_REPL_REQUEST_META'])

    def test_an_unusable_launch_directory_is_left_for_the_filesystem_root(self):
        from lcu.runtime import _leave_unusable_working_directory
        blocked = Path(self.temporary.name) / 'blocked'
        blocked.mkdir()
        previous = os.getcwd()
        try:
            os.chdir(blocked)
            with patch('os.access', return_value=False):
                _leave_unusable_working_directory()
            self.assertEqual(os.getcwd(), os.path.realpath('/'))
            os.chdir(blocked)
            _leave_unusable_working_directory()
            self.assertEqual(os.getcwd(), os.path.realpath(blocked))
        finally:
            os.chdir(previous)

    def install_sandbox_shim(self):
        (self.root / 'bin').mkdir(exist_ok=True)
        shim = self.root / 'bin/lcu-codex-sandbox'
        shim.write_text('#!/bin/sh\n')
        shim.chmod(0o755)
        return shim

    def test_linux_default_points_node_repl_at_the_sandbox_shim(self):
        shim = self.install_sandbox_shim()
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        config = json.loads(env['LCU_SANDBOX_SHIM'])
        self.assertEqual(env['CODEX_CLI_PATH'], str(shim))
        self.assertNotEqual(config['codex'], str(shim))
        self.assertEqual(config['runtime'], env['NODE_REPL_NODE_PATH'].removesuffix('/bin/node'))
        self.assertIsNone(config['wrapper'])
        self.assertIn('LCU_SANDBOX_SHIM', env['NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'].split(','))
        # No host sandbox state is invented: the kernel stays under the sandbox node_repl chooses.
        self.assertEqual(set(json.loads(env['NODE_REPL_REQUEST_META'])), {'x-codex-turn-metadata'})

    def test_shim_configuration_keeps_a_caller_allowlist_and_codex_path(self):
        shim = self.install_sandbox_shim()
        with patch.dict(os.environ, {'CODEX_CLI_PATH': '/host/codex',
                                     'NODE_REPL_UNTRUSTED_ENV_ALLOWLIST': 'FIRST,SECOND'}, clear=True):
            env = environment(self.root)
        self.assertEqual(json.loads(env['LCU_SANDBOX_SHIM'])['codex'], '/host/codex')
        self.assertEqual(env['CODEX_CLI_PATH'], str(shim))
        self.assertEqual(env['NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'], 'FIRST,SECOND,LCU_SANDBOX_SHIM')

    def test_the_test_only_fault_hook_reaches_the_kernels_launcher_only_when_set(self):
        self.install_sandbox_shim()
        with patch.dict(os.environ, {}, clear=True):
            self.assertNotIn('FAULT', environment(self.root)['NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'])
        with patch.dict(os.environ, {'LCU_TEST_SANDBOX_SHIM_FAULT': 'unrecognized-kernel'}, clear=True):
            allowed = environment(self.root)['NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'].split(',')
        self.assertEqual(allowed, ['LCU_SANDBOX_SHIM', 'LCU_TEST_SANDBOX_SHIM_FAULT'])

    def test_shim_is_told_about_lcus_own_sky_wrapper(self):
        self.install_sandbox_shim()
        self.install_linux_input_wrapper()
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        wrapper = str(self.root / 'lcu/linux_sky_service.mjs')
        self.assertEqual(json.loads(env['NODE_REPL_TRUSTED_SERVICES'])['sky'], wrapper)
        self.assertEqual(json.loads(env['LCU_SANDBOX_SHIM'])['wrapper'], wrapper)

    def test_missing_shim_keeps_the_original_behavior_which_fails_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        self.assertNotIn('LCU_SANDBOX_SHIM', env)
        self.assertNotIn('LCU_SANDBOX_SHIM', env.get('NODE_REPL_UNTRUSTED_ENV_ALLOWLIST', ''))
        self.assertNotEqual(Path(env['CODEX_CLI_PATH']).name, 'lcu-codex-sandbox')
        self.assertEqual(set(json.loads(env['NODE_REPL_REQUEST_META'])), {'x-codex-turn-metadata'})

    def test_off_gives_the_original_node_repl_a_disabled_sandbox_state(self):
        shim = self.install_sandbox_shim()
        with patch.dict(os.environ, {'LCU_NODE_REPL_SANDBOX': 'off'}, clear=True):
            env = environment(self.root)
        state = json.loads(env['NODE_REPL_REQUEST_META'])['codex/sandbox-state-meta']
        self.assertEqual(state['permissionProfile'], {'type': 'disabled'})
        self.assertEqual(state['sandboxCwd'], Path.cwd().as_uri())
        self.assertNotIn('LCU_SANDBOX_SHIM', env)
        self.assertNotEqual(env['CODEX_CLI_PATH'], str(shim))

    def test_off_adds_only_the_missing_state_to_host_metadata(self):
        supplied = {'x-codex-turn-metadata': {'session_id': 'host-session', 'turn_id': 'host-turn'}}
        with patch.dict(os.environ, {'LCU_NODE_REPL_SANDBOX': 'off',
                                     'NODE_REPL_REQUEST_META': json.dumps(supplied)}, clear=True):
            actual = json.loads(environment(self.root)['NODE_REPL_REQUEST_META'])
        self.assertEqual(actual.pop('codex/sandbox-state-meta')['permissionProfile'], {'type': 'disabled'})
        self.assertEqual(actual, supplied)

    def test_host_supplied_sandbox_state_is_never_replaced(self):
        self.install_sandbox_shim()
        strict = {'permissionProfile': {'type': 'managed', 'file_system': {'type': 'unrestricted'},
                                        'network': 'restricted'}, 'sandboxCwd': 'file:///work'}
        supplied = json.dumps({'codex/sandbox-state-meta': strict, 'x-codex-turn-metadata': {'session_id': 's'}})
        for mode in ('', 'off', 'host'):
            with self.subTest(mode=mode), patch.dict(
                    os.environ, {'NODE_REPL_REQUEST_META': supplied, 'LCU_NODE_REPL_SANDBOX': mode}, clear=True):
                self.assertEqual(environment(self.root)['NODE_REPL_REQUEST_META'], supplied)

    def test_unparseable_or_non_object_host_metadata_is_left_alone(self):
        for mode in ('', 'off'):
            for supplied in ('not json', '[1]', '', '"text"'):
                with self.subTest(mode=mode, supplied=supplied), patch.dict(
                        os.environ, {'NODE_REPL_REQUEST_META': supplied, 'LCU_NODE_REPL_SANDBOX': mode}, clear=True):
                    self.assertEqual(environment(self.root)['NODE_REPL_REQUEST_META'], supplied)

    def test_host_mode_leaves_the_original_behavior_untouched(self):
        shim = self.install_sandbox_shim()
        with patch.dict(os.environ, {'LCU_NODE_REPL_SANDBOX': 'host'}, clear=True):
            env = environment(self.root)
        self.assertEqual(set(json.loads(env['NODE_REPL_REQUEST_META'])), {'x-codex-turn-metadata'})
        self.assertNotIn('LCU_SANDBOX_SHIM', env)
        self.assertNotEqual(env['CODEX_CLI_PATH'], str(shim))

    def test_other_platforms_keep_their_original_sandbox_state(self):
        with patch.dict(os.environ, {}, clear=True):
            metadata = json.loads(environment(self.root, platform='darwin')['NODE_REPL_REQUEST_META'])
        self.assertEqual(set(metadata), {'x-codex-turn-metadata'})

    def install_linux_input_wrapper(self, *entries):
        (self.root / 'lcu').mkdir(exist_ok=True)
        (self.root / 'lcu/linux_sky_service.mjs').write_text('export async function handleRpc() {}\n')
        (self.root / 'tested-versions.json').write_text(json.dumps({'format': 1, 'entries': list(entries)}))

    def pair_entry(self, **changes):
        return {'platform': 'linux', 'architecture': 'arm64', 'app_version': '26.924.22138',
                'runtime': 'fixture-runtime-new', 'lcu_version': '0.8.3', **changes}

    def test_linux_input_translation_wraps_only_the_sky_service(self):
        self.install_linux_input_wrapper()
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        wrapper = str(self.root / 'lcu/linux_sky_service.mjs')
        self.assertEqual(json.loads(env['NODE_REPL_TRUSTED_SERVICES']), {'sky': wrapper})
        self.assertEqual(env['LCU_LINUX_SKY_SERVICE_PATH'], str(
            self.root / 'app/resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'))
        self.assertEqual(env['LCU_LINUX_INPUT_TOOLKITS'], 'gtk4,qt-scroll')
        self.assertIn(str(self.root / 'lcu'), env['NODE_REPL_TRUSTED_CODE_PATHS'].split(os.pathsep))

    def test_linux_input_translation_keeps_the_browser_service_when_chrome_is_enabled(self):
        self.install_linux_input_wrapper()
        with patch.dict(os.environ, {}, clear=True):
            services = json.loads(environment(self.root, chrome=True)['NODE_REPL_TRUSTED_SERVICES'])
        self.assertEqual(services['browser'], '@oai/browser-desktop/service')
        self.assertEqual(services['sky'], str(self.root / 'lcu/linux_sky_service.mjs'))

    def test_linux_input_translation_can_be_turned_off(self):
        self.install_linux_input_wrapper()
        for value in ('off', 'OFF', ' off ', '0', 'false', 'no'):
            with self.subTest(value=value), patch.dict(os.environ, {'LCU_LINUX_INPUT_TRANSLATION': value}, clear=True):
                env = environment(self.root)
                self.assertNotIn('NODE_REPL_TRUSTED_SERVICES', env)
                self.assertNotIn('LCU_LINUX_SKY_SERVICE_PATH', env)
        with patch.dict(os.environ, {'LCU_LINUX_INPUT_TRANSLATION': 'on'}, clear=True):
            self.assertIn('NODE_REPL_TRUSTED_SERVICES', environment(self.root))

    def test_linux_input_translation_is_linux_only(self):
        self.install_linux_input_wrapper()
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root, platform='darwin')
        self.assertNotIn('LCU_LINUX_SKY_SERVICE_PATH', env)
        self.assertNotIn('NODE_REPL_TRUSTED_SERVICES', env)

    def test_a_caller_supplied_sky_service_takes_precedence(self):
        self.install_linux_input_wrapper()
        supplied = json.dumps({'sky': '/custom/sky.mjs'})
        with patch.dict(os.environ, {'NODE_REPL_TRUSTED_SERVICES': supplied}, clear=True):
            env = environment(self.root)
        self.assertEqual(env['NODE_REPL_TRUSTED_SERVICES'], supplied)
        self.assertNotIn('LCU_LINUX_SKY_SERVICE_PATH', env)

    def test_caller_supplied_service_maps_are_preserved_verbatim(self):
        self.install_linux_input_wrapper()
        for supplied in ('{}', '{"custom": "/custom/service.mjs"}', '{"browser": "@oai/browser-desktop/service"}',
                         '{"sky": "/custom/sky.mjs", "other": "x"}', '[]', 'not json'):
            with self.subTest(supplied=supplied), patch.dict(
                    os.environ, {'NODE_REPL_TRUSTED_SERVICES': supplied}, clear=True):
                env = environment(self.root)
            self.assertEqual(env['NODE_REPL_TRUSTED_SERVICES'], supplied)
            self.assertNotIn('LCU_LINUX_SKY_SERVICE_PATH', env)

    def test_an_explicit_original_sky_entry_is_replaced_and_other_entries_survive(self):
        self.install_linux_input_wrapper()
        supplied = json.dumps({'sky': '@oai/sky/service', 'other': '/custom/service.mjs'})
        with patch.dict(os.environ, {'NODE_REPL_TRUSTED_SERVICES': supplied}, clear=True):
            env = environment(self.root)
        self.assertEqual(json.loads(env['NODE_REPL_TRUSTED_SERVICES']),
                         {'sky': str(self.root / 'lcu/linux_sky_service.mjs'), 'other': '/custom/service.mjs'})
        self.assertIn('LCU_LINUX_SKY_SERVICE_PATH', env)

    def test_a_tested_pair_that_handles_a_toolkit_natively_is_not_translated_for_it(self):
        self.install_linux_input_wrapper(self.pair_entry(native_input=['gtk4']))
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(environment(self.root)['LCU_LINUX_INPUT_TOOLKITS'], 'qt-scroll')
        self.install_linux_input_wrapper(self.pair_entry(native_input=['gtk4', 'qt-scroll']))
        with patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        self.assertNotIn('NODE_REPL_TRUSTED_SERVICES', env)
        self.assertNotIn('LCU_LINUX_INPUT_TOOLKITS', env)

    def test_another_app_version_is_translated_even_when_a_tested_pair_is_native(self):
        self.install_linux_input_wrapper(self.pair_entry(app_version='26.999.1', native_input=['gtk4', 'qt-scroll']))
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(environment(self.root)['LCU_LINUX_INPUT_TOOLKITS'], 'gtk4,qt-scroll')

    def test_an_unreadable_tested_record_keeps_the_translation_on(self):
        self.install_linux_input_wrapper()
        (self.root / 'tested-versions.json').write_text('{broken')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(environment(self.root)['LCU_LINUX_INPUT_TOOLKITS'], 'gtk4,qt-scroll')

    def test_additional_module_and_trust_roots_survive(self):
        settings = {'NODE_REPL_NODE_MODULE_DIRS': '/extra/modules',
                    'NODE_REPL_TRUSTED_CODE_PATHS': '/trusted', 'PATH': '/usr/bin'}
        with patch.dict(os.environ, settings, clear=True), patch('lcu.runtime.Path.home', return_value=Path('/fixture')):
            env = environment(self.root)
        modules = self.root / 'app/resources/cua_node/lib/node_modules'
        plugins = self.root / 'app/resources/plugins'
        self.assertEqual(env['NODE_REPL_NODE_MODULE_DIRS'], f'{modules}:/extra/modules')
        self.assertEqual(env['NODE_REPL_TRUSTED_CODE_PATHS'],
                         f'/fixture/.codex:{modules}:{plugins}:/trusted')

    def test_default_codex_home_is_supplied_and_trusted(self):
        with patch.dict(os.environ, {}, clear=True), patch('lcu.runtime.Path.home', return_value=Path('/fixture')):
            env = environment(self.root)
        self.assertEqual(env['CODEX_HOME'], '/fixture/.codex')
        self.assertEqual(env['NODE_REPL_TRUSTED_CODE_PATHS'].split(os.pathsep)[0], '/fixture/.codex')

    def test_default_home_matches_node_posix_join(self):
        for home, expected in (('', '.codex'), ('relative/home', 'relative/home/.codex'),
                               ('relative/../home', 'home/.codex'), ('//fixture/home', '/fixture/home/.codex')):
            with self.subTest(home=home), patch.dict(os.environ, {'HOME': home}, clear=True):
                env = environment(self.root)
                self.assertEqual(env['CODEX_HOME'], expected)
                self.assertEqual(env['NODE_REPL_TRUSTED_CODE_PATHS'].split(os.pathsep)[0], expected)

    def test_explicit_codex_home_is_not_normalized(self):
        for selected in ('/fixture/custom', 'relative/../home', '  /fixture/spaces  ', ''):
            with self.subTest(selected=selected), patch.dict(os.environ, {'CODEX_HOME': selected}, clear=True):
                env = environment(self.root)
                self.assertEqual(env['CODEX_HOME'], selected)
                modules = self.root / 'app/resources/cua_node/lib/node_modules'
                plugins = self.root / 'app/resources/plugins'
                self.assertEqual(env['NODE_REPL_TRUSTED_CODE_PATHS'],
                                 (selected + ':' if selected else '') +
                                 f'{modules}:{plugins}')

    def test_launches_original_entrypoint(self):
        with patch.dict(os.environ, {'CUA_REPL_ENABLED_SURFACES': 'computer'}), patch('lcu.runtime.os.execve') as execute:
            main(self.root, [])
        self.assertEqual(execute.call_args.args[1],
            [str(self.root / 'app/resources/cua_node/bin/node'),
             str(self.root / 'app/resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')])

    def test_chrome_flag_selects_original_combined_runtime(self):
        with patch.dict(os.environ, {}, clear=True), patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--chrome'])
        self.assertEqual(execute.call_args.args[2]['CUA_REPL_ENABLED_SURFACES'], 'browser,computer')

    def test_audio_flag_reaches_original_mcp_child_as_paired_flags(self):
        with patch.dict(os.environ, {'SKY_ENABLE_AUDIO': '0'}, clear=True), \
             patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--audio'])
        child_env = execute.call_args.args[2]
        self.assertEqual(child_env['SKY_ENABLE_AUDIO'], '1')
        self.assertEqual(child_env['NODE_REPL_ENABLE_AUDIO'], '1')

    def test_audio_flag_keeps_registration_probes_and_duplicates_fail(self):
        output = io.StringIO()
        with patch('sys.stdout', output), patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--chrome', '--audio', '--version'])
        self.assertIn('ChatGPT linux 26.924.22138', output.getvalue())
        execute.assert_not_called()
        with patch('lcu.runtime.os.execve') as execute:
            with self.assertRaisesRegex(ValueError, 'Usage: lcu'):
                main(self.root, ['--audio', '--audio'])
        execute.assert_not_called()

    def test_duplicate_runtime_flags_do_not_bypass_help_or_version_validation(self):
        for args in (['--audio', '--audio', '--help'], ['--chrome', '--chrome', '--version']):
            with self.subTest(args=args):
                with patch('lcu.runtime.os.execve') as execute:
                    with self.assertRaisesRegex(ValueError, 'Usage: lcu'):
                        main(self.root, args)
                execute.assert_not_called()

    def test_chrome_registration_keeps_version_probe(self):
        output = io.StringIO()
        with patch('sys.stdout', output), patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--chrome', '--version'])
        self.assertIn('ChatGPT linux 26.924.22138', output.getvalue())
        self.assertIn('CUA fixture-runtime-new', output.getvalue())
        execute.assert_not_called()

    def test_explicit_surface_override_takes_precedence_over_chrome_flag(self):
        with patch.dict(os.environ, {'CUA_REPL_ENABLED_SURFACES': 'computer'}, clear=True), \
             patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--chrome'])
        self.assertEqual(execute.call_args.args[2]['CUA_REPL_ENABLED_SURFACES'], 'computer')

    def test_mcp_discovery_compat_probes_then_execs_original_server(self):
        following = b'{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'
        source = io.BytesIO(b'{"jsonrpc":"2.0","id":0,"method":"server/discover"}\n' + following)
        destination = io.BytesIO()
        stdin = SimpleNamespace(buffer=SimpleNamespace(raw=source))
        stdout = SimpleNamespace(buffer=destination)
        with patch('lcu.runtime.sys.stdin', stdin), patch('lcu.runtime.sys.stdout', stdout), \
                patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--mcp-discovery-compat'])

        self.assertEqual(json.loads(destination.getvalue()), {
            'jsonrpc': '2.0', 'id': 0,
            'error': {'code': -32601, 'message': 'Method not found'},
        })
        self.assertEqual(source.read(), following)
        node = self.root / 'app/resources/cua_node/bin/node'
        launcher = self.root / 'app/resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
        execute.assert_called_once()
        self.assertEqual(execute.call_args.args[:2], (node, [str(node), str(launcher)]))

    def test_chrome_command_preserves_discovery_compatibility(self):
        source = io.BytesIO(b'{"jsonrpc":"2.0","id":0,"method":"server/discover"}\n')
        destination = io.BytesIO()
        stdin = SimpleNamespace(buffer=SimpleNamespace(raw=source))
        stdout = SimpleNamespace(buffer=destination)
        with patch.dict(os.environ, {}, clear=True), patch('lcu.runtime.sys.stdin', stdin), \
             patch('lcu.runtime.sys.stdout', stdout), patch('lcu.runtime.os.execve') as execute:
            main(self.root, ['--chrome', '--mcp-discovery-compat'])
        self.assertEqual(json.loads(destination.getvalue())['error']['code'], -32601)
        self.assertEqual(execute.call_args.args[2]['CUA_REPL_ENABLED_SURFACES'], 'browser,computer')

    def test_mcp_discovery_compat_rejects_other_first_request_without_launching(self):
        source = io.BytesIO(b'{"jsonrpc":"2.0","id":0,"method":"tools/list"}\n')
        destination = io.BytesIO()
        stdin = SimpleNamespace(buffer=SimpleNamespace(raw=source))
        stdout = SimpleNamespace(buffer=destination)
        with patch('lcu.runtime.sys.stdin', stdin), patch('lcu.runtime.sys.stdout', stdout), \
                patch('lcu.runtime.os.execve') as execute:
            with self.assertRaisesRegex(ValueError, 'initial JSON-RPC server/discover request'):
                main(self.root, ['--mcp-discovery-compat'])
        execute.assert_not_called()
        self.assertEqual(destination.getvalue(), b'')

    def test_retargeted_app_link_is_rejected_before_launch(self):
        descriptor = self.root / 'installation.json'
        data = json.loads(descriptor.read_text())
        data['app'] = 'another-generation'
        descriptor.write_text(json.dumps(data))
        with patch('lcu.runtime.os.execve') as execute:
            with self.assertRaisesRegex(ValueError, 'descriptor does not match'):
                main(self.root, [])
        execute.assert_not_called()

    def test_selected_linux_app_is_used_in_place_and_reports_observed_runtime(self):
        manifest = self.app / 'resources/cua_node/manifest.json'
        data = json.loads(manifest.read_text())
        data['runtime_archive_version'] = 'upgraded-runtime'
        manifest.write_text(json.dumps(data))
        resolved = paths(self.root)
        self.assertEqual(resolved[0].resolve(), self.app)
        self.assertEqual(resolved[3], {'version': '26.924.22138', 'runtime': 'upgraded-runtime'})

    def test_selected_linux_app_from_another_architecture_is_rejected(self):
        manifest = self.app / 'resources/cua_node/manifest.json'
        data = json.loads(manifest.read_text())
        data['arch'] = 'x64'
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'unsupported platform, architecture.*Rerun'):
            environment(self.root)

    def test_removed_embedded_browser_flag_has_migration_error(self):
        with self.assertRaisesRegex(ValueError, 'lcu browser install'):
            main(self.root, ['--with-browser-host'])

    def test_default_computer_runtime_does_not_require_an_electron_host(self):
        with patch.dict(os.environ, {}, clear=True), patch('lcu.runtime.os.execve') as execute:
            main(self.root, [])
        self.assertEqual(execute.call_args.args[2]['CUA_REPL_ENABLED_SURFACES'], 'computer')

    def test_bare_server_in_interactive_terminal_reports_usage_and_exits(self):
        tty = SimpleNamespace(isatty=lambda: True)
        stderr = io.StringIO()
        with patch('lcu.runtime.sys.stdin', tty), patch('lcu.runtime.sys.stdout', tty), \
             patch('lcu.runtime.sys.stderr', stderr), patch('lcu.runtime.os.execve') as execute:
            with self.assertRaises(SystemExit) as exit_status:
                main(self.root, [])
        self.assertEqual(exit_status.exception.code, 2)
        execute.assert_not_called()
        self.assertIn('stdio MCP server', stderr.getvalue())
        self.assertIn('Usage: lcu', stderr.getvalue())

    def test_prune_dispatches_to_maintenance_without_resolving_app(self):
        import types
        module = types.ModuleType('lcu.maintenance')
        calls = []
        module.main = lambda root, argv: calls.append((root, argv))
        with patch.dict(sys.modules, {'lcu.maintenance': module}), \
             patch('lcu.runtime.paths') as resolve:
            main(self.root, ['prune', '--keep', '3', '--yes'])
        self.assertEqual(calls, [(self.root, ['--keep', '3', '--yes'])])
        resolve.assert_not_called()

    def test_doctor_help_prints_without_resolving_missing_app(self):
        (self.root / 'installation.json').unlink()
        output = io.StringIO()
        with patch('sys.stdout', output), patch('lcu.runtime.paths') as resolve:
            with self.assertRaises(SystemExit) as exit_status:
                main(self.root, ['doctor', '--help'])
        self.assertEqual(exit_status.exception.code, 0)
        resolve.assert_not_called()
        self.assertIn('--require-ready', output.getvalue())

    def test_version_reports_invalid_selected_app_and_exits_nonzero(self):
        descriptor = self.root / 'installation.json'
        data = json.loads(descriptor.read_text())
        data['app'] = 'mismatched-generation'
        descriptor.write_text(json.dumps(data))
        output = io.StringIO()
        with patch('sys.stdout', output):
            with self.assertRaises(SystemExit) as exit_status:
                main(self.root, ['--version'])
        self.assertEqual(exit_status.exception.code, 1)
        self.assertIn('app invalid:', output.getvalue())

    def test_browser_setup_refuses_foreign_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plugin = root / 'host/plugins/chrome/scripts'
            plugin.mkdir(parents=True)
            (plugin / 'installManifest.mjs').write_text('upstream fixture')
            foreign = root / 'foreign'
            foreign.mkdir()
            (foreign / 'keep').write_text('existing data')
            with self.assertRaisesRegex(ValueError, 'another installation'):
                install(root, foreign)
            self.assertEqual((foreign / 'keep').read_text(), 'existing data')


if __name__ == '__main__':
    unittest.main()
