"""Check the original desktop provider and guide first-use permissions."""
from __future__ import annotations

import argparse
import json
import os
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile


MAC_ACCESSIBILITY_SETTINGS = (
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
)
MAC_SCREEN_CAPTURE_SETTINGS = (
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
)


PROBE = r'''
import { handleRpc } from '@oai/sky/service';
const report = {};
function errorInfo(error) {
  const detail = {};
  if (Number.isInteger(error?.code)) detail.code = error.code;
  if (typeof error?.errorName === 'string') detail.name = error.errorName;
  if (typeof error?.message === 'string') detail.message = error.message.replace(/\s+/g, ' ').slice(0, 240);
  return detail;
}
async function call(method, args = []) {
  try { return {ok: true, value: await handleRpc({type: 'execute', method, args})}; }
  catch (error) { return {ok: false, error: errorInfo(error)}; }
}
try {
  const setup = await handleRpc({type: 'setup'});
  report.target = setup.target;
  if (setup.target === 'linux') {
    const windows = await call('list_windows');
    report.windows = windows.ok && Array.isArray(windows.value)
      ? {ok: true, count: windows.value.length}
      : windows.ok ? {ok: false, error: {message: 'Original runtime returned an invalid window list.'}}
        : {ok: false, error: windows.error};
    if (report.windows.ok) {
      const screenshots = await call('get_screenshot');
      if (!screenshots.ok) {
        report.screenshot = {ok: false, error: screenshots.error};
      } else {
        const images = screenshots.value;
        const valid = Array.isArray(images) && images.length > 0 && images.every(
          image => image && typeof image.data_url === 'string' && image.data_url.startsWith('data:image/'));
        report.screenshot = {ok: valid, count: Array.isArray(images) ? images.length : 0,
          error: valid ? undefined : {message: 'Original runtime returned no usable screenshot.'}};
        // The original API owns its normal temporary capture files. This probe
        // emits no image data and creates no additional screenshot copy.
        if (Array.isArray(images)) for (const image of images) image.data_url = '';
      }
    } else {
      report.screenshot = {ok: false, skipped: true};
    }
  } else if (setup.target === 'windows') {
    const windows = await call('list_windows');
    report.windows = windows.ok && Array.isArray(windows.value)
      ? {ok: true, count: windows.value.length}
      : windows.ok ? {ok: false, error: {message: 'Original runtime returned an invalid window list.'}}
        : {ok: false, error: windows.error};
    report.screenshot = {ok: false, unverified: true};
  } else if (setup.target === 'mac') {
    const methods = Array.isArray(setup.methods) ? setup.methods : [];
    const needed = ['list_apps', 'get_app_state'];
    report.provider = {ok: needed.every(method => methods.includes(method)), methods: methods.filter(
      method => needed.includes(method))};
    report.permissions = {ok: false, unverified: true};
  } else {
    report.provider = {ok: false, error: {message: 'Unsupported original runtime target.'}};
  }
} catch (error) {
  report.provider = {ok: false, error: errorInfo(error)};
}
console.log(JSON.stringify(report));
'''


def _bundle_display_name(bundle: Path, fallback: str) -> str:
    try:
        with (bundle / 'Contents/Info.plist').open('rb') as source:
            info = plistlib.load(source)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return fallback
    for key in ('CFBundleDisplayName', 'CFBundleName'):
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback


def mac_permission_targets(app: Path) -> dict[str, tuple[str, Path]]:
    """Read names from the selected app and its signed helper."""
    from .platforms import MAC_HELPER
    helper = app / 'Contents' / MAC_HELPER
    return {
        'accessibility': (_bundle_display_name(helper, helper.name), helper),
        'screen_capture': (_bundle_display_name(app, app.name), app),
    }


def _probe(runtime: Path, env: dict[str, str], target: str, *, timeout: int = 25) -> dict:
    node = Path(env['NODE_REPL_NODE_PATH'])
    cwd = runtime / ('bin' if target == 'windows' else 'lib')
    result = subprocess.run(
        [str(node), '--input-type=module', '-e', PROBE], cwd=cwd, env=env,
        stdin=subprocess.DEVNULL, capture_output=True, text=True,
        encoding='utf-8', errors='replace', timeout=timeout,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().replace('\n', ' ')[:240]
        raise ValueError(detail or f'Original provider exited with status {result.returncode}.')
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise ValueError('Original provider returned no readiness result.')
    try:
        report = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise ValueError('Original provider returned an unreadable readiness result.') from exc
    if not isinstance(report, dict):
        raise ValueError('Original provider returned an invalid readiness result.')
    expected = {'linux': 'linux', 'mac': 'mac', 'darwin': 'mac', 'windows': 'windows'}.get(target)
    if report.get('target') != expected:
        raise ValueError(f'Original provider target mismatch: expected {expected}, received {report.get("target")}.')
    return report


def _failure_text(check: dict) -> str:
    error = check.get('error') or {}
    code = error.get('code')
    name = error.get('name')
    message = error.get('message')
    if code == -10009 or name == 'permissionsNotGranted':
        return ('The original runtime reports that a required permission is not granted; '
                'it does not identify which macOS permission.')
    if code == -10014 or name == 'permissionsPending':
        return 'The original runtime is waiting for a permission decision.'
    if message:
        return f'Original runtime: {message}'
    return 'The original runtime did not complete this check.'


def _mac_instructions(app: Path) -> None:
    targets = mac_permission_targets(app)
    accessibility_name, accessibility_path = targets['accessibility']
    screen_name, screen_path = targets['screen_capture']
    print('macOS privacy status is not available to this CLI. The original Mac API requires')
    print('its connected agent approval before it can inspect an app, so LCU will not inspect one here.')
    print('Review these entries in System Settings > Privacy & Security:')
    print(f'  Accessibility: {accessibility_name} ({accessibility_path})')
    print(f'  Screen & System Audio Recording, or Screen Recording: {screen_name} ({screen_path})')
    print('macOS may not list an app until its first approved use. LCU never grants access or opens Settings on its own.')


def _open_settings(url: str, label: str) -> None:
    try:
        subprocess.run(['open', url], stdin=subprocess.DEVNULL, check=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f'Could not open {label}: {exc}')
        print(f'Open it manually: {label}')


def _mac_guidance(app: Path, retry) -> None:
    _mac_instructions(app)
    print('\nChoose a settings pane, retry the installed-runtime check, or finish:')
    print('  [a] Open Accessibility settings')
    print('  [s] Open Screen & System Audio Recording settings')
    print('  [r] Recheck original runtime metadata')
    print('  [Enter] Finish')
    while True:
        try:
            choice = input('Choice [a/s/r/Enter]: ').strip().lower()
        except (EOFError, KeyboardInterrupt):
            choice = ''
        if choice in ('a', '1'):
            _open_settings(MAC_ACCESSIBILITY_SETTINGS,
                           'System Settings > Privacy & Security > Accessibility')
        elif choice in ('s', '2'):
            _open_settings(MAC_SCREEN_CAPTURE_SETTINGS,
                           'System Settings > Privacy & Security > Screen & System Audio Recording')
        elif choice == 'r':
            try:
                probe = retry()
                _print_mac_status(probe)
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                print(f'Original runtime check failed: {exc}')
                print('This is a runtime/backend failure, not proof that a macOS permission is missing.')
        elif choice in ('', 'q', 'done'):
            break
        else:
            print('Choose a, s, r, or press Enter to finish.')
    print('Next: reconnect your agent, open a harmless window such as a blank TextEdit document, and ask it')
    print('to inspect that window with LCU and return a screenshot. Approve the original app request and macOS prompts.')


def _print_mac_status(probe: dict) -> bool:
    provider = probe.get('provider') or {}
    if provider.get('ok'):
        print('Original Mac provider loaded; app listing and app-state methods are available.')
    else:
        print(f'Original Mac provider check failed. {_failure_text(provider)}')
    print('macOS privacy permissions: not verified by LCU.')
    return bool(provider.get('ok'))


def linux_sandbox_works(env: dict) -> tuple[bool, str]:
    """Run the check the original node_repl makes: can `codex sandbox` start a confined command here?"""
    from .sandbox_shim import unshimmed_env
    env = unshimmed_env(env)
    codex = env.get('CODEX_CLI_PATH')
    if not codex:
        return False, 'no Codex executable'
    with tempfile.TemporaryDirectory(prefix='lcu-sandbox-probe-') as scratch:
        command = [codex, 'sandbox', '-c', 'shell_environment_policy.inherit="all"',
                   '-c', 'default_permissions="node_repl"',
                   '-c', 'permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false}}',
                   '--', '/bin/sh', '-c', 'test -r /etc/os-release || exit 10; touch "$1" && exit 11; exit 12',
                   'node-repl-sandbox-probe', os.path.join(scratch, 'write-must-fail')]
        try:
            result = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, capture_output=True,
                                    cwd=scratch, text=True, encoding='utf-8', errors='replace', timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            return False, str(exc)[:200]
    if result.returncode == 12:
        return True, ''
    detail = ' '.join(result.stderr.split())[:200]
    return False, f'exit {result.returncode}' + (f': {detail}' if detail else '')


def print_linux_sandbox_status(env: dict, *, works=None) -> None:
    works = works or linux_sandbox_works
    mode = env.get('LCU_NODE_REPL_SANDBOX', '').strip().lower()
    if mode == 'host':
        print('JavaScript sandbox: LCU_NODE_REPL_SANDBOX=host leaves the original runtime behavior. Where '
              'bubblewrap works it also confines the Sky desktop service, which then cannot reach X11.')
        return
    if mode == 'off':
        print("JavaScript sandbox: OFF (LCU_NODE_REPL_SANDBOX=off). The kernel that runs the model's "
              'JavaScript is not sandboxed, unless the agent host asks for one.')
        return
    working, detail = works(env)
    if not working:
        print('JavaScript sandbox: NOT AVAILABLE here (bubblewrap cannot start a sandbox'
              + (f'; {detail}' if detail else '') + "). The kernel that runs the model's JavaScript is "
              "not sandboxed on this machine; it has your account's access to files, network and "
              'processes. Containers and hosts that restrict user namespaces behave this way.')
    elif 'LCU_SANDBOX_SHIM' not in env:
        print("JavaScript sandbox: available, but LCU's launcher shim is missing from this release, so "
              'the original runtime confines the Sky desktop service too and desktop control will fail.')
    else:
        print("JavaScript sandbox: active. The kernel that runs the model's JavaScript is confined "
              '(read-only filesystem, no network; subprocesses it starts are confined too); only the trusted Sky desktop service '
              'runs outside it. An agent host that sends a disabled sandbox state gets none.')


def _print_linux_status(probe: dict) -> bool:
    windows = probe.get('windows') or {}
    screenshot = probe.get('screenshot') or {}
    if windows.get('ok'):
        print(f"Window listing: passed ({windows.get('count', 0)} windows).")
    else:
        print(f'Window listing: could not verify. {_failure_text(windows)}')
    if screenshot.get('ok'):
        print(f"Screenshot capture: passed ({screenshot.get('count', 0)} images); returned image data was discarded by LCU.")
    elif screenshot.get('skipped'):
        print('Screenshot capture: not checked because window listing failed.')
    else:
        print(f'Screenshot capture: could not verify. {_failure_text(screenshot)}')
    return bool(windows.get('ok') and screenshot.get('ok'))


def _linux_guidance(probe: dict, retry) -> bool:
    while True:
        if _print_linux_status(probe):
            print('Computer use is ready for the first agent call.')
            return True
        print('A failed check can be a desktop-service problem; this result alone does not identify a missing permission.')
        print('  [r] Retry the original checks')
        print('  [Enter] Finish')
        try:
            choice = input('Choice [r/Enter]: ').strip().lower()
        except (EOFError, KeyboardInterrupt):
            choice = ''
        if choice != 'r':
            print('Desktop readiness remains incomplete. Rerun lcu doctor after resolving the issue.')
            return False
        try:
            probe = retry()
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            probe = {'windows': {'ok': False, 'error': {'message': str(exc)}},
                     'screenshot': {'ok': False, 'skipped': True}}


def _print_windows_status(probe: dict) -> bool:
    windows = probe.get('windows') or {}
    if windows.get('ok'):
        print(f"Original window listing: passed ({windows.get('count', 0)} windows).")
    else:
        print(f'Original window listing: could not verify. {_failure_text(windows)}')
    print('Screenshot and Windows permission readiness are not verified by this check.')
    return bool(windows.get('ok'))


def main(root: Path, argv=None, *, resolved=None, env=None) -> int:
    parser = argparse.ArgumentParser(description='Check the original desktop provider and guide first-use permissions.')
    parser.add_argument('--non-interactive', action='store_true',
                        help='Check without prompts or opening System Settings')
    parser.add_argument('--require-ready', action='store_true',
                        help='Exit nonzero unless this platform can verify desktop readiness')
    args = parser.parse_args(argv)
    if resolved is None or env is None:
        from .runtime import environment, paths
        resolved = paths(root)
        env = environment(root, resolved)
    app, _, runtime, metadata = resolved
    platform_name = json.loads((root / 'installation.json').read_text()).get('platform', 'linux')
    target = 'mac' if platform_name == 'darwin' else platform_name
    interactive = sys.stdin.isatty() and not args.non_interactive
    print(f"Original app: ChatGPT {metadata['version']} (CUA {metadata['runtime']}).")
    from .tested import changed_since_install, report as report_tested_pair
    report_tested_pair(root, metadata=metadata)
    try:
        changed = changed_since_install(json.loads((root / 'installation.json').read_text()), metadata)
    except (OSError, ValueError):
        changed = None
    if changed:
        print(f'Warning: {changed}')
    from .update import status_line
    update_line = status_line(root)
    if update_line:
        print(update_line)
    from .diagnostic_log import summary as diagnostic_log_summary
    print(diagnostic_log_summary())
    if target == 'mac':
        from .platforms import mac_socket_path_problem
        problem = mac_socket_path_problem()
        if problem:
            print(problem)
            return 2
    if target == 'linux':
        print_linux_sandbox_status(env)
    if target == 'linux' and (not env.get('DISPLAY') or not env.get('DBUS_SESSION_BUS_ADDRESS')):
        message = ('A live X11 DISPLAY and DBUS_SESSION_BUS_ADDRESS are required. '
                   'Use lcu-session or run inside the desktop session.')
        print(f'Window listing: could not verify. {message}')
        print('Screenshot capture: not checked because window listing could not start.')
        return 2
    try:
        probe = _probe(runtime, env, target)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f'Original provider check failed: {exc}')
        if target == 'mac':
            print('This is a runtime/backend failure; it does not prove that a macOS permission is missing.')
            if interactive:
                _mac_guidance(app, lambda: _probe(runtime, env, target))
                return 2
            _mac_instructions(app)
            print('Next: reconnect your agent and make the first approved LCU screenshot call to verify access.')
        return 2
    if target == 'linux':
        if interactive:
            ready = _linux_guidance(probe, lambda: _probe(runtime, env, target))
        else:
            ready = _print_linux_status(probe)
            if ready:
                print('Computer use is ready for the first agent call.')
        if args.require_ready and not ready:
            return 2
        return 0 if ready else 2
    if target == 'windows':
        windows_ok = _print_windows_status(probe)
        if args.require_ready:
            print('Next: verify an approved screenshot call through the connected agent.')
            return 2
        if not windows_ok:
            return 2
        return 0
    if target == 'mac':
        provider_ok = _print_mac_status(probe)
        if interactive:
            _mac_guidance(app, lambda: _probe(runtime, env, target))
        else:
            _mac_instructions(app)
            print('Next: reconnect your agent and make the first approved LCU screenshot call to verify access.')
        if args.require_ready:
            print('macOS permission grants cannot be verified by this check; readiness stays unconfirmed.')
            return 2
        return 0 if provider_ok else 2
    provider = probe.get('provider') or {}
    print(f'Original desktop provider: could not verify. {_failure_text(provider)}')
    return 2
