// Port of tests/test_runtime.py (Linux layout), the runtime parts of tests/test_macos_runtime.py and
// tests/test_windows_runtime.py, plus tests for what the Node port adds (fd-level discovery compat,
// supervised-launch exit statuses). Every Python case is kept; see .port/notes/runtime.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chdir, cwd } from 'node:process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { asUri } from '../../lcu/compat/pathlib.mjs';
import { getpwuid } from '../../lcu/compat/accounts.mjs';
import { PySystemExit } from '../../lcu/compat/argparse.mjs';
import * as runtime from '../../lcu/runtime.mjs';
import {
  _configure_macos_lifecycle, _leave_unusable_working_directory, environment, internals, main, paths,
  reply_to_server_discover,
} from '../../lcu/runtime.mjs';
import { DISPOSITION_SCRIPT, applicationFixture, BytesIO, captureIo, rejectsWith, tempDir, withEnv } from './runtime_support.mjs';
import { skipOnWindows } from './windows_skip.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const pristine = { ...internals };

const write = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const json = (value) => JSON.stringify(value);

describe('UpstreamRuntimeTests', { skip: skipOnWindows('Linux app layout under usr/lib/chatgpt, the sandbox shim and X11 translation; the Windows runtime has its own describe below') }, () => {
  let temporary;
  let root;
  let app;
  let executed;

  beforeEach(() => {
    temporary = tempDir();
    const base = temporary.path;
    root = join(base, 'releases/release');
    mkdirSync(root, { recursive: true });
    app = realpathSync(applicationFixture(join(base, 'usr/lib/chatgpt'), { runtime_version: 'fixture-runtime-new' }));
    symlinkSync(app, join(root, 'app'), 'dir');
    write(join(root, 'runtime.lock.json'), json({
      runtime: 'fixture-runtime', version: '26.915.31945', architectures: { arm64: { sha256: 'fixture-digest' } } }));
    write(join(root, 'installation.json'), json({
      app, architecture: 'arm64', package_version: '26.924.22138', runtime: 'fixture-runtime-new' }));
    executed = [];
    internals.execve = (...args) => { executed.push(args); };
    internals.isatty = () => false;
  });

  afterEach(() => {
    Object.assign(internals, pristine);
    temporary.cleanup();
  });

  const env_of = (call) => call[2];

  it('test_default_enables_original_computer_surface', () => {
    const env = withEnv({}, () => environment(root));
    assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'computer');
    assert.equal(env.CUA_REPL_BROWSER_ENV, 'codex-app');
    assert.equal(env.CODEX_CLI_PATH, join(root, 'app/resources/codex'));
    assert.equal(env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome');
    assert.equal(env.NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS, '1000');
    assert.equal(env.BROWSER_USE_TINYSKY_ENABLED, '1');
    assert.equal(env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR, 'prod');
    assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, '26.924.22138');
    assert.equal(env.BROWSER_USE_DISABLE_AMBIENT_NETWORK, '1');
    assert.ok(!('SKY_ENABLE_AUDIO' in env));
    assert.ok(!('NODE_REPL_ENABLE_AUDIO' in env));
  });

  it('test_audio_opt_in_sets_both_original_runtime_flags', () => {
    const env = withEnv({ SKY_ENABLE_AUDIO: '0', NODE_REPL_ENABLE_AUDIO: '0' }, () => environment(root, null, { audio: true }));
    assert.equal(env.SKY_ENABLE_AUDIO, '1');
    assert.equal(env.NODE_REPL_ENABLE_AUDIO, '1');
  });

  it('test_audio_off_preserves_explicit_caller_environment_policy', () => {
    const env = withEnv({ SKY_ENABLE_AUDIO: '1', NODE_REPL_ENABLE_AUDIO: '1' }, () => environment(root));
    assert.equal(env.SKY_ENABLE_AUDIO, '1');
    assert.equal(env.NODE_REPL_ENABLE_AUDIO, '1');
  });

  it('test_caller_configuration_and_policies_survive', () => {
    const settings = {
      CUA_REPL_BROWSER_ENV: 'orbit', CUA_REPL_ENABLED_SURFACES: 'browser',
      OAI_SKY_CONFIG_PATH: '/desktop/options.json', OAI_SKY_LINUX_BIN: '/engine/sky',
      NODE_REPL_JS_BANNER: 'configured startup', NODE_REPL_TRUSTED_SERVICES: '{"custom":"service"}',
      NODE_REPL_REQUEST_META: '{"test":"context"}', NODE_REPL_FORCE_STRICT_AUTO_REVIEW: '1',
      NODE_REPL_ENFORCE_MODEL_CHECK: '1', CODEX_CLI_PATH: '/host/codex',
      BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,cdp,iab', BROWSER_USE_CONFIG_PATH: '/browser.json',
      NODE_REPL_ENABLE_NETWORK_ISOLATION: '1', NODE_REPL_DISABLE_ANALYTICS: '0',
      BROWSER_USE_TINYSKY_ENABLED: '0', NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '2300',
      BROWSER_USE_DISABLE_AMBIENT_NETWORK: '0',
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'alpha', BROWSER_USE_CODEX_APP_VERSION: 'fixture',
    };
    const env = withEnv(settings, () => environment(root));
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'NODE_REPL_REQUEST_META') {
        assert.deepEqual(JSON.parse(env[key]), JSON.parse(value));
        continue;
      }
      assert.equal(env[key], value, key);
    }
  });

  it('test_generic_connection_identity_has_no_invented_policy_or_model', () => {
    const [first, second] = withEnv({}, () => [environment(root), environment(root)]);
    const metadata = JSON.parse(first.NODE_REPL_REQUEST_META);
    assert.deepEqual(Object.keys(metadata), ['x-codex-turn-metadata']);
    assert.deepEqual(Object.keys(metadata['x-codex-turn-metadata']).sort(), ['session_id', 'turn_id']);
    assert.notEqual(first.NODE_REPL_REQUEST_META, second.NODE_REPL_REQUEST_META);
    // Python's json.dumps spacing is kept.
    assert.match(first.NODE_REPL_REQUEST_META, /^\{"x-codex-turn-metadata": \{"session_id": "lcu-[0-9a-f-]{36}", "turn_id": "lcu-[0-9a-f-]{36}-connection"\}\}$/);
  });

  it('test_an_unusable_launch_directory_is_left_for_the_filesystem_root', () => {
    const blocked = join(temporary.path, 'blocked');
    mkdirSync(blocked);
    const previous = cwd();
    try {
      chdir(blocked);
      internals.access = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
      _leave_unusable_working_directory();
      assert.equal(cwd(), realpathSync('/'));
      chdir(blocked);
      internals.access = pristine.access;
      _leave_unusable_working_directory();
      assert.equal(cwd(), realpathSync(blocked));
    } finally {
      chdir(previous);
    }
  });

  const installSandboxShim = () => {
    mkdirSync(join(root, 'bin'), { recursive: true });
    const shim = join(root, 'bin/lcu-codex-sandbox');
    writeFileSync(shim, '#!/bin/sh\n');
    chmodSync(shim, 0o755);
    return shim;
  };

  it('test_linux_default_points_node_repl_at_the_sandbox_shim', () => {
    const shim = installSandboxShim();
    const env = withEnv({}, () => environment(root));
    const config = JSON.parse(env.LCU_SANDBOX_SHIM);
    assert.equal(env.CODEX_CLI_PATH, shim);
    assert.notEqual(config.codex, shim);
    assert.equal(config.runtime, env.NODE_REPL_NODE_PATH.replace(/\/bin\/node$/, ''));
    assert.equal(config.wrapper, null);
    assert.ok(env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.split(',').includes('LCU_SANDBOX_SHIM'));
    // No host sandbox state is invented: the kernel stays under the sandbox node_repl chooses.
    assert.deepEqual(Object.keys(JSON.parse(env.NODE_REPL_REQUEST_META)), ['x-codex-turn-metadata']);
  });

  it('test_shim_configuration_keeps_a_caller_allowlist_and_codex_path', () => {
    const shim = installSandboxShim();
    const env = withEnv({ CODEX_CLI_PATH: '/host/codex', NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: 'FIRST,SECOND' },
      () => environment(root));
    assert.equal(JSON.parse(env.LCU_SANDBOX_SHIM).codex, '/host/codex');
    assert.equal(env.CODEX_CLI_PATH, shim);
    assert.equal(env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST, 'FIRST,SECOND,LCU_SANDBOX_SHIM');
  });

  it('test_the_test_only_fault_hook_reaches_the_kernels_launcher_only_when_set', () => {
    installSandboxShim();
    withEnv({}, () => assert.ok(!environment(root).NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.includes('FAULT')));
    const allowed = withEnv({ LCU_TEST_SANDBOX_SHIM_FAULT: 'unrecognized-kernel' },
      () => environment(root).NODE_REPL_UNTRUSTED_ENV_ALLOWLIST.split(','));
    assert.deepEqual(allowed, ['LCU_SANDBOX_SHIM', 'LCU_TEST_SANDBOX_SHIM_FAULT']);
  });

  const installLinuxInputWrapper = (...entries) => {
    mkdirSync(join(root, 'lcu'), { recursive: true });
    writeFileSync(join(root, 'lcu/linux_sky_service.mjs'), 'export async function handleRpc() {}\n');
    writeFileSync(join(root, 'tested-versions.json'), json({ format: 1, entries }));
  };
  const pairEntry = (changes = {}) => ({
    platform: 'linux', architecture: 'arm64', app_version: '26.924.22138',
    runtime: 'fixture-runtime-new', lcu_version: '0.8.3', ...changes });

  it('test_shim_is_told_about_lcus_own_sky_wrapper', () => {
    installSandboxShim();
    installLinuxInputWrapper();
    const env = withEnv({}, () => environment(root));
    const wrapper = join(root, 'lcu/linux_sky_service.mjs');
    assert.equal(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).sky, wrapper);
    assert.equal(JSON.parse(env.LCU_SANDBOX_SHIM).wrapper, wrapper);
  });

  it('test_missing_shim_keeps_the_original_behavior_which_fails_closed', () => {
    const env = withEnv({}, () => environment(root));
    assert.ok(!('LCU_SANDBOX_SHIM' in env));
    assert.ok(!(env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST ?? '').includes('LCU_SANDBOX_SHIM'));
    assert.notEqual(env.CODEX_CLI_PATH.split('/').at(-1), 'lcu-codex-sandbox');
    assert.deepEqual(Object.keys(JSON.parse(env.NODE_REPL_REQUEST_META)), ['x-codex-turn-metadata']);
  });

  it('test_off_gives_the_original_node_repl_a_disabled_sandbox_state', () => {
    const shim = installSandboxShim();
    const env = withEnv({ LCU_NODE_REPL_SANDBOX: 'off' }, () => environment(root));
    const state = JSON.parse(env.NODE_REPL_REQUEST_META)['codex/sandbox-state-meta'];
    assert.deepEqual(state.permissionProfile, { type: 'disabled' });
    assert.equal(state.sandboxCwd, asUri(cwd()));
    assert.ok(!('LCU_SANDBOX_SHIM' in env));
    assert.notEqual(env.CODEX_CLI_PATH, shim);
  });

  it('test_off_adds_only_the_missing_state_to_host_metadata', () => {
    const supplied = { 'x-codex-turn-metadata': { session_id: 'host-session', turn_id: 'host-turn' } };
    const actual = JSON.parse(withEnv({ LCU_NODE_REPL_SANDBOX: 'off', NODE_REPL_REQUEST_META: json(supplied) },
      () => environment(root)).NODE_REPL_REQUEST_META);
    assert.deepEqual(actual['codex/sandbox-state-meta'].permissionProfile, { type: 'disabled' });
    delete actual['codex/sandbox-state-meta'];
    assert.deepEqual(actual, supplied);
  });

  it('test_host_supplied_sandbox_state_is_never_replaced', () => {
    installSandboxShim();
    const strict = { permissionProfile: { type: 'managed', file_system: { type: 'unrestricted' }, network: 'restricted' },
      sandboxCwd: 'file:///work' };
    const supplied = json({ 'codex/sandbox-state-meta': strict, 'x-codex-turn-metadata': { session_id: 's' } });
    for (const mode of ['', 'off', 'host']) {
      const env = withEnv({ NODE_REPL_REQUEST_META: supplied, LCU_NODE_REPL_SANDBOX: mode }, () => environment(root));
      assert.equal(env.NODE_REPL_REQUEST_META, supplied, `mode=${mode}`);
    }
  });

  it('test_unparseable_or_non_object_host_metadata_is_left_alone', () => {
    for (const mode of ['', 'off']) {
      for (const supplied of ['not json', '[1]', '', '"text"']) {
        const env = withEnv({ NODE_REPL_REQUEST_META: supplied, LCU_NODE_REPL_SANDBOX: mode }, () => environment(root));
        assert.equal(env.NODE_REPL_REQUEST_META, supplied, `mode=${mode} supplied=${supplied}`);
      }
    }
  });

  it('test_host_mode_leaves_the_original_behavior_untouched', () => {
    const shim = installSandboxShim();
    const env = withEnv({ LCU_NODE_REPL_SANDBOX: 'host' }, () => environment(root));
    assert.deepEqual(Object.keys(JSON.parse(env.NODE_REPL_REQUEST_META)), ['x-codex-turn-metadata']);
    assert.ok(!('LCU_SANDBOX_SHIM' in env));
    assert.notEqual(env.CODEX_CLI_PATH, shim);
  });

  it('test_other_platforms_keep_their_original_sandbox_state', () => {
    const metadata = JSON.parse(withEnv({}, () => environment(root, null, { platform: 'darwin' })).NODE_REPL_REQUEST_META);
    assert.deepEqual(Object.keys(metadata), ['x-codex-turn-metadata']);
  });

  it('test_linux_input_translation_wraps_only_the_sky_service', () => {
    installLinuxInputWrapper();
    const env = withEnv({}, () => environment(root));
    const wrapper = join(root, 'lcu/linux_sky_service.mjs');
    assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), { sky: wrapper });
    assert.equal(env.LCU_LINUX_SKY_SERVICE_PATH,
      join(root, 'app/resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'));
    assert.equal(env.LCU_LINUX_INPUT_TOOLKITS, 'gtk4,qt-scroll');
    assert.ok(env.NODE_REPL_TRUSTED_CODE_PATHS.split(delimiter).includes(join(root, 'lcu')));
  });

  it('test_linux_input_translation_keeps_the_browser_service_when_chrome_is_enabled', () => {
    installLinuxInputWrapper();
    const services = JSON.parse(withEnv({}, () => environment(root, null, { chrome: true })).NODE_REPL_TRUSTED_SERVICES);
    assert.equal(services.browser, '@oai/browser-desktop/service');
    assert.equal(services.sky, join(root, 'lcu/linux_sky_service.mjs'));
  });

  it('test_linux_input_translation_can_be_turned_off', () => {
    installLinuxInputWrapper();
    for (const value of ['off', 'OFF', ' off ', '0', 'false', 'no']) {
      const env = withEnv({ LCU_LINUX_INPUT_TRANSLATION: value }, () => environment(root));
      assert.ok(!('NODE_REPL_TRUSTED_SERVICES' in env), value);
      assert.ok(!('LCU_LINUX_SKY_SERVICE_PATH' in env), value);
    }
    assert.ok('NODE_REPL_TRUSTED_SERVICES' in withEnv({ LCU_LINUX_INPUT_TRANSLATION: 'on' }, () => environment(root)));
  });

  it('test_linux_input_translation_is_linux_only', () => {
    installLinuxInputWrapper();
    const env = withEnv({}, () => environment(root, null, { platform: 'darwin' }));
    assert.ok(!('LCU_LINUX_SKY_SERVICE_PATH' in env));
    assert.ok(!('NODE_REPL_TRUSTED_SERVICES' in env));
  });

  it('test_a_caller_supplied_sky_service_takes_precedence', () => {
    installLinuxInputWrapper();
    const supplied = json({ sky: '/custom/sky.mjs' });
    const env = withEnv({ NODE_REPL_TRUSTED_SERVICES: supplied }, () => environment(root));
    assert.equal(env.NODE_REPL_TRUSTED_SERVICES, supplied);
    assert.ok(!('LCU_LINUX_SKY_SERVICE_PATH' in env));
  });

  it('test_caller_supplied_service_maps_are_preserved_verbatim', () => {
    installLinuxInputWrapper();
    for (const supplied of ['{}', '{"custom": "/custom/service.mjs"}', '{"browser": "@oai/browser-desktop/service"}',
      '{"sky": "/custom/sky.mjs", "other": "x"}', '[]', 'not json']) {
      const env = withEnv({ NODE_REPL_TRUSTED_SERVICES: supplied }, () => environment(root));
      assert.equal(env.NODE_REPL_TRUSTED_SERVICES, supplied, supplied);
      assert.ok(!('LCU_LINUX_SKY_SERVICE_PATH' in env), supplied);
    }
  });

  it('test_an_explicit_original_sky_entry_is_replaced_and_other_entries_survive', () => {
    installLinuxInputWrapper();
    const supplied = json({ sky: '@oai/sky/service', other: '/custom/service.mjs' });
    const env = withEnv({ NODE_REPL_TRUSTED_SERVICES: supplied }, () => environment(root));
    assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES),
      { sky: join(root, 'lcu/linux_sky_service.mjs'), other: '/custom/service.mjs' });
    assert.ok('LCU_LINUX_SKY_SERVICE_PATH' in env);
  });

  it('test_a_tested_pair_that_handles_a_toolkit_natively_is_not_translated_for_it', () => {
    installLinuxInputWrapper(pairEntry({ native_input: ['gtk4'] }));
    assert.equal(withEnv({}, () => environment(root)).LCU_LINUX_INPUT_TOOLKITS, 'qt-scroll');
    installLinuxInputWrapper(pairEntry({ native_input: ['gtk4', 'qt-scroll'] }));
    const env = withEnv({}, () => environment(root));
    assert.ok(!('NODE_REPL_TRUSTED_SERVICES' in env));
    assert.ok(!('LCU_LINUX_INPUT_TOOLKITS' in env));
  });

  it('test_another_app_version_is_translated_even_when_a_tested_pair_is_native', () => {
    installLinuxInputWrapper(pairEntry({ app_version: '26.999.1', native_input: ['gtk4', 'qt-scroll'] }));
    assert.equal(withEnv({}, () => environment(root)).LCU_LINUX_INPUT_TOOLKITS, 'gtk4,qt-scroll');
  });

  it('test_an_unreadable_tested_record_keeps_the_translation_on', () => {
    installLinuxInputWrapper();
    writeFileSync(join(root, 'tested-versions.json'), '{broken');
    assert.equal(withEnv({}, () => environment(root)).LCU_LINUX_INPUT_TOOLKITS, 'gtk4,qt-scroll');
  });

  it('test_additional_module_and_trust_roots_survive', () => {
    internals.home = () => '/fixture';
    const env = withEnv({ NODE_REPL_NODE_MODULE_DIRS: '/extra/modules', NODE_REPL_TRUSTED_CODE_PATHS: '/trusted',
      PATH: '/usr/bin' }, () => environment(root));
    const modules = join(root, 'app/resources/cua_node/lib/node_modules');
    const plugins = join(root, 'app/resources/plugins');
    assert.equal(env.NODE_REPL_NODE_MODULE_DIRS, `${modules}:/extra/modules`);
    assert.equal(env.NODE_REPL_TRUSTED_CODE_PATHS, `/fixture/.codex:${modules}:${plugins}:/trusted`);
  });

  it('test_default_codex_home_is_supplied_and_trusted', () => {
    internals.home = () => '/fixture';
    const env = withEnv({}, () => environment(root));
    assert.equal(env.CODEX_HOME, '/fixture/.codex');
    assert.equal(env.NODE_REPL_TRUSTED_CODE_PATHS.split(delimiter)[0], '/fixture/.codex');
  });

  it('test_default_home_matches_node_posix_join', () => {
    for (const [home, expected] of [['', '.codex'], ['relative/home', 'relative/home/.codex'],
      ['relative/../home', 'home/.codex'], ['//fixture/home', '/fixture/home/.codex']]) {
      const env = withEnv({ HOME: home }, () => environment(root));
      assert.equal(env.CODEX_HOME, expected, home);
      assert.equal(env.NODE_REPL_TRUSTED_CODE_PATHS.split(delimiter)[0], expected, home);
    }
  });

  it('test_explicit_codex_home_is_not_normalized', () => {
    for (const selected of ['/fixture/custom', 'relative/../home', '  /fixture/spaces  ', '']) {
      const env = withEnv({ CODEX_HOME: selected }, () => environment(root));
      assert.equal(env.CODEX_HOME, selected);
      const modules = join(root, 'app/resources/cua_node/lib/node_modules');
      const plugins = join(root, 'app/resources/plugins');
      assert.equal(env.NODE_REPL_TRUSTED_CODE_PATHS, (selected ? selected + ':' : '') + `${modules}:${plugins}`, selected);
    }
  });

  const launcherPath = () => join(root, 'app/resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
  const nodePath = () => join(root, 'app/resources/cua_node/bin/node');

  it('test_launches_original_entrypoint', async () => {
    await withEnv({ CUA_REPL_ENABLED_SURFACES: 'computer' }, () => main(root, []), { clear: false });
    assert.deepEqual(executed[0][1], [nodePath(), launcherPath()]);
  });

  it('test_chrome_flag_selects_original_combined_runtime', async () => {
    await withEnv({}, () => main(root, ['--chrome']));
    assert.equal(env_of(executed[0]).CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  });

  it('test_audio_flag_reaches_original_mcp_child_as_paired_flags', async () => {
    await withEnv({ SKY_ENABLE_AUDIO: '0' }, () => main(root, ['--audio']));
    assert.equal(env_of(executed[0]).SKY_ENABLE_AUDIO, '1');
    assert.equal(env_of(executed[0]).NODE_REPL_ENABLE_AUDIO, '1');
  });

  it('test_audio_flag_keeps_registration_probes_and_duplicates_fail', async () => {
    const out = captureIo();
    try {
      await main(root, ['--chrome', '--audio', '--version']);
    } finally {
      out.restore();
    }
    assert.match(out.out, /ChatGPT linux 26\.924\.22138/);
    assert.equal(executed.length, 0);
    await rejectsWith(assert, () => main(root, ['--audio', '--audio']), 'ValueError', /Usage: lcu/);
    assert.equal(executed.length, 0);
  });

  it('test_duplicate_runtime_flags_do_not_bypass_help_or_version_validation', async () => {
    for (const args of [['--audio', '--audio', '--help'], ['--chrome', '--chrome', '--version']]) {
      await rejectsWith(assert, () => main(root, args), 'ValueError', /Usage: lcu/);
      assert.equal(executed.length, 0);
    }
  });

  it('test_chrome_registration_keeps_version_probe', async () => {
    const out = captureIo();
    try {
      await main(root, ['--chrome', '--version']);
    } finally {
      out.restore();
    }
    assert.match(out.out, /ChatGPT linux 26\.924\.22138/);
    assert.match(out.out, /CUA fixture-runtime-new/);
    assert.equal(executed.length, 0);
  });

  it('test_explicit_surface_override_takes_precedence_over_chrome_flag', async () => {
    await withEnv({ CUA_REPL_ENABLED_SURFACES: 'computer' }, () => main(root, ['--chrome']));
    assert.equal(env_of(executed[0]).CUA_REPL_ENABLED_SURFACES, 'computer');
  });

  it('test_mcp_discovery_compat_probes_then_execs_original_server', async () => {
    const following = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    const source = new BytesIO(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":0,"method":"server/discover"}\n'), following]));
    const destination = new BytesIO();
    internals.stdin_source = () => source;
    internals.stdout_sink = () => destination;
    await main(root, ['--mcp-discovery-compat']);
    assert.deepEqual(JSON.parse(destination.getvalue().toString()), {
      jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'Method not found' } });
    assert.deepEqual(source.read(), following);
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0].slice(0, 2), [nodePath(), [nodePath(), launcherPath()]]);
  });

  it('test_chrome_command_preserves_discovery_compatibility', async () => {
    const source = new BytesIO(Buffer.from('{"jsonrpc":"2.0","id":0,"method":"server/discover"}\n'));
    const destination = new BytesIO();
    internals.stdin_source = () => source;
    internals.stdout_sink = () => destination;
    await withEnv({}, () => main(root, ['--chrome', '--mcp-discovery-compat']));
    assert.equal(JSON.parse(destination.getvalue().toString()).error.code, -32601);
    assert.equal(env_of(executed[0]).CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  });

  it('test_mcp_discovery_compat_rejects_other_first_request_without_launching', async () => {
    const source = new BytesIO(Buffer.from('{"jsonrpc":"2.0","id":0,"method":"tools/list"}\n'));
    const destination = new BytesIO();
    internals.stdin_source = () => source;
    internals.stdout_sink = () => destination;
    await rejectsWith(assert, () => main(root, ['--mcp-discovery-compat']), 'ValueError', /initial JSON-RPC server\/discover request/);
    assert.equal(executed.length, 0);
    assert.equal(destination.getvalue().length, 0);
  });

  it('test_retargeted_app_link_is_rejected_before_launch', async () => {
    const descriptor = join(root, 'installation.json');
    const data = JSON.parse(readFileSync(descriptor, 'utf8'));
    data.app = 'another-generation';
    writeFileSync(descriptor, json(data));
    await rejectsWith(assert, () => main(root, []), 'ValueError', /descriptor does not match/);
    assert.equal(executed.length, 0);
  });

  it('test_selected_linux_app_is_used_in_place_and_reports_observed_runtime', () => {
    const manifest = join(app, 'resources/cua_node/manifest.json');
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    data.runtime_archive_version = 'upgraded-runtime';
    writeFileSync(manifest, json(data));
    const resolved = paths(root);
    assert.equal(realpathSync(resolved[0]), app);
    assert.deepEqual(resolved[3], { version: '26.924.22138', runtime: 'upgraded-runtime' });
  });

  it('test_selected_linux_app_from_another_architecture_is_rejected', async () => {
    const manifest = join(app, 'resources/cua_node/manifest.json');
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    data.arch = 'x64';
    writeFileSync(manifest, json(data));
    await rejectsWith(assert, () => environment(root), 'ValueError', /unsupported platform, architecture.*Rerun/);
  });

  it('test_removed_embedded_browser_flag_has_migration_error', async () => {
    await rejectsWith(assert, () => main(root, ['--with-browser-host']), 'ValueError', /lcu browser install/);
  });

  it('test_default_computer_runtime_does_not_require_an_electron_host', async () => {
    await withEnv({}, () => main(root, []));
    assert.equal(env_of(executed[0]).CUA_REPL_ENABLED_SURFACES, 'computer');
  });

  it('test_bare_server_in_interactive_terminal_reports_usage_and_exits', async () => {
    internals.isatty = () => true;
    const out = captureIo();
    let failure;
    try {
      await main(root, []);
    } catch (error) {
      failure = error;
    } finally {
      out.restore();
    }
    assert.ok(failure instanceof PySystemExit);
    assert.equal(failure.status, 2);
    assert.equal(executed.length, 0);
    assert.match(out.err, /stdio MCP server/);
    assert.match(out.err, /Usage: lcu/);
  });

  it('test_prune_dispatches_to_maintenance_without_resolving_app', async () => {
    const calls = [];
    internals.load = async (name) => ({ main: (...args) => { calls.push([name, ...args]); } });
    await main(root, ['prune', '--keep', '3', '--yes']);
    assert.deepEqual(calls, [['./maintenance.mjs', root, ['--keep', '3', '--yes']]]);
  });

  it('origins dispatches to lcu/origins.mjs without resolving the app (LCU 0.9.6 #21)', async () => {
    rmSync(join(root, 'installation.json'));
    const calls = [];
    internals.load = async (name) => ({ main: (...args) => { calls.push([name, ...args]); } });
    await main(root, ['origins', 'forget', 'https://example.com', '--all-sessions']);
    assert.deepEqual(calls, [['./origins.mjs', ['forget', 'https://example.com', '--all-sessions']]]);
  });

  it('USAGE lists the origins commands (LCU 0.9.6)', () => {
    const lines = runtime.USAGE.split('\n');
    assert.equal(lines[5], '       lcu origins [list [--session ID] [--json]]');
    assert.equal(lines[6], '       lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]');
    assert.equal(lines[7], '       lcu prune [--keep N] [--yes]');
  });

  it('default_codex_home is the CODEX_HOME environment() supplies', () => {
    internals.home = () => '/fixture';
    assert.equal(runtime.default_codex_home({}, false), '/fixture/.codex');
    assert.equal(runtime.default_codex_home({ HOME: '//x/y' }, false), '/x/y/.codex');
    assert.equal(runtime.default_codex_home({ HOME: '' }, false), '.codex');
    assert.equal(runtime.default_codex_home({ USERPROFILE: 'C:\\u' }, true), 'C:\\u\\.codex');
    assert.equal(runtime.default_codex_home({ USERPROFILE: '', HOME: '' }, true), '\\fixture\\.codex');
  });

  it('test_doctor_help_prints_without_resolving_missing_app', async () => {
    rmSync(join(root, 'installation.json'));
    const calls = [];
    internals.load = async (name) => ({ main: (...args) => {
      calls.push([name, ...args]);
      throw new PySystemExit(0);
    } });
    await assert.rejects(main(root, ['doctor', '--help']), (error) => error instanceof PySystemExit && error.status === 0);
    assert.deepEqual(calls, [['./doctor.mjs', root, ['--help']]]);
  });

  it('test_version_reports_invalid_selected_app_and_exits_nonzero', async () => {
    const descriptor = join(root, 'installation.json');
    const data = JSON.parse(readFileSync(descriptor, 'utf8'));
    data.app = 'mismatched-generation';
    writeFileSync(descriptor, json(data));
    const out = captureIo();
    let failure;
    try {
      await main(root, ['--version']);
    } catch (error) {
      failure = error;
    } finally {
      out.restore();
    }
    assert.ok(failure instanceof PySystemExit);
    assert.equal(failure.status, 1);
    assert.match(out.out, /app invalid:/);
  });

  // test_browser_setup_refuses_foreign_directory belongs to lcu/browser (tests/node/browser.test.mjs of that port).

  // ---- cases from the Windows/macOS/dispatch tests that exercise runtime.main without a lifecycle host ----

  it('setup and browser dispatch (test_windows_runtime.test_setup_and_browser_dispatch)', async () => {
    const calls = [];
    internals.load = async (name) => ({ main: (...args) => { calls.push([name, ...args]); } });
    await main(root, ['setup', '--list-agents']);
    await main(root, ['browser', 'install']);
    assert.deepEqual(calls, [
      ['./setup.mjs', ['--list-agents', '--prefix', join(root, '../..').replace(/\/$/, '')]],
      ['./browser.mjs', root, ['install']],
    ].map((call) => call.map((part) => (typeof part === 'string' && part.includes('..') ? realpathSync(part) : part))));
  });

  it('source checkout dispatch without installation descriptor (test_windows_runtime)', async () => {
    rmSync(join(root, 'installation.json'));
    const calls = [];
    internals.load = async (name) => ({ main: (...args) => { calls.push([name, ...args]); } });
    await main(root, ['setup', '--list-agents']);
    await main(root, ['browser', '--help']);
    assert.deepEqual(calls[0][1], ['--list-agents', '--prefix', join(temporary.path)]);
    assert.deepEqual(calls[1], ['./browser.mjs', root, ['--help']]);
  });

  it('--version without an installation descriptor says the app is not selected', async () => {
    rmSync(join(root, 'installation.json'));
    const out = captureIo();
    try {
      await main(root, ['--version']);
    } finally {
      out.restore();
    }
    assert.equal(out.out, 'lcu source-checkout (ChatGPT linux app not selected)\n');
  });

  it('--help and -h print USAGE plus the fixed sentence list, also after --chrome/--audio probes', async () => {
    const expected = runtime.USAGE + runtime.HELP_SUFFIX + '\n';
    for (const args of [['--help'], ['-h'], ['--chrome', '--help'], ['--audio', '--chrome', '--help'], ['--help', 'EXTRA']]) {
      const out = captureIo();
      try {
        await main(root, args);
      } finally {
        out.restore();
      }
      assert.equal(out.out, expected, args.join(' '));
    }
    // `--chrome --help EXTRA` is a usage error: the probe only rewrites an exact [--help].
    await rejectsWith(assert, () => main(root, ['--chrome', '--help', 'EXTRA']), 'ValueError', /Usage: lcu/);
  });
});

describe('MacRuntimeTests', { skip: skipOnWindows('macOS app bundle, lifecycle host and Unix socket; never reached on a Windows host') }, () => {
  let temporary;
  let base;
  let root;
  let app;
  let resources;
  let runtimeDir;
  let selected;

  beforeEach(() => {
    temporary = tempDir();
    base = temporary.path;
    root = join(base, 'release');
    mkdirSync(root);
    app = join(base, 'ChatGPT.app');
    resources = join(app, 'Contents/Resources');
    runtimeDir = join(resources, 'cua_node');
    mkdirSync(runtimeDir, { recursive: true });
    const codex = join(resources, 'codex-cli/bin/codex');
    const host = join(resources, 'codex-cli/bin/codex-code-mode-host');
    write(codex, 'original codex');
    write(host, 'original host');
    symlinkSync(app, join(root, 'app'), 'dir');
    write(join(root, 'runtime.lock.json'), json({ platforms: { darwin: {
      version: 'old-lock-version', runtime: 'old-lock-runtime', architectures: { arm64: { components: { fixture: 'ignored' } } } } } }));
    write(join(root, 'installation.json'), json({
      platform: 'darwin', app, architecture: 'arm64', package_version: 'old-installed-version',
      runtime: 'old-installed-runtime' }));
    selected = { app, resources, runtime: runtimeDir, arch: 'arm64', version: '26.924.22138',
      runtime_version: '0.0.24/20260924074400-f52ea85e2a98', codex_cli: codex, code_mode_host: host };
    internals.isatty = () => false;
  });
  afterEach(() => {
    Object.assign(internals, pristine);
    temporary.cleanup();
  });

  const resolver = () => {
    const calls = [];
    internals.resolve_installed_mac_app = (...args) => { calls.push(args); return selected; };
    return calls;
  };

  it('test_launches_original_entrypoint_with_verified_local_app', async () => {
    const calls = resolver();
    const executed = [];
    internals.execve = (...args) => { executed.push(args); };
    // _configure_macos_lifecycle returns None in the Python test: no computer surface is enabled there.
    internals.load = async () => { throw new Error('no host must start'); };
    await withEnv({ HOME: '/fixture', CUA_REPL_ENABLED_SURFACES: 'browser' }, () => main(root, []));
    assert.deepEqual(calls, [[app, { arch: 'arm64' }]]);
    const node = join(runtimeDir, 'bin/node');
    assert.deepEqual(executed[0].slice(0, 2), [node, [node, join(runtimeDir, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]]);
    const env = executed[0][2];
    assert.equal(env.CODEX_CLI_PATH, selected.codex_cli);
    assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'browser');
    assert.equal(env.SKY_CUA_SERVICE_PATH, join(runtimeDir, 'lib/node_modules/@oai/sky/Codex Computer Use.app'));
    assert.equal(env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome');
    assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, '26.924.22138');
    assert.ok(!('NODE_REPL_HOST_SERVICES_PIPE_PATH' in env));
  });

  it('test_macos_main_supervises_lifecycle_host_around_original_repl', async () => {
    resolver();
    const client = join(runtimeDir,
      'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
    write(client, 'fixture');
    chmodSync(client, 0o755);
    const host = {};
    const temporaryHost = {};
    const started = [];
    const stopped = [];
    const ran = [];
    internals.load = async (name) => {
      assert.equal(name, './macos_host.mjs');
      return {
        start_original_host: (options) => { started.push(options); return [host, temporaryHost, '/tmp/lcu.sock']; },
        stop_original_host: (...args) => { stopped.push(args); },
      };
    };
    internals.supervise = async (command, env) => { ran.push([command, env]); return 0; };
    internals.execve = () => assert.fail('execve must not run when the lifecycle host supervises');
    await assert.rejects(withEnv({ HOME: getpwuid(process.getuid()).pw_dir }, () => main(root, [])),
      (error) => error instanceof PySystemExit && error.status === 0);
    assert.equal(started.length, 1);
    assert.equal(started[0].client, client);
    // LCU's own host Node starts through entry.mjs with the startup quarantine (review port-runtime #2).
    assert.equal(started[0].entry, join(root, 'lcu/entry.mjs'));
    assert.deepEqual(stopped, [[host, temporaryHost]]);
    assert.deepEqual(ran[0][0], [join(runtimeDir, 'bin/node'), join(runtimeDir, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]);
    assert.equal(ran[0][1].LCU_MAC_LIFETIME_SOCKET, '/tmp/lcu.sock');
    // The host learns the default socket lock location before it starts, not afterwards.
    const host_env = started[0].env;
    assert.ok(host_env.LCU_MAC_SERVICE_LOCK.endsWith(
      '/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock.lock'));
    assert.equal(ran[0][1].LCU_MAC_SERVICE_LOCK, host_env.LCU_MAC_SERVICE_LOCK);
    assert.equal(JSON.parse(ran[0][1].NODE_REPL_TRUSTED_SERVICES).sky, join(root, 'lcu/macos_sky_service.mjs'));
  });

  /** Run main() on a macOS launcher whose lifecycle host is a recorder; returns the env the host was started with. */
  const startedHostEnv = async (values) => {
    resolver();
    const client = join(runtimeDir,
      'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
    write(client, 'fixture');
    chmodSync(client, 0o755);
    const started = [];
    internals.load = async () => ({
      start_original_host: (options) => { started.push(options); return [{}, {}, '/tmp/lcu.sock']; },
      stop_original_host: () => {},
    });
    internals.supervise = async () => 0;
    await assert.rejects(withEnv(values, () => main(root, [])), (error) => error instanceof PySystemExit);
    return started[0].env;
  };

  it('test_a_custom_socket_path_leaves_the_service_lock_unknown_to_the_host', async () => {
    // Set but empty too: what the original client makes of it is not the default socket.
    for (const custom of ['/tmp/custom.sock', '']) {
      const env = await startedHostEnv({ HOME: getpwuid(process.getuid()).pw_dir, SKY_CUA_SERVICE_NATIVE_PIPE_PATH: custom,
        LCU_MAC_SERVICE_LOCK: '/inherited/computeruse.sock.lock' });
      assert.ok(!('LCU_MAC_SERVICE_LOCK' in env), JSON.stringify(custom));
    }
  });

  it('test_a_home_that_is_not_the_accounts_leaves_the_service_lock_unknown_to_the_host', async () => {
    // The original client builds its socket path from $HOME, so it is then not talking to
    // the account-home socket whose stale holder recovery would stop.
    // An empty HOME too: Node's os.homedir() then returns '' and the socket path is relative.
    for (const home of ['/tmp/isolated-home', '']) {
      const env = await startedHostEnv({ HOME: home, LCU_MAC_SERVICE_LOCK: '/inherited.lock' });
      assert.ok(!('LCU_MAC_SERVICE_LOCK' in env), JSON.stringify(home));
    }
  });

  it('test_reports_current_metadata_after_descriptor_and_lock_become_stale', async () => {
    const calls = resolver();
    const actual = paths(root);
    assert.deepEqual(calls, [[app, { arch: 'arm64' }]]);
    assert.deepEqual(actual[3], { version: '26.924.22138', runtime: '0.0.24/20260924074400-f52ea85e2a98' });
    const env = withEnv({}, () => environment(root));
    assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, '26.924.22138');
    write(join(root, 'bundle.json'), json({ version: '0.3.0' }));
    const out = captureIo();
    try {
      await main(root, ['--version']);
    } finally {
      out.restore();
    }
    assert.match(out.out, /ChatGPT darwin 26\.924\.22138/);
    assert.match(out.out, /CUA 0\.0\.24\/20260924074400-f52ea85e2a98/);
  });

  it('test_rejects_descriptor_pointing_at_a_different_app', async () => {
    const calls = resolver();
    const descriptor = join(root, 'installation.json');
    const data = JSON.parse(readFileSync(descriptor, 'utf8'));
    data.app = join(root, 'other.app');
    writeFileSync(descriptor, json(data));
    await rejectsWith(assert, () => paths(root), 'ValueError', /does not match/);
    assert.equal(calls.length, 0);
  });

  it('test_source_checkout_version_does_not_advertise_old_lock_values', async () => {
    rmSync(join(root, 'installation.json'));
    const out = captureIo();
    try {
      await main(root, ['--version']);
    } finally {
      out.restore();
    }
    assert.match(out.out, /app not selected/);
    assert.ok(!out.out.includes('old-lock-version'));
  });

  it('test_keeps_caller_helper_and_policy_settings', () => {
    resolver();
    const env = withEnv({ SKY_CUA_SERVICE_PATH: '/chosen/helper.app', CUA_REPL_ENABLED_SURFACES: 'computer' }, () => environment(root));
    assert.equal(env.SKY_CUA_SERVICE_PATH, '/chosen/helper.app');
    assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'computer');
  });

  it('test_configures_original_sky_service_lifecycle_wrapper', () => {
    const wrapper = join(root, 'lcu/macos_sky_service.mjs');
    const result = withEnv({ HOME: '/fixture', NODE_REPL_TRUSTED_SERVICES: json({
      sky: '@oai/sky/service', browser: 'custom/browser/service', other: 'custom/other/service' }) }, () => {
      const env = environment(root, [app, resources, runtimeDir, { version: '26.924.22138', runtime: 'fixture' }]);
      return [env, _configure_macos_lifecycle(root, runtimeDir, env)];
    });
    const [env, client] = result;
    assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), {
      sky: wrapper, browser: 'custom/browser/service', other: 'custom/other/service' });
    assert.equal(env.LCU_MAC_SKY_SERVICE_PATH,
      join(runtimeDir, 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'));
    assert.equal(client, join(env.SKY_CUA_SERVICE_PATH,
      'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'));
  });

  it('test_rejects_custom_sky_trusted_service_when_cleanup_wrapper_is_required', async () => {
    const env = { CUA_REPL_ENABLED_SURFACES: 'computer', NODE_REPL_TRUSTED_SERVICES: json({ sky: 'custom/sky/service' }) };
    await rejectsWith(assert, () => _configure_macos_lifecycle(root, runtimeDir, env), 'ValueError', /custom Sky trusted-service/);
  });
});

describe('WindowsRuntimeTests (fixture layout; resolver supplied by the test)', () => {
  let temporary;
  let prefix;
  let root;
  let appDir;
  let resourcesDir;
  let runtimeDir;
  let launcher;
  let selected;
  const digest = 'a'.repeat(64);
  const inventory = { '.': { type: 'directory' } };

  beforeEach(() => {
    temporary = tempDir();
    prefix = join(temporary.path, 'prefix');
    root = join(prefix, 'releases/release');
    mkdirSync(root, { recursive: true });
    const generation = join(prefix, 'apps', digest);
    appDir = join(generation, 'app');
    resourcesDir = join(appDir, 'app/resources');
    runtimeDir = join(resourcesDir, 'cua_node');
    launcher = join(runtimeDir, 'bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
    write(launcher, 'original fixture');
    write(join(resourcesDir, 'codex.exe'), 'original Codex CLI');
    write(join(resourcesDir, 'codex-code-mode-host.exe'), 'original code-mode host');
    write(join(generation, 'inventory.json'), json(inventory));
    write(join(root, 'runtime.lock.json'), json({ platforms: { windows: {
      version: '26.917.9434.0', runtime: '0.0.16/20260915001755-492f19756c31', architectures: { x64: { sha256: '0'.repeat(64) } } } } }));
    write(join(root, 'installation.json'), json({
      platform: 'windows', app: appDir, architecture: 'x64', package_version: '99.88.77.66',
      runtime: 'runtime-selected', sha256: digest }));
    selected = { app: appDir, resources: resourcesDir, runtime: runtimeDir, launcher, version: '99.88.77.66',
      runtime_version: 'runtime-selected' };
    internals.isatty = () => false;
    // windows.mjs may not exist in this archive layout; the Python tests patch the module functions.
    internals.windows = () => ({
      inventory_sha256: () => digest,
      validate_windows_app_tree: (path, options) => { selected.calls = [path, options]; return selected; },
      _component: (base, relative) => join(base, relative),
    });
  });
  afterEach(() => {
    Object.assign(internals, pristine);
    temporary.cleanup();
  });

  const hostModule = (state) => ({
    start_original_host: (options) => { state.start = options; return state.ready; },
    stop_original_host: (...args) => { state.stop = args; },
  });
  const ready = ['owned-host', '\\\\.\\pipe\\lcu-wre-fixture', '\\\\.\\pipe\\lcu-lifetime-fixture'];

  it('test_uses_managed_app_and_original_windows_paths', () => {
    const resolved = paths(root);
    assert.deepEqual(resolved.slice(0, 3), [appDir, resourcesDir, runtimeDir]);
    assert.equal(selected.calls[0], appDir);
    assert.deepEqual(Object.keys(selected.calls[1]).sort(), ['expected_inventory', 'expected_runtime', 'expected_version']);
    assert.equal(selected.calls[1].expected_version, '99.88.77.66');
    assert.equal(selected.calls[1].expected_runtime, 'runtime-selected');
    const env = withEnv({ USERPROFILE: 'C:\\fixture', Path: 'C:\\Windows' }, () => environment(root, resolved));
    assert.equal(env.CODEX_HOME, 'C:\\fixture\\.codex');
    assert.equal(env.NODE_REPL_NODE_PATH, join(runtimeDir, 'bin/node.exe'));
    assert.equal(env.CUA_REPL_NODE_REPL_PATH, join(runtimeDir, 'bin/node_repl.exe'));
    assert.equal(env.CODEX_CLI_PATH, join(resourcesDir, 'codex.exe'));
    assert.equal(env.NODE_REPL_NODE_MODULE_DIRS, join(runtimeDir, 'bin/node_modules'));
    assert.equal(env.PATH, join(runtimeDir, 'bin') + ';C:\\Windows');
    assert.equal(env.BROWSER_USE_CODEX_APP_VERSION, '99.88.77.66');
  });

  it('test_runs_original_cua_launcher_with_inherited_stdio', async () => {
    const state = { ready };
    const ran = [];
    internals.load = async () => hostModule(state);
    internals.supervise = async (command, env) => { ran.push([command, env]); return 0; };
    await assert.rejects(withEnv({ USERPROFILE: 'C:\\fixture' }, () => main(root, [])),
      (error) => error instanceof PySystemExit && error.status === 0);
    assert.deepEqual(ran[0][0], [join(runtimeDir, 'bin/node.exe'), launcher]);
    const env = ran[0][1];
    assert.equal(env.CUA_REPL_ENABLED_SURFACES, 'computer');
    assert.equal(env.SKY_CUA_NATIVE_PIPE, '1');
    assert.equal(env.SKY_CUA_NATIVE_PIPE_DIRECTORY, ready[1]);
    assert.equal(env.LCU_WRE_LIFETIME_PIPE, ready[2]);
    assert.equal(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).sky, join(root, 'lcu-host/windows-sky-service.mjs'));
    assert.equal(state.start.entry, join(root, 'lcu-host/windows-pipe-host.cjs'));
    assert.deepEqual(state.stop, ['owned-host']);
  });

  it('test_disposes_owned_host_when_original_mcp_fails', async () => {
    const state = { ready };
    internals.load = async () => hostModule(state);
    internals.supervise = async () => { throw Object.assign(new Error('MCP failed'), { code: 'EIO' }); };
    await assert.rejects(withEnv({ USERPROFILE: 'C:\\fixture' }, () => main(root, [])), /MCP failed/);
    assert.deepEqual(state.stop, ['owned-host']);
  });

  it('test_preserves_other_trusted_services_and_rejects_custom_sky', async () => {
    const state = { ready };
    const ran = [];
    internals.load = async () => hostModule(state);
    internals.supervise = async (command, env) => { ran.push(env); return 0; };
    await assert.rejects(withEnv({ USERPROFILE: 'C:\\fixture', NODE_REPL_TRUSTED_SERVICES: '{"browser":"fixture"}' }, () => main(root, [])),
      PySystemExit);
    assert.equal(JSON.parse(ran[0].NODE_REPL_TRUSTED_SERVICES).browser, 'fixture');
    for (const [supplied, regex] of [['{"sky":"custom"}', /conflicts/], ['null', /JSON string map/]]) {
      state.stop = null;
      ran.length = 0;
      await rejectsWith(assert, () => withEnv({ USERPROFILE: 'C:\\fixture', NODE_REPL_TRUSTED_SERVICES: supplied }, () => main(root, [])),
        'ValueError', regex);
      assert.equal(ran.length, 0);
      assert.deepEqual(state.stop, ['owned-host']);
    }
  });

  it('test_chrome_keeps_original_browser_trusted_service', async () => {
    const state = { ready };
    const ran = [];
    internals.load = async () => hostModule(state);
    internals.supervise = async (command, env) => { ran.push(env); return 0; };
    await assert.rejects(withEnv({ USERPROFILE: 'C:\\fixture' }, () => main(root, ['--chrome'])), PySystemExit);
    let services = JSON.parse(ran[0].NODE_REPL_TRUSTED_SERVICES);
    assert.equal(services.browser, '@oai/browser-desktop/service');
    assert.equal(services.sky, join(root, 'lcu-host/windows-sky-service.mjs'));
    await assert.rejects(withEnv({ USERPROFILE: 'C:\\fixture', NODE_REPL_TRUSTED_SERVICES: '{"fixture":"service"}' },
      () => main(root, ['--chrome'])), PySystemExit);
    services = JSON.parse(ran[1].NODE_REPL_TRUSTED_SERVICES);
    assert.ok(!('browser' in services));
    assert.equal(services.fixture, 'service');
  });

  it('test_refuses_descriptor_for_different_installed_package', async () => {
    const descriptor = join(root, 'installation.json');
    const value = JSON.parse(readFileSync(descriptor, 'utf8'));
    value.app = join(root, 'other');
    writeFileSync(descriptor, json(value));
    await rejectsWith(assert, () => paths(root), 'ValueError', /not the managed private generation/);
  });

  it('test_refuses_missing_or_changed_managed_inventory', async () => {
    const inventoryPath = join(prefix, 'apps', digest, 'inventory.json');
    rmSync(inventoryPath);
    await rejectsWith(assert, () => paths(root), 'ValueError', /not the managed private generation/);
    writeFileSync(inventoryPath, json({ '.': { type: 'directory' } }));
    internals.windows = () => ({ inventory_sha256: () => 'b'.repeat(64) });
    await rejectsWith(assert, () => paths(root), 'ValueError', /inventory does not match its descriptor/);
  });

  it('test_requires_observed_metadata_and_inventory_digest', async () => {
    const descriptor = join(root, 'installation.json');
    const original = JSON.parse(readFileSync(descriptor, 'utf8'));
    for (const [key, value] of [['package_version', ''], ['runtime', ''], ['sha256', 'not-a-64-hex-digest']]) {
      writeFileSync(descriptor, json({ ...original, [key]: value }));
      await rejectsWith(assert, () => paths(root), 'ValueError', /incomplete or unsupported/);
    }
  });

  it('test_doctor_uses_windows_sky_without_x11 (runtime dispatch to the real doctor, review #13)', async () => {
    const doctor = await import('../../lcu/doctor.mjs');
    const saved = { ...doctor.internals };
    const report = '{"target": "windows", "windows": {"ok": true, "count": 1}, "screenshot": {"ok": false, "unverified": true}}\n';
    const calls = [];
    let out = '';
    doctor.internals.run = (command, options) => { calls.push([command, options]); return { returncode: 0, stdout: report, stderr: '' }; };
    doctor.internals.write = (text) => { out += text; };
    const io = captureIo();
    try {
      await withEnv({ USERPROFILE: 'C:\\fixture' }, () => main(root, ['doctor']));
    } finally {
      io.restore();
      Object.assign(doctor.internals, saved);
    }
    assert.equal(calls[0][0][0], join(runtimeDir, 'bin/node.exe'));
    assert.equal(calls[0][1].cwd, join(runtimeDir, 'bin'));
    assert.equal(calls[0][1].capture, true); // Python: text=True capture
    assert.match(out, /Original window listing: passed \(1 windows\)\./);
  });
});

describe('discovery compatibility at the file-descriptor level', () => {
  it('reads one byte at a time from fd 0 and writes fd 1 synchronously before execve', () => {
    const tmp = tempDir();
    try {
      const script = join(tmp.path, 'probe.mjs');
      writeFileSync(script, `
        import { fd_sink, fd_source, reply_to_server_discover } from ${JSON.stringify(pathToFileURL(join(REPO, 'lcu/runtime.mjs')).href)};
        import { spawnSync } from 'node:child_process';
        reply_to_server_discover(fd_source(0), fd_sink(1));
        // POSIX replaces the process (execve); Windows has no exec, the launcher supervises a child that inherits fd 0/1.
        if (process.platform === 'win32') {
          const done = spawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdio: 'inherit' });
          process.exit(done.status);
        } else process.execve('/bin/cat', ['cat'], process.env);
      `);
      const following = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
      const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
        input: '{"jsonrpc":"2.0","id":0,"method":"server/discover"}\n' + following, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"Method not found"}}\n' + following);
      assert.equal(result.stderr, '');
    } finally {
      tmp.cleanup();
    }
  });

  it('keeps integer ids exactly, including large ones and floats', () => {
    for (const [id, text] of [['12345678901234567890', '12345678901234567890'], ['1.0', '1.0'], ['"x"', '"x"']]) {
      const out = new BytesIO();
      reply_to_server_discover(new BytesIO(Buffer.from(`{"jsonrpc":"2.0","id":${id},"method":"server/discover"}\n`)), out);
      assert.equal(out.getvalue().toString(), `{"jsonrpc":"2.0","id":${text},"error":{"code":-32601,"message":"Method not found"}}\n`);
    }
  });

  it('rejects ids that are bool/null/missing, non-newline-terminated and oversized requests', async () => {
    for (const id of ['true', 'null', '[1]', '{}']) {
      await rejectsWith(assert, () => reply_to_server_discover(
        new BytesIO(Buffer.from(`{"jsonrpc":"2.0","id":${id},"method":"server/discover"}\n`)), new BytesIO()),
      'ValueError', /compatibility mode/);
    }
    await rejectsWith(assert, () => reply_to_server_discover(new BytesIO(Buffer.from('{"jsonrpc":"2.0"}')), new BytesIO()),
      'ValueError', /newline-terminated/);
    await rejectsWith(assert, () => reply_to_server_discover(new BytesIO(Buffer.from('not json\n')), new BytesIO()),
      'ValueError', /valid initial JSON-RPC/);
    await rejectsWith(assert, () => reply_to_server_discover(new BytesIO(Buffer.alloc(1024 * 1024 + 2, 0x20)), new BytesIO()),
      'ValueError', /newline-terminated|exceeds 1 MiB/);
  });
});

describe('supervised launch exit statuses (macOS/Windows)', () => {
  it('maps the child return code like subprocess.run().returncode and SystemExit(code)', async () => {
    const mk = (script) => [process.execPath, '-e', script];
    assert.equal(await runtime.supervise(mk('process.exit(3)'), process.env), 3);
    assert.equal(await runtime.supervise(mk('process.exit(0)'), process.env), 0);
    if (process.platform !== 'win32') { // a child killed by a signal is -N on POSIX; Windows has exit codes only
      assert.equal(await runtime.supervise(mk('process.kill(process.pid, "SIGKILL")'), process.env), -9);
      assert.equal(await runtime.supervise(mk('process.kill(process.pid, "SIGTERM")'), process.env), -15);
    }
  });

  it('review #7: SIGINT handling follows subprocess.run (wait 0.25 s, then kill; a second SIGINT kills at once)', async () => {
    // process.emit only runs the listener in this process: no signal is sent to anything (SAFETY RULE).
    const mk = [process.execPath, '-e', 'setTimeout(() => {}, 5000)'];
    let started = Date.now();
    let pending = runtime.supervise(mk, process.env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(process.listenerCount('SIGINT'), 1);
    process.emit('SIGINT', 'SIGINT');
    await assert.rejects(pending, (error) => error.name === 'KeyboardInterrupt');
    assert.ok(Date.now() - started >= 250 && Date.now() - started < 2000);
    assert.equal(process.listenerCount('SIGINT'), 0);
    started = Date.now();
    pending = runtime.supervise(mk, process.env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');
    await assert.rejects(pending, (error) => error.name === 'KeyboardInterrupt');
    assert.ok(Date.now() - started < 250, 'a repeated interrupt kills the child immediately');
  });

  it('review #7: an inherited ignored SIGINT stays ignored: no handler, the child keeps SIG_IGN and finishes', async (t) => {
    if (!existsSync('/bin/bash')) return t.skip('needs /bin/bash to report dispositions');
    const { restore_environment } = await import('../../lcu/startup_vars.mjs');
    restore_environment({ __LCU_SIGIGN: 'INT' });
    try {
      const out = join(tempDir().path, 'traps');
      const pending = runtime.supervise(['/bin/bash', '-p', '-c', `{ ${DISPOSITION_SCRIPT}; } > '${out}'`], process.env);
      assert.equal(process.listenerCount('SIGINT'), 0);
      assert.equal(await pending, 0);
      const traps = readFileSync(out, 'utf8');
      assert.match(traps, /INT=1 TERM=0/);
    } finally {
      restore_environment({});
    }
  });

  it('a missing executable is an OSError with Python text', async () => {
    await assert.rejects(runtime.supervise(['/nonexistent/lcu-node', 'x'], process.env),
      process.platform === 'win32' ? /^\[WinError 3\] The system cannot find the path specified$/ : /\[Errno 2\] No such file or directory: '\/nonexistent\/lcu-node'/);
  });
});
