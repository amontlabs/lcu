"""Launch the selected application's original computer-use provider."""
import json
import ntpath
import os
from pathlib import Path
import subprocess
import sys
import uuid

USAGE = ('Usage: lcu [--chrome] [--audio] [--mcp-discovery-compat]\n'
         '       lcu setup OPTIONS\n'
         '       lcu browser install\n'
         '       lcu browser status\n'
         '       lcu apps [list|allow APP|revoke APP] [--json]   (macOS)\n'
         '       lcu origins [list [--session ID] [--json]]\n'
         '       lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]\n'
         '       lcu prune [--keep N] [--yes]\n'
         '       lcu update [--check [--json]] [--yes]\n'
         '       lcu doctor\n'
         '       lcu status [--json]\n'
         '       lcu --version')


def paths(root, descriptor=None):
    """Resolve one selected, intact application generation."""
    app = root / 'app'
    resources = app / 'resources'
    runtime = resources / 'cua_node'
    lock = json.loads((root / 'runtime.lock.json').read_text())
    if descriptor is None:
        descriptor = json.loads((root / 'installation.json').read_text())
    selected = Path(descriptor.get('app', ''))
    arch = descriptor.get('architecture')
    target = descriptor.get('platform', 'linux')
    if target == 'darwin':
        policy = lock.get('platforms', {}).get('darwin', {})
        entry = policy.get('architectures', {}).get(arch)
        if (not selected.is_absolute() or not entry or
                selected.resolve() != app.resolve()):
            raise ValueError('Selected application descriptor does not match the supported macOS app link.')
        from .platforms import resolve_installed_mac_app
        resolved = resolve_installed_mac_app(selected, arch=arch)
        return resolved.app, resolved.resources, resolved.runtime, {
            'version': resolved.version, 'runtime': resolved.runtime_version}
    if target == 'windows':
        policy = lock.get('platforms', {}).get('windows', {})
        entry = policy.get('architectures', {}).get(arch)
        version = descriptor.get('package_version')
        runtime_version = descriptor.get('runtime')
        inventory_digest = descriptor.get('sha256')
        if (not selected.is_absolute() or arch != 'x64' or not entry or
                not isinstance(version, str) or not version or
                not isinstance(runtime_version, str) or not runtime_version or
                not isinstance(inventory_digest, str) or len(inventory_digest) != 64 or
                any(char not in '0123456789abcdef' for char in inventory_digest)):
            raise ValueError('Selected Windows application descriptor is incomplete or unsupported.')
        prefix = root.parent.parent
        apps = prefix / 'apps'
        generation = apps / inventory_digest
        expected = generation / 'app'
        inventory_path = generation / 'inventory.json'
        if (selected != expected or any(path.is_symlink() or path.is_junction()
                                        for path in (apps, generation, selected, inventory_path)) or
                not inventory_path.is_file()):
            raise ValueError('Selected Windows application is not the managed private generation.')
        from .windows import inventory_sha256, validate_windows_app_tree
        try:
            inventory = json.loads(inventory_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError('Managed Windows application inventory is invalid.') from exc
        if inventory_sha256(inventory) != inventory_digest:
            raise ValueError('Managed Windows application inventory does not match its descriptor.')
        resolved = validate_windows_app_tree(selected,
            expected_version=version, expected_runtime=runtime_version,
            expected_inventory=inventory)
        if resolved.app != expected.resolve(strict=True):
            raise ValueError('Selected Windows application does not match the managed generation.')
        return resolved.app, resolved.resources, resolved.runtime, {
            'version': resolved.version, 'runtime': resolved.runtime_version}
    if target != 'linux':
        raise ValueError(f'Unsupported installed application platform: {target}')
    if (not selected.is_absolute() or arch not in lock['architectures'] or
            selected.resolve() != app.resolve()):
        raise ValueError('Selected application descriptor does not match the supported architecture and app link. '
                         'Rerun scripts/install.sh.')
    from .platforms import resolve_installed_linux_app
    try:
        resolved = resolve_installed_linux_app(selected, arch=arch)
    except ValueError as exc:
        raise ValueError(f'{exc}. Rerun scripts/install.sh.') from exc
    # Launch through the release's link, as before; it resolves to the installed app.
    return app, resources, runtime, {'version': resolved.version, 'runtime': resolved.runtime_version}


def default_codex_home(env, windows):
    """The directory the original runtime uses when CODEX_HOME is not set."""
    path_api = ntpath if windows else os.path
    home = (env.get('USERPROFILE') or env.get('HOME') or str(Path.home())) if windows else (
        env['HOME'] if 'HOME' in env else str(Path.home()))
    selected = path_api.normpath(path_api.join(home, '.codex'))
    # Node path.join collapses double leading slashes on Linux.
    return '/' + selected.lstrip('/') if selected.startswith('//') else selected


def environment(root, resolved=None, *, chrome=False, audio=False, platform=None):
    _, resources, runtime, metadata = resolved or paths(root)
    target = platform if platform is not None else json.loads(
        (root / 'installation.json').read_text()).get('platform', 'linux')
    windows = target == 'windows'
    path_api = ntpath if windows else os.path
    separator = ';' if windows else os.pathsep
    module_dir = runtime / ('bin/node_modules' if windows else 'lib/node_modules')
    node = runtime / ('bin/node.exe' if windows else 'bin/node')
    node_repl = runtime / ('bin/node_repl.exe' if windows else 'bin/node_repl')
    from .app_layout import locate_codex_tools
    codex = locate_codex_tools(resources, windows=windows).cli
    env = dict(os.environ)
    # Original gM/nne selects and trusts CODEX_HOME verbatim, including an
    # explicitly empty value. This changes only the launched child environment.
    if 'CODEX_HOME' not in env:
        env['CODEX_HOME'] = default_codex_home(env, windows)
    # Select our verified executables, while retaining upstream caller options,
    # metadata, services, policy flags, and additional module/trust roots.
    def prepend(key, *paths):
        return separator.join(dict.fromkeys([*(str(path) for path in paths if str(path)),
            *(path for path in env.get(key, '').split(separator) if path)]))

    if windows:
        existing_path = next((value for key, value in env.items() if key.upper() == 'PATH'), '')
        for key in tuple(env):
            if key.upper() == 'PATH':
                del env[key]
    else:
        existing_path = env.get('PATH', '/usr/bin:/bin')

    env.update(
        PATH=str(runtime / 'bin') + separator + existing_path,
        CUA_REPL_NODE_REPL_PATH=str(node_repl),
        NODE_REPL_NODE_PATH=str(node),
        NODE_REPL_NODE_MODULE_DIRS=prepend('NODE_REPL_NODE_MODULE_DIRS', module_dir),
        NODE_REPL_TRUSTED_CODE_PATHS=prepend('NODE_REPL_TRUSTED_CODE_PATHS',
            env['CODEX_HOME'], module_dir, resources / 'plugins'),
    )
    # The original launcher selects both its API and instructions from this
    # surface list. External Chrome is an explicit opt-in for LCU clients.
    env.setdefault('CUA_REPL_ENABLED_SURFACES', 'browser,computer' if chrome else 'computer')
    # These paired switches are the original optional computer-audio API gate.
    # Inherit caller policy when LCU was not explicitly asked to enable audio.
    if audio:
        env['SKY_ENABLE_AUDIO'] = '1'
        env['NODE_REPL_ENABLE_AUDIO'] = '1'
    env.setdefault('CUA_REPL_BROWSER_ENV', 'codex-app')
    env.setdefault('CODEX_CLI_PATH', str(codex))
    if resources.parent.name == 'Contents':
        # Original Sky's macOS native-pipe transport uses this signed helper
        # through LaunchServices when no existing CUA service is connected.
        env.setdefault('SKY_CUA_SERVICE_PATH', str(runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app'))
    # Fixed host defaults from nne/kie in the pinned application. The unified
    # codex-app surface is selected only with browserUseTinysky in original Lre.
    env.setdefault('NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS', '1000')
    if env['CUA_REPL_BROWSER_ENV'] == 'codex-app':
        env.setdefault('BROWSER_USE_AVAILABLE_BACKENDS', 'chrome')
        env.setdefault('BROWSER_USE_TINYSKY_ENABLED', '1')
        flavor = env.get('BUILD_FLAVOR', '').strip()
        valid_flavors = ('dev', 'agent', 'nightly', 'internal-alpha', 'public-beta', 'prod')
        env.setdefault('BROWSER_USE_CODEX_APP_BUILD_FLAVOR', flavor if flavor in valid_flavors else 'prod')
        env.setdefault('BROWSER_USE_CODEX_APP_VERSION', metadata['version'])
    env.setdefault('NODE_REPL_DISABLE_ANALYTICS', '1')
    # Original browser service switch: do not initialize account identity or
    # telemetry. The relay already supplies the local agent-header decision.
    env.setdefault('BROWSER_USE_DISABLE_AMBIENT_NETWORK', '1')
    # Upstream browser routing needs an identity even for a generic MCP client.
    # This names this actual MCP connection, not a Codex model or an approval.
    # Host-supplied request metadata and per-call metadata keep precedence.
    if 'NODE_REPL_REQUEST_META' not in env:
        identity = 'lcu-' + str(uuid.uuid4())
        env['NODE_REPL_REQUEST_META'] = json.dumps({'x-codex-turn-metadata': {
            'session_id': identity, 'turn_id': identity + '-connection'}})
    if target == 'linux':
        _configure_linux_input(root, runtime, env, metadata)
        mode = env.get('LCU_NODE_REPL_SANDBOX', '').strip().lower()
        if mode == 'off':
            _default_linux_sandbox_state(env)
        elif mode != 'host':
            _configure_linux_sandbox_shim(root, runtime, env)
    return env


LINUX_INPUT_TOOLKITS = ('gtk4', 'qt-scroll')


def linux_input_translation_off(env):
    return env.get('LCU_LINUX_INPUT_TRANSLATION', '').strip().lower() in ('off', '0', 'false', 'no')


def _configure_linux_input(root, runtime, env, metadata):
    """Interpose a thin wrapper on the Sky RPC for window-targeted input GTK 4 and Qt ignore.

    The original Linux engine sends window-targeted keys, clicks, scroll and drag with
    XSendEvent, which GTK 4 (XInput2 only) ignores, and Qt ignores for scroll. The wrapper
    re-issues those calls through the engine's own desktop-level path for those windows only.
    `LCU_LINUX_INPUT_TRANSLATION=off` leaves the original service in place. An exact tested
    app/runtime pair whose record lists `native_input` is not translated for those toolkits.
    """
    if linux_input_translation_off(env):
        return
    wrapper = root / 'lcu/linux_sky_service.mjs'
    service = runtime / 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'
    surfaces = {surface.strip() for surface in env.get('CUA_REPL_ENABLED_SURFACES', '').split(',')}
    if 'computer' not in surfaces or not wrapper.is_file():
        return
    toolkits = list(LINUX_INPUT_TOOLKITS)
    try:
        from . import tested
        descriptor = json.loads((root / 'installation.json').read_text())
        native = tested.native_input(root, platform='linux', architecture=descriptor.get('architecture'),
                                     app_version=metadata['version'], runtime=metadata['runtime'])
        toolkits = [toolkit for toolkit in toolkits if toolkit not in native]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    if not toolkits:
        return
    # The original launcher keeps a caller-supplied service map verbatim. Wrap Sky only when no map is
    # supplied, or when the caller's map names the original Sky service explicitly (or already this wrapper).
    raw_services = env.get('NODE_REPL_TRUSTED_SERVICES')
    if raw_services is not None:
        try:
            supplied = json.loads(raw_services)
        except ValueError:
            return
        if not isinstance(supplied, dict) or supplied.get('sky') not in ('@oai/sky/service', str(wrapper)):
            return  # an empty, custom-only or custom-Sky map is the caller's and stays exactly as given
    try:
        _override_trusted_service(env, wrapper, os.pathsep, 'Linux', computer_gated=True)
    except ValueError:
        return
    env['LCU_LINUX_SKY_SERVICE_PATH'] = str(service)
    env['LCU_LINUX_INPUT_TOOLKITS'] = ','.join(toolkits)


def _configure_linux_sandbox_shim(root, runtime, env):
    """Keep the model's JavaScript kernel sandboxed while Sky, the trusted worker, can reach X11.

    With no `codex/sandbox-state-meta` the original node_repl runs its kernel and trusted Sky
    worker under `codex sandbox` with network disabled whenever the machine supports bubblewrap.
    That seccomp filter refuses connect(2), so Sky cannot reach the X11 socket. node_repl starts
    both through CODEX_CLI_PATH, so LCU points it at a launcher shim (`sandbox_shim`) that leaves
    the kernel sandboxed as asked and starts only the identified Sky worker outside it. A host
    that sends its own `codex/sandbox-state-meta` (a `disabled` profile included) keeps full
    precedence: node_repl then asks for the sandbox it was told to. Without the shim file the
    original behavior stays, which fails closed. LCU_NODE_REPL_SANDBOX=host leaves everything
    untouched and `off` runs the kernel unsandboxed (see `_default_linux_sandbox_state`).
    """
    from . import sandbox_shim
    shim = root / 'bin/lcu-codex-sandbox'
    if not shim.is_file() or not env.get('CODEX_CLI_PATH'):
        return
    wrapper = root / 'lcu/linux_sky_service.mjs'
    try:
        sky = json.loads(env['NODE_REPL_TRUSTED_SERVICES']).get('sky')
    except (KeyError, ValueError, AttributeError):
        # The original launcher defaults to the original Sky service when no map is supplied.
        sky = sandbox_shim.SKY_SERVICE
    env[sandbox_shim.CONFIG_ENV] = sandbox_shim.configuration(
        runtime, env['CODEX_CLI_PATH'], wrapper if sky == str(wrapper) else None)
    # node_repl starts the kernel with only the variables on this list; the shim needs its
    # configuration there too, because it must find the real Codex to sandbox the kernel with. The
    # test-only fault hook travels the same way and can only make the shim refuse.
    shared = [sandbox_shim.CONFIG_ENV] + ([sandbox_shim.FAULT_ENV] if sandbox_shim.FAULT_ENV in env else [])
    env['NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'] = ','.join(filter(None, (
        env.get('NODE_REPL_UNTRUSTED_ENV_ALLOWLIST'), *shared)))
    env['CODEX_CLI_PATH'] = str(shim)


SANDBOX_STATE_META = 'codex/sandbox-state-meta'


def _default_linux_sandbox_state(env):
    """Give the original node_repl the `disabled` sandbox state official Codex sends under
    danger-full-access, so it starts neither its JavaScript kernel nor its Sky worker in
    `codex sandbox` (`LCU_NODE_REPL_SANDBOX=off`; no longer the default). A host that sends its
    own `codex/sandbox-state-meta` per call, or one in NODE_REPL_REQUEST_META, keeps precedence.
    """
    try:
        request = json.loads(env['NODE_REPL_REQUEST_META'])
    except ValueError:
        return
    if not isinstance(request, dict) or SANDBOX_STATE_META in request:
        return
    try:
        cwd = Path.cwd()
    except OSError:
        cwd = Path('/')
    request[SANDBOX_STATE_META] = {
        'permissionProfile': {'type': 'disabled'}, 'sandboxCwd': cwd.as_uri()}
    env['NODE_REPL_REQUEST_META'] = json.dumps(request)
    return env


def _leave_unusable_working_directory():
    """Start from `/` when the launch directory cannot be entered.

    Without a sandbox state of its own, `node_repl` starts its kernel in the process's working
    directory and fails with "Permission denied" when the account cannot enter it.
    """
    try:
        usable = os.access('.', os.R_OK | os.X_OK)
    except OSError:
        usable = False
    if not usable:
        os.chdir('/')


def reply_to_server_discover(source, destination):
    """Return a legacy-version probe error without reading beyond its line."""
    raw = bytearray()
    while len(raw) <= 1024 * 1024:
        byte = source.read(1)
        if not byte:
            break
        raw.extend(byte)
        if byte == b'\n':
            break
    if not raw.endswith(b'\n'):
        raise ValueError('Expected a newline-terminated initial JSON-RPC server/discover request.')
    if len(raw) > 1024 * 1024:
        raise ValueError('Initial JSON-RPC server/discover request exceeds 1 MiB.')
    try:
        request = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError('Expected a valid initial JSON-RPC server/discover request.') from exc
    request_id = request.get('id') if isinstance(request, dict) else None
    if (not isinstance(request, dict) or request.get('jsonrpc') != '2.0' or
            request.get('method') != 'server/discover' or
            isinstance(request_id, bool) or not isinstance(request_id, (str, int, float))):
        raise ValueError('Expected an initial JSON-RPC server/discover request in compatibility mode.')
    response = {'jsonrpc': '2.0', 'id': request_id,
                'error': {'code': -32601, 'message': 'Method not found'}}
    destination.write((json.dumps(response, separators=(',', ':')) + '\n').encode())
    destination.flush()


def _override_trusted_service(env, wrapper, separator, platform_name, *, computer_gated):
    """Add the native-cleanup Sky wrapper while keeping any other trusted services."""
    surfaces = {surface.strip() for surface in env.get('CUA_REPL_ENABLED_SURFACES', '').split(',')}
    gate = ('computer' in surfaces) if computer_gated else True
    raw_services = env.get('NODE_REPL_TRUSTED_SERVICES')
    supplied = json.loads(raw_services) if raw_services is not None else None
    if raw_services is None:
        supplied = {}
        if 'browser' in surfaces:
            supplied['browser'] = '@oai/browser-desktop/service'
        if gate:
            supplied['sky'] = '@oai/sky/service'
    if not isinstance(supplied, dict) or any(not isinstance(key, str) or not isinstance(value, str)
                                             for key, value in supplied.items()):
        raise ValueError('NODE_REPL_TRUSTED_SERVICES must be a JSON string map.')
    if gate and supplied.get('sky') not in (None, '@oai/sky/service', str(wrapper)):
        raise ValueError(f'A custom Sky trusted-service override conflicts with {platform_name} native cleanup.')
    services = dict(supplied)
    if gate:
        services['sky'] = str(wrapper)
    env['NODE_REPL_TRUSTED_SERVICES'] = json.dumps(services)
    env['NODE_REPL_TRUSTED_CODE_PATHS'] = separator.join(dict.fromkeys(
        [str(wrapper.parent), *filter(None, env.get('NODE_REPL_TRUSTED_CODE_PATHS', '').split(separator))]))


def _configure_macos_lifecycle(root, runtime, env):
    """Keep original Sky behavior and add only its turn-ended host hook."""
    surfaces = {surface.strip() for surface in env.get('CUA_REPL_ENABLED_SURFACES', '').split(',')}
    if 'computer' not in surfaces:
        return None
    wrapper = root / 'lcu/macos_sky_service.mjs'
    _override_trusted_service(env, wrapper, os.pathsep, 'macOS', computer_gated=False)
    env['LCU_MAC_SKY_SERVICE_PATH'] = str(runtime / 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js')
    env['LCU_MAC_SKY_CLIENT_PATH'] = str(runtime / 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/mac/client.js')
    client = Path(env['SKY_CUA_SERVICE_PATH']) / 'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
    return client


def main(root, argv):
    # Agent registrations place LCU options before generic executable probes.
    probe = list(argv)
    probe_options = set()
    while probe[:1] and probe[0] in ('--chrome', '--audio') and probe[0] not in probe_options:
        probe_options.add(probe.pop(0))
    if probe in (['--help'], ['-h'], ['--version']):
        argv = probe
    if argv[:1] in (['--help'], ['-h']):
        print(USAGE + '\nWith no arguments, starts the original computer-use stdio MCP server. '
              '`lcu --chrome` also enables its browser surface; `lcu setup --chrome` registers that command. '
              '`lcu --audio` enables the original optional computer-audio API; `lcu setup --audio` registers that command.')
        return
    if argv[:1] == ['--version']:
        release_path = root / 'bundle.json'
        version = json.loads(release_path.read_text())['version'] if release_path.is_file() else 'source-checkout'
        descriptor_path = root / 'installation.json'
        descriptor = json.loads(descriptor_path.read_text()) if descriptor_path.is_file() else {}
        target = descriptor.get('platform', 'linux')
        if descriptor_path.is_file():
            try:
                metadata = paths(root, descriptor)[3]
            except ValueError as exc:
                print(f'lcu {version} (ChatGPT {target} app invalid: {exc})')
                raise SystemExit(1)
            print(f"lcu {version} (ChatGPT {target} {metadata['version']}; CUA {metadata['runtime']})")
        else:
            print(f'lcu {version} (ChatGPT {target} app not selected)')
        return
    if argv[:1] == ['setup']:
        from .setup import main as setup
        if '--prefix' not in argv:
            argv += ['--prefix', str(root.parent.parent)]
        setup(argv[1:])
        return
    if argv[:1] == ['browser']:
        from .browser import main as browser
        browser(root, argv[1:])
        return
    if argv[:1] == ['status']:
        from .status import main as status
        status(root, argv[1:])
        return
    if argv[:1] == ['apps']:
        from .apps import main as apps
        apps(root, argv[1:])
        return
    if argv[:1] == ['origins']:
        from .origins import main as origins
        origins(argv[1:])
        return
    if argv[:1] == ['prune']:
        from .maintenance import main as maintenance
        maintenance(root, argv[1:])
        return
    if argv[:1] == ['update']:
        from .update import main as update
        status = update(root, argv[1:])
        if status:
            raise SystemExit(status)
        return
    if argv == ['--with-browser-host']:
        raise ValueError('--with-browser-host was removed with the embedded browser. '
                         'Run lcu browser install and enable the official Chrome extension.')
    chrome = argv.count('--chrome') == 1
    audio = argv.count('--audio') == 1
    direct_args = [arg for arg in argv if arg not in ('--chrome', '--audio')]
    doctor_args = direct_args[1:] if direct_args[:1] == ['doctor'] else None
    discovery_compat = direct_args == ['--mcp-discovery-compat']
    if (argv.count('--chrome') > 1 or argv.count('--audio') > 1 or
            (direct_args not in ([], ['--mcp-discovery-compat']) and doctor_args is None)):
        raise ValueError(USAGE)
    # `lcu doctor --help` documents the check without resolving the installed app.
    if doctor_args is not None and ('--help' in doctor_args or '-h' in doctor_args):
        from .doctor import main as doctor
        return doctor(root, doctor_args)
    # A bare stdio server launched from a real terminal only appears to hang.
    if direct_args == [] and sys.stdin.isatty() and sys.stdout.isatty():
        # `lcu` is not on PATH; name the command exactly as it was invoked.
        command = sys.argv[0] if os.path.isabs(sys.argv[0]) else str(root / 'bin/lcu')
        print('lcu is a stdio MCP server, launched by an agent harness over pipes, not run directly.\n'
              + USAGE + f'\nRun `{command} setup` to register it with a harness, '
              f'or `{command} doctor` to check readiness.', file=sys.stderr)
        raise SystemExit(2)
    descriptor = json.loads((root / 'installation.json').read_text())
    platform = descriptor.get('platform', 'linux')
    resolved = paths(root, descriptor)
    app, resources, runtime, _ = resolved
    env = environment(root, resolved, chrome=chrome, audio=audio, platform=platform)
    windows = platform == 'windows'
    if doctor_args is not None:
        from .doctor import main as doctor
        status = doctor(root, doctor_args, resolved=resolved, env=env)
        if status:
            raise SystemExit(status)
        return
    if windows:
        from .windows import _component
        launcher = _component(resources.parents[1],
            'app/resources/cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
    else:
        launcher = runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
    command = [env['NODE_REPL_NODE_PATH'], str(launcher)]
    if discovery_compat:
        reply_to_server_discover(sys.stdin.buffer.raw, sys.stdout.buffer)
    if windows:
        from .windows_host import start_original_host, stop_original_host
        helper = _component(app,
            'app/resources/cua_node/bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe')
        transport = _component(app,
            'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js')
        host, pipe, lifetime = start_original_host(
            node=Path(env['NODE_REPL_NODE_PATH']), entry=root / 'lcu-host/windows-pipe-host.cjs',
            helper=helper, transport=transport, env=env)
        env['SKY_CUA_NATIVE_PIPE'] = '1'
        env['SKY_CUA_NATIVE_PIPE_DIRECTORY'] = pipe
        env['LCU_WRE_LIFETIME_PIPE'] = lifetime
        env['LCU_WRE_SKY_SERVICE_PATH'] = str(_component(app,
            'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'))
        wrapper = root / 'lcu-host/windows-sky-service.mjs'
        try:
            _override_trusted_service(env, wrapper, ';', 'Windows', computer_gated=True)
            status = subprocess.run(command, env=env, check=False).returncode
        finally:
            stop_original_host(host)
        raise SystemExit(status)
    macos = platform == 'darwin'
    if macos:
        client = _configure_macos_lifecycle(root, runtime, env)
        if client is not None:
            from .macos_host import start_original_host, stop_original_host
            host, temporary, address = start_original_host(
                python=Path(sys.executable), client=client, entry=root / 'lcu/macos_host.py', env=env,
                control_address=env.get('LCU_MAC_CONTROL_SOCKET'))
            env['LCU_MAC_LIFETIME_SOCKET'] = address
            try:
                status = subprocess.run(command, env=env, check=False).returncode
            finally:
                stop_original_host(host, temporary)
            raise SystemExit(status)
    if platform == 'linux':
        _leave_unusable_working_directory()
    os.execve(runtime / 'bin/node', command, env)
