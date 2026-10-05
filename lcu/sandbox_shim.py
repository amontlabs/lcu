"""Stand between the original node_repl and `codex sandbox` on Linux.

On a machine where bubblewrap works, the original node_repl starts its JavaScript kernel (the code
the model writes in `js` calls) and its trusted worker (which hosts the Sky desktop service) with
`$CODEX_CLI_PATH sandbox ... -- COMMAND`. The sandbox's network-off seccomp filter also refuses
connect(2) to the X11 socket, so Sky cannot work inside it. LCU sets CODEX_CLI_PATH to this shim:

* the kernel is handed to the real `codex sandbox` exactly as node_repl asked;
* the trusted worker is run directly, outside the sandbox, only when it is positively identified
  as the selected runtime's worker hosting the selected runtime's Sky service; any other worker is
  handed to the real sandbox as asked;
* a `sandbox` invocation in any format this module does not recognise is refused with an error, so
  nothing the shim cannot classify ever starts, let alone starts unsandboxed;
* every other `codex` subcommand is passed through unchanged.

The shim never runs a command outside the sandbox unless it was identified as the worker.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import sys
import tomllib

CONFIG_ENV = 'LCU_SANDBOX_SHIM'
# Test-only: `unrecognized-kernel`, `unrecognized-worker` or `unrecognized-format` make the shim see
# that invocation in a format it does not recognise. LCU never sets it; it can only make the shim refuse.
FAULT_ENV = 'LCU_TEST_SANDBOX_SHIM_FAULT'

SANDBOX_PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"',
                  '-c', 'default_permissions="node_repl"']
PROFILE_KEY = 'permissions.node_repl='
SKY_SERVICE = '@oai/sky/service'
BROWSER_SERVICE = '@oai/browser-desktop/service'
SERVICE_PACKAGES = {SKY_SERVICE: '@oai/sky', BROWSER_SERVICE: '@oai/browser-desktop'}
NODE_FLAG = '--experimental-vm-modules'


class Unrecognized(ValueError):
    """A `sandbox` invocation whose format this shim does not know."""


def configuration(runtime: Path, codex: str, wrapper: Path | None) -> str:
    """The value LCU puts in CONFIG_ENV for the shim."""
    return json.dumps({'codex': str(codex), 'runtime': str(runtime),
                       'wrapper': str(wrapper) if wrapper else None})


def unshimmed_env(env: dict) -> dict:
    """A copy of `env` whose CODEX_CLI_PATH is the real Codex executable again."""
    restored = dict(env)
    try:
        restored['CODEX_CLI_PATH'] = json.loads(env[CONFIG_ENV])['codex']
    except (KeyError, ValueError, TypeError):
        pass
    return restored


def load_configuration(env) -> dict:
    try:
        config = json.loads(env[CONFIG_ENV])
    except (KeyError, ValueError):
        raise Unrecognized('the shim has no LCU configuration') from None
    if (not isinstance(config, dict) or not isinstance(config.get('codex'), str) or
            not isinstance(config.get('runtime'), str) or
            not (config.get('wrapper') is None or isinstance(config['wrapper'], str))):
        raise Unrecognized('the shim configuration is malformed')
    return config


def _real(path) -> str:
    return os.path.realpath(path)


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip('/') + '/')


def is_availability_probe(argv: list[str]) -> bool:
    """node_repl first runs a short `/bin/sh` command in the sandbox to learn whether it works.

    A refused probe would read as "no sandbox here" and leave the kernel unsandboxed, so any `/bin/sh`
    command passes through to the real sandbox untouched, whatever its other arguments.
    """
    return '--' in argv and argv[argv.index('--') + 1:][:1] == ['/bin/sh']


def parse_sandbox(argv: list[str]) -> tuple[dict, list[str]]:
    """Return (permission profile, command) for exactly the invocation node_repl makes."""
    head = len(SANDBOX_PREFIX)
    if (argv[:head] != SANDBOX_PREFIX or len(argv) < head + 4 or argv[head] != '-c' or
            not argv[head + 1].startswith(PROFILE_KEY) or argv[head + 2] != '--'):
        raise Unrecognized('unexpected sandbox arguments')
    try:
        profile = tomllib.loads('profile = ' + argv[head + 1][len(PROFILE_KEY):])['profile']
    except (tomllib.TOMLDecodeError, KeyError):
        raise Unrecognized('unreadable permission profile') from None
    if (not isinstance(profile, dict) or set(profile) - {'filesystem', 'network'} or
            not isinstance(profile.get('filesystem'), dict) or not isinstance(profile.get('network'), dict) or
            any(not isinstance(key, str) or not isinstance(value, str)
                for key, value in profile['filesystem'].items())):
        raise Unrecognized('unexpected permission profile shape')
    return profile, argv[head + 3:]


def classify(command: list[str], config: dict) -> str:
    """`kernel` or `worker`; raise Unrecognized for any other command."""
    runtime_node = config['runtime'] + '/bin/node'
    if (len(command) < 3 or command[1] != NODE_FLAG or not os.path.isabs(command[2]) or
            _real(command[0]) != _real(runtime_node)):
        raise Unrecognized('unexpected command')
    script = Path(command[2]).name
    if (script == 'kernel.js' and len(command) == 7 and command[3] == '--session-id' and
            command[5] == '--working-dir'):
        return 'kernel'
    if script == 'trusted-worker.js' and len(command) == 4 and os.path.isabs(command[3]):
        return 'worker'
    raise Unrecognized('unexpected script or arguments')


def _private(info) -> bool:
    """Not writable by others, nor by a group other than the account's own (umask 002 is common)."""
    return not info.st_mode & 0o002 and (not info.st_mode & 0o020 or info.st_gid == os.getegid())


def _service_package(runtime: str, specifier) -> bool:
    package = SERVICE_PACKAGES.get(specifier)
    if package is None:
        return False
    path = _real(f'{runtime}/lib/node_modules/{package}/package.json')
    return os.path.isfile(path) and _within(path, _real(runtime))


def identify_sky_worker(command: list[str], config: dict, env, parent_exe: str | None) -> str | None:
    """None when `command` is the selected runtime's trusted worker hosting its Sky service.

    Otherwise the reason it is not; the worker then stays in the sandbox.
    """
    runtime = config['runtime']
    node_repl = _real(runtime + '/bin/node_repl')
    if parent_exe != node_repl or not _within(node_repl, _real(runtime)):
        return "it was not started by the selected runtime's node_repl"
    node = _real(command[0])
    if node != _real(runtime + '/bin/node') or not _within(node, _real(runtime)):
        return "its Node is not the selected runtime's"
    script = Path(command[2])
    folder = script.parent
    try:
        folder_info, script_info = folder.lstat(), script.lstat()
        sibling = (folder / 'kernel.js').is_file()
    except OSError:
        return 'its script is not readable'
    if (not stat.S_ISDIR(folder_info.st_mode) or not stat.S_ISREG(script_info.st_mode) or
            folder_info.st_uid != os.geteuid() or script_info.st_uid != os.geteuid() or
            not (_private(folder_info) and _private(script_info)) or not sibling or
            not folder.name.startswith('.tmp') or
            str(folder.parent) != _real(env.get('TMPDIR') or '/tmp')):
        return "its script is not in node_repl's own temporary folder"
    raw = env.get('NODE_REPL_TRUSTED_SERVICES')
    try:
        services = json.loads(raw) if raw is not None else None
    except ValueError:
        services = None
    if (not isinstance(services, dict) or set(services) - {'sky', 'browser'} or
            any(not isinstance(value, str) for value in services.values())):
        return "the trusted services are not exactly the selected runtime's"
    sky, wrapper = services.get('sky'), config.get('wrapper')
    if sky is None:
        return 'it hosts no Sky service'
    if not (_service_package(runtime, sky) if sky == SKY_SERVICE else
            bool(wrapper) and sky == wrapper and os.path.isabs(wrapper) and _real(wrapper) == wrapper and
            os.path.isfile(wrapper)):
        return "its Sky service is not the selected runtime's"
    if 'browser' in services and not _service_package(runtime, services['browser']):
        return "its browser service is not the selected runtime's"
    return None


def decide(argv: list[str], env, parent_exe: str | None) -> tuple[str, list[str], str]:
    """Return (action, argv, note): `real` execs the real Codex, `direct` execs the command itself.

    Raises Unrecognized to refuse.
    """
    config = load_configuration(env)
    if argv[:1] != ['sandbox'] or is_availability_probe(argv):
        return 'real', argv, ''
    profile, command = parse_sandbox(argv)
    kind = classify(command, config)
    fault = env.get(FAULT_ENV, '')
    if fault in ('unrecognized-format', 'unrecognized-' + kind):
        parse_sandbox([part for part in argv if part != '--'])
    if kind == 'worker':
        reason = identify_sky_worker(command, config, env, parent_exe)
        if reason is None:
            return 'direct', command, ''
        return 'real', argv, f'the trusted worker stays sandboxed: {reason}'
    return 'real', argv, ''


def _parent_exe() -> str | None:
    try:
        return os.path.realpath(os.readlink(f'/proc/{os.getppid()}/exe'))
    except OSError:
        return None


def main(argv: list[str], env=os.environ, *, execv=os.execv, parent_exe=_parent_exe) -> int:
    try:
        action, target, note = decide(argv, env, parent_exe())
    except Unrecognized as exc:
        print('LCU: the original node_repl started its sandbox in a way this LCU release does not '
              f'recognise ({exc}). Refusing to start it, so the model\'s JavaScript is never left '
              'unsandboxed. Run `lcu update` for a release that knows this runtime; '
              'LCU_NODE_REPL_SANDBOX=off runs the JavaScript kernel without a sandbox.', file=sys.stderr)
        return 70
    if note:
        print(f'LCU: {note}.', file=sys.stderr)
    if action == 'direct':
        execv(target[0], target)
    else:
        codex = load_configuration(env)['codex']
        execv(codex, [codex, *target])
    return 0
