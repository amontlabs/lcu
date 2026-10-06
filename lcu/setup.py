"""Configure LCU tools, without requiring a running desktop."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
try:
    import fcntl
except ImportError:  # Windows uses msvcrt.locking.
    fcntl = None
import getpass
import json
import os
from pathlib import Path
try:
    import pwd
except ImportError:
    pwd = None
import shutil
import shlex
import subprocess
import sys
import tempfile
import uuid
from types import SimpleNamespace

from . import capture
from .setup_clients import CLIENTS, ALIASES


APP_DOWNLOAD_URL = 'https://chatgpt.com/download/'


def app_prerequisite_message(location=None, *, alternate_location=False):
    message = ('LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. '
               'LCU does not download or install the app.')
    if location is not None:
        message += f' No app was found at {location}.'
    message += f' Install it from {APP_DOWNLOAD_URL} and rerun LCU.'
    if alternate_location:
        message += ' If it is installed elsewhere, pass --existing-app PATH.'
    return message


@dataclass
class Change:
    path: Path
    before: bytes | None
    after: bytes | None


def regular_path(path):
    """Do not write through symlinks, including directory components."""
    path = Path(path).absolute()
    if '..' in path.parts or any(ord(c) < 32 for c in str(path)):
        raise ValueError(f'Use a path without parent traversal or control characters: {path}')
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ValueError(f'Refusing a symlink in setup destination: {item}. Use manual configuration instead.')
    return path


def read_file(path):
    regular_path(path)
    if path.exists():
        if not path.is_file():
            raise ValueError(f'Expected a regular file: {path}')
        return path.read_bytes()
    return None


def atomic_write(path, data):
    regular_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if data is None:
        path.unlink(missing_ok=True)
        return
    previous_mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix='.lcu-setup-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, previous_mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def apply_changes(changes):
    """Preflight everything; roll back our writes if a later write fails."""
    changes = [c for c in changes if c.before != c.after]
    for change in changes:
        if read_file(change.path) != change.before:
            raise ValueError(f'File changed during setup; retry: {change.path}')
    applied = []
    try:
        for change in changes:
            if read_file(change.path) != change.before:
                raise ValueError(f'File changed during setup; retry: {change.path}')
            atomic_write(change.path, change.after)
            applied.append(change)
    except BaseException:
        for change in reversed(applied):
            # Never undo a concurrent editor's changes.
            if read_file(change.path) == change.after:
                atomic_write(change.path, change.before)
        raise
    return len(changes)


@contextmanager
def setup_lock(home):
    path = regular_path((home / 'AppData/Local/LCU/setup.lock') if sys.platform == 'win32'
                        else (home / '.local/state/lcu/setup.lock'))
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if sys.platform == 'win32':
            import msvcrt
            # Lock byte 0 without writing it: a write into a range another handle
            # holds fails with a lock violation instead of waiting. Windows allows
            # locking past the end of the file.
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if sys.platform == 'win32':
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        os.close(fd)


def setup_state_path(home):
    """Per-account opt-in memory, beside setup.lock."""
    return regular_path((home / 'AppData/Local/LCU/setup.json') if sys.platform == 'win32'
                        else (home / '.local/state/lcu/setup.json'))


# Harnesses whose native registration needs their own executable; Codex and Claude Code
# register through add-mcp and their config files without the CLI installed.
NEEDS_BINARY = ('pi', 'omp', 'hermes')


def load_setup_state(home):
    """Return saved opt-ins and pending harnesses; tolerate a missing file, reject a malformed one."""
    path = setup_state_path(home)
    data = read_file(path)
    empty = {'chrome': False, 'audio': False, 'approval': 'ask', 'pending': [], 'pending_context': None}
    if data is None:
        return empty
    try:
        parsed = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError(f'Malformed LCU setup state at {path}; delete it and rerun setup.') from exc
    # `approval` and `pending` were added after `chrome` and `audio`; an older file means "ask" and none pending.
    pending = parsed.get('pending', []) if isinstance(parsed, dict) else None
    context = parsed.get('pending_context') if isinstance(parsed, dict) else None
    if (not isinstance(parsed, dict) or not all(isinstance(parsed.get(key), bool) for key in ('chrome', 'audio'))
            or parsed.get('approval', 'ask') not in ('ask', 'auto')
            or not isinstance(pending, list) or not all(item in NEEDS_BINARY for item in pending)
            or (context is not None and not (
                isinstance(context, dict) and context.get('scope') in ('user', 'project')
                and context.get('session') in ('discover', 'direct')
                and isinstance(context.get('project'), (str, type(None)))))):
        raise ValueError(f'Malformed LCU setup state at {path}; delete it and rerun setup.')
    return {'chrome': parsed['chrome'], 'audio': parsed['audio'], 'approval': parsed.get('approval', 'ask'),
            'pending': list(dict.fromkeys(pending)), 'pending_context': context if pending else None}


def save_setup_state(home, *, chrome, audio, approval='ask', pending=(), pending_context=None):
    pending = list(dict.fromkeys(pending))
    document = {'chrome': chrome, 'audio': audio, 'approval': approval}
    # Absent when nothing is pending, so the file stays readable by earlier LCU versions.
    if pending:
        document['pending'] = pending
        document['pending_context'] = pending_context
    atomic_write(setup_state_path(home), (json.dumps(document, indent=2) + '\n').encode())


def harness_search_path(home, path=None):
    """PATH plus the user-level directories harness installers use, for a harness installed after login."""
    path = os.environ.get('PATH', '') if path is None else path
    extra = [str(home / name) for name in ('.local/bin', '.bun/bin', '.npm-global/bin', '.cargo/bin')]
    return os.pathsep.join(dict.fromkeys([*[p for p in path.split(os.pathsep) if p], *extra]))


def harness_installed(name, home, path=None):
    return bool(shutil.which(CLIENTS[name].executable, path=harness_search_path(home, path)))


def installer_environment(home, names, environ=None):
    """Select a real account home; only honor profile overrides understood upstream."""
    env = dict(os.environ if environ is None else environ)
    rejected = {
        'claude-code': ('CLAUDE_CONFIG_DIR',),
        'gemini-cli': ('GEMINI_CLI_HOME',),
        'opencode': ('OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'),
        'copilot-cli': ('COPILOT_HOME',),
    }
    for name in names:
        for variable in rejected.get(name, ()):
            if env.get(variable):
                raise ValueError(f'{variable} is not supported by the bundled installers for {name}; unset it or use --export.')
    supported = []
    if 'codex' in names:
        supported.append('CODEX_HOME')
    if 'hermes' in names:
        supported.append('HERMES_HOME')
    if 'omp' in names:
        supported.append('PI_CODING_AGENT_DIR')
    if {'opencode', 'vscode', 'copilot-cli'} & set(names):
        supported.append('XDG_CONFIG_HOME')
    for variable in supported:
        if env.get(variable) and not Path(env[variable]).is_absolute():
            raise ValueError(f'{variable} must be absolute.')
    if 'copilot-cli' in names and env.get('XDG_CONFIG_HOME'):
        raise ValueError('XDG_CONFIG_HOME is not supported for Copilot CLI by the bundled installers; unset it or use --export.')
    env.update(HOME=str(home), DISABLE_TELEMETRY='1', DO_NOT_TRACK='1', NO_COLOR='1', CI='1')
    # Node flags can inject code; setup uses only the packaged runtime and CLIs.
    env.pop('NODE_OPTIONS', None)
    env.pop('NODE_PATH', None)
    return env


def installer_paths(tools_root):
    if sys.platform == 'win32':
        from .runtime import paths as selected_paths
        node = selected_paths(tools_root.parent)[2] / 'bin/node.exe'
    else:
        node = tools_root / 'node/bin/node'
    paths = (node,
             tools_root / 'node_modules/skills/bin/cli.mjs',
             tools_root / 'node_modules/add-mcp/dist/index.js')
    for path in paths:
        if not path.is_file():
            raise ValueError(f'Bundled agent installer missing: {path}. Rerun scripts/install.sh with this --prefix.')
    if not os.access(paths[0], os.X_OK):
        raise ValueError(f'Bundled Node runtime is not executable: {paths[0]}')
    return paths


# add-mcp 2.4.0 accepts malformed JSONC without checking parse errors. Keep this
# read-only guard until upstream fails closed. Paths and formats still come from
# its public adapter metadata; all configuration writes remain upstream-owned.
MCP_PREFLIGHT = r"""
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
try {
  const [cli, name, scope] = process.argv.slice(1);
  const require = createRequire(pathToFileURL(cli));
  const { agents } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
  const agent = agents[name];
  const local = scope === 'project';
  const cwd = process.cwd();
  const path = agent.resolveConfigPath ? agent.resolveConfigPath(agent, { local, cwd })
    : local ? join(cwd, agent.localConfigPath) : agent.configPath;
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
  let data;
  if (agent.format === 'toml') data = require('@iarna/toml').parse(text);
  else if (agent.format === 'json') {
    const jsonc = require('jsonc-parser');
    const errors = [];
    const tree = jsonc.parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`Malformed configuration: ${path}`);
    function checkDuplicates(node) {
      if (!node) return;
      if (node.type === 'object') {
        const keys = new Set();
        for (const property of node.children || []) {
          const key = property.children[0].value;
          if (keys.has(key)) throw new Error(`Duplicate configuration key in ${path}: ${key}`);
          keys.add(key);
        }
      }
      for (const child of node.children || []) checkDuplicates(child);
    }
    checkDuplicates(tree);
    data = jsonc.getNodeValue(tree);
  } else throw new Error(`Unsupported configuration format: ${agent.format}`);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(data)) throw new Error(`Configuration must be an object: ${path}`);
  const key = local && agent.localConfigKey ? agent.localConfigKey : agent.configKey;
  let current = data;
  for (const part of key.split('.')) {
    if (!Object.hasOwn(current, part)) break;
    current = current[part];
    if (!object(current)) throw new Error(`MCP configuration must be an object: ${path}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
"""


def preflight_mcp(node, mcp, client, scope, cwd, env):
    result = subprocess.run([str(node), '--input-type=module', '-e', MCP_PREFLIGHT,
                             str(mcp), client.mcp_agent, scope], cwd=cwd, env=env,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=20)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'MCP configuration preflight failed')


MCP_REGISTER = r"""
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [cli, agent, scope, commandJson, policyJson] = process.argv.slice(1);
const { agents, upsertServer } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
if (agent === 'codex') {
  const transform = agents.codex.transformConfig;
  const policy = JSON.parse(policyJson);
  agents.codex.transformConfig = (...args) => ({ ...transform(...args), ...policy });
}
const [command, ...args] = JSON.parse(commandJson);
const result = upsertServer(agent, 'lcu', { command, args }, { local: scope === 'project', cwd: process.cwd() });
if (!result.success) throw new Error(result.error);
console.log(JSON.stringify(result));
"""


def host_policy(release_root):
    """Use the shipped host contract, not reconstructed tool defaults."""
    resources = installed_app_resources(release_root)
    descriptor = resources / 'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json'
    server = json.loads(descriptor.read_text())['mcpServers']['cua_repl']
    # Codex replaces these launch fields at runtime. LCU supplies its own command.
    return {key: value for key, value in server.items() if key not in ('command', 'args', 'enabled')}


def installed_app_resources(release_root):
    """Resolve the selected installation without depending on release payload copies."""
    release_root = Path(release_root).resolve()
    if sys.platform == 'win32':
        from .runtime import paths
        return paths(release_root)[1]
    descriptor = release_root / 'installation.json'
    app = release_root / 'app'
    if not descriptor.is_file():
        raise ValueError(f'Installed application descriptor missing: {descriptor}')
    try:
        installation = json.loads(descriptor.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f'Invalid installed application descriptor: {descriptor}') from exc
    app_reference = installation.get('app') if isinstance(installation, dict) else None
    if not isinstance(app_reference, str) or not app_reference:
        raise ValueError(f'Installed application descriptor has no app reference: {descriptor}')
    try:
        described_app = (release_root / app_reference).resolve(strict=True)
        selected_app = app.resolve(strict=True)
    except OSError as exc:
        raise ValueError(f'Installed application path is incomplete: {release_root}') from exc
    if described_app != selected_app:
        raise ValueError(f'Installed application descriptor does not match selected app: {descriptor}')
    target = installation.get('platform', 'linux')
    if target not in ('linux', 'darwin'):
        raise ValueError(f'Unsupported installed application platform: {target}')
    resources = selected_app / ('Contents/Resources' if target == 'darwin' else 'resources')
    if not resources.is_dir():
        raise ValueError(f'Installed application resources missing: {resources}')
    return resources


def remove_generated_skill(home):
    """Delete the skill that earlier LCU versions generated for registration.

    Official Codex computer use registers no skill, so LCU no longer does.
    """
    root = (home / 'AppData/Local/LCU/skills') if sys.platform == 'win32' else (home / '.local/share/lcu/skills')
    generated = regular_path(root) / 'lcu'
    if generated.is_dir() and not generated.is_symlink():
        shutil.rmtree(generated)
        try:
            root.rmdir()
        except OSError:
            pass


# Descriptions used by the `lcu` skill that LCU 0.6.0 and earlier registered.
OLD_SKILL_MARKERS = ('original Codex computer-use runtime', 'LCU MCP computer-use tools')


def remove_old_skill(node, skills, cwd, env, global_args):
    """Remove the `lcu` skill registered by LCU 0.6.0 and earlier, and nothing else.

    The skill installer keeps a shared `.agents/skills` copy while any other
    detected agent could use it, so remove it for every agent, but only after
    confirming the installed skill is LCU's own.
    """
    def installer(*args):
        result = capture.run([str(node), str(skills), *args, *global_args], cwd=cwd, env=env, timeout=120)
        if result.returncode:
            detail = (result.stderr or result.stdout).strip()
            raise ValueError(f'skill installer exited {result.returncode}' + (f': {detail}' if detail else ''))
        return result
    result = installer('list', '--json')
    try:
        installed = json.loads(result.stdout or '[]')
        if not isinstance(installed, list):
            raise ValueError('not a list')
    except ValueError as exc:
        tail = result.stderr.strip()[-500:]
        raise ValueError(f'skill installer returned invalid JSON ({len(result.stdout.encode())} bytes)'
                         + (f': {tail}' if tail else '')) from exc
    entry = next((item for item in installed if isinstance(item, dict) and item.get('name') == 'lcu'), None)
    if entry is None:
        return 'none'
    skill = Path(str(entry.get('path', ''))) / 'SKILL.md'
    text = skill.read_text(errors='replace') if skill.is_file() else ''
    frontmatter = text.split('---', 2)[1] if text.startswith('---') and text.count('---') >= 2 else ''
    fields = dict(line.split(':', 1) for line in frontmatter.splitlines() if ':' in line)
    if (fields.get('name', '').strip() != 'lcu'
            or not any(marker in fields.get('description', '') for marker in OLD_SKILL_MARKERS)):
        return 'kept'
    installer('remove', 'lcu', '--yes')
    return 'removed'


def name_final_phase(name):
    """The registration phase after which a harness's approval mode is applied."""
    return 'extension' if name == 'pi' else 'MCP'


def configure(names, home, command, tools_root, release_root, *, scope='user', project=None, setup_command=None, environ=None, approval=None):
    """Delegate registration and return phase failures.

    approval is None (leave harness approval settings alone), "auto" or "ask" (see lcu.approval).
    """
    from . import approval as approvals
    env = installer_environment(home, names, environ)
    node, skills, mcp = installer_paths(tools_root)
    resources = installed_app_resources(release_root)
    original_plugins = resources / 'plugins/openai-bundled'
    cwd = project if scope == 'project' else home
    global_args = ['--global'] if scope == 'user' else []
    failures = []

    def describe(exc):
        # Expected failures carry their own message; anything else names its type.
        return str(exc) if isinstance(exc, (ValueError, OSError, subprocess.SubprocessError)) else f'{type(exc).__name__}: {exc}'

    def apply_approval(name, client, plan=None):
        if approval is None:
            return
        try:
            outcome = approvals.apply(approval, name, home, scope=scope, project=project, env=env, plan=plan)
            print(f'{client.label}: approval {approval}: {outcome}.')
        except Exception as exc:
            failures.append((name, 'approval', describe(exc)))
            print(f'{client.label}: approval failed: {describe(exc)}', file=sys.stderr)

    for name in names:
        client = CLIENTS[name]
        if name in ('omp', 'hermes'):
            from .harness_setup import configure_omp, configure_hermes
            try:
                if name == 'omp':
                    configure_omp(home, command, release_root,
                                  scope=scope, project=project, env=env)
                else:
                    configure_hermes(home, command, node, release_root,
                                     scope=scope, project=project, env=env)
                print(f'{client.label}: plugin registered.')
            except Exception as exc:
                failures.append((name, 'plugin', describe(exc)))
                print(f'{client.label}: plugin failed: {describe(exc)}', file=sys.stderr)
                continue
            apply_approval(name, client)
            continue
        mcp_command = command
        mcp_setup_error = None
        codex_plan = None
        if name == 'claude-code':
            adapter = release_root / 'adapters/claude.mjs'
            if not adapter.is_file():
                mcp_setup_error = (f'Claude MCP relay missing: {adapter}. '
                                   'Reinstall LCU into this release prefix, then rerun setup.')
            else:
                mcp_command = [str(node), str(adapter), *command]
        if name == 'codex':
            adapter = release_root / 'adapters/codex.mjs'
            audio_helper = release_root / 'adapters/audio-files.mjs'
            if not adapter.is_file() or not audio_helper.is_file():
                mcp_setup_error = (f'Codex audio relay missing: {adapter} or {audio_helper}. '
                                   'Reinstall LCU into this release prefix, then rerun setup.')
            else:
                mcp_command = [str(node), str(adapter), *command]
            from .codex_hooks import require_cli_hook_support
            try:
                require_cli_hook_support(env)
                # Registration replaces `[mcp_servers.lcu]`; read the previous approval value first.
                codex_plan = approvals.codex_plan(approval, home, scope=scope, project=project, env=env)
            except Exception as exc:
                failures.append((name, 'host', describe(exc)))
                print(f'{client.label}: host failed: {describe(exc)}', file=sys.stderr)
                continue
        # Earlier LCU versions registered an `lcu` skill; official Codex computer
        # use has none, so remove it.
        cleanup_command = None
        if name == 'pi':
            pi = shutil.which('pi', path=env.get('PATH'))
            pi_root = (home / 'AppData/Local/LCU/pi') if sys.platform == 'win32' else (home / '.local/share/lcu/pi')
            extension = pi_root / 'extension.mjs'
            selected_command = pi_root / 'commands.json'
            commands = (('old skill cleanup', cleanup_command),
                        ('extension', [pi, 'install', *([] if scope == 'user' else ['-l']), str(extension)]))
        else:
            commands = (('old skill cleanup', cleanup_command),
                        ('MCP', [str(node), '--input-type=module', '-e', MCP_REGISTER, str(mcp),
                                 client.mcp_agent, scope, json.dumps(mcp_command),
                                 json.dumps(approvals.merge_codex_policy(
                                     host_policy(release_root), codex_plan['policy'] if codex_plan else {}))]))
        for phase, argv in commands:
            if phase == 'old skill cleanup':
                # Best-effort legacy cleanup: a failure here must not fail setup.
                try:
                    outcome = remove_old_skill(node, skills, cwd, env, global_args)
                except Exception as exc:
                    print(f'{client.label}: skipped old LCU skill cleanup: {describe(exc)}', file=sys.stderr)
                    continue
                if outcome == 'removed':
                    print(f'{client.label}: old LCU skill removed.')
                elif outcome == 'kept':
                    print(f'{client.label}: kept an `lcu` skill that LCU did not create.')
                continue
            try:
                if phase == 'MCP':
                    if mcp_setup_error:
                        raise ValueError(mcp_setup_error)
                    preflight_mcp(node, mcp, client, scope, cwd, env)
                if phase == 'extension':
                    if not pi:
                        raise ValueError('Pi is not on the target account PATH. Install Pi, then run '
                                         f'`{setup_command or "lcu"} setup --agent pi --yes` from that account shell.')
                    adapter = release_root / 'adapters/pi/index.ts'
                    if not adapter.is_file():
                        raise ValueError(f'LCU Pi adapter missing: {adapter}')
                    wrapper = ('import lcu from ' + json.dumps(adapter.as_uri()) + ';\n'
                               'import {readFileSync, realpathSync} from "node:fs";\n'
                               'const config = JSON.parse(readFileSync('
                               + json.dumps(str(selected_command)) + ', "utf8"));\n'
                               'export default pi => lcu(pi, {command: '
                               'config.projects?.[realpathSync(process.cwd())] ?? config.user});\n').encode()
                    previous = read_file(selected_command)
                    config = json.loads(previous) if previous else {'projects': {}}
                    if not isinstance(config, dict) or not isinstance(config.get('projects'), dict):
                        raise ValueError(f'Invalid LCU Pi command configuration: {selected_command}')
                    if scope == 'user':
                        config['user'] = command
                    else:
                        config['projects'][str(project.resolve(strict=True))] = command
                    apply_changes([Change(extension, read_file(extension), wrapper),
                                   Change(selected_command, previous, (json.dumps(config, indent=2) + '\n').encode())])
                phase_env = {**env, 'PI_OFFLINE': '1'} if phase == 'extension' else env
                result = subprocess.run(argv, cwd=cwd, env=phase_env, stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True,
                                        encoding='utf-8', errors='replace', timeout=120)
                if result.returncode:
                    # Upstream diagnostics are shown to the invoking user, never stored.
                    detail = (result.stderr or result.stdout).strip()
                    raise ValueError(f'installer exited {result.returncode}' + (f': {detail}' if detail else ''))
                if name == 'codex':
                    from .codex_hooks import install_hooks
                    from .app_layout import locate_codex_tools
                    registered = json.loads(result.stdout)
                    if not isinstance(registered, dict) or not isinstance(registered.get('path'), str):
                        detail = (result.stdout or result.stderr).strip()
                        raise ValueError('Codex registration returned unexpected output' + (f': {detail}' if detail else ''))
                    cli = locate_codex_tools(resources, windows=sys.platform == 'win32').cli
                    install_hooks(cli, Path(registered['path']), cwd, env, original_plugins, setup_command)
                elif name == 'claude-code' and phase == 'MCP':
                    from .claude_visibility import install as hide_host_only_tools
                    hide_host_only_tools(home, project=project if scope == 'project' else None)
                    from .claude_mod import install as install_approval_mod
                    mod = install_approval_mod(home, release_root, project=project if scope == 'project' else None)
                    print(f'{client.label}: approval mod installed at {mod}.')
                print(f'{client.label}: {phase} registered.')
                if phase == name_final_phase(name):
                    apply_approval(name, client, codex_plan)
            except Exception as exc:
                failures.append((name, phase, describe(exc)))
                print(f'{client.label}: {phase} failed: {describe(exc)}', file=sys.stderr)
    return failures


def export_bundle(destination, command, release_root, *, chrome=False, audio=False):
    destination = regular_path(destination)
    if destination.exists():
        raise ValueError('Export destination already exists; choose a new directory.')
    policy = host_policy(release_root)
    # Re-run flags for the destinationSetup metadata.
    setup_flags = ('--chrome ' if chrome else '') + ('--audio ' if audio else '')
    installation = json.loads((Path(release_root) / 'installation.json').read_text())
    target = installation.get('platform', 'linux')
    resource_root = 'Contents/Resources' if target == 'darwin' else 'resources'
    manifest = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
                'name': 'lcu', 'description': 'Computer use through the locally installed Codex runtime.'}
    # A cross-machine export cannot retain the producer's prefix or account.
    # Resolve the destination's selected release when its MCP client starts.
    launch = ('set -eu; case "$(uname -s)" in '
              'Darwin) default_prefix="$HOME/.local/share/lcu"; default_session=direct;; '
              'Linux) default_prefix=/opt/lcu; default_session=discover;; '
              '*) echo "Unsupported LCU platform" >&2; exit 2;; esac; '
              'prefix=${LCU_PREFIX:-$default_prefix}; '
              'case "$prefix" in /*) ;; *) echo "LCU_PREFIX must be absolute" >&2; exit 2;; esac; '
              'case "${LCU_SESSION_MODE:-$default_session}" in '
              'direct) exec "$prefix/current/bin/lcu" "$@";; '
              'discover) exec "$prefix/current/bin/lcu-session" --user "$(id -un)" -- '
              '"$prefix/current/bin/lcu" "$@";; '
              '*) echo "LCU_SESSION_MODE must be discover or direct" >&2; exit 2;; esac')
    runtime_flags = (['--chrome'] if chrome else []) + (['--audio'] if audio else [])
    portable_command = ['/bin/sh', '-c', launch, 'lcu-export', *runtime_flags]
    codex_launch = ('set -eu; case "$(uname -s)" in '
                    'Darwin) default_prefix="$HOME/.local/share/lcu"; default_session=direct;; '
                    'Linux) default_prefix=/opt/lcu; default_session=discover;; '
                    '*) echo "Unsupported LCU platform" >&2; exit 2;; esac; '
                    'prefix=${LCU_PREFIX:-$default_prefix}; '
                    'case "$prefix" in /*) ;; *) echo "LCU_PREFIX must be absolute" >&2; exit 2;; esac; '
                    'node="$prefix/current/agent-tools/node/bin/node"; '
                    'adapter="$prefix/current/adapters/codex.mjs"; '
                    'server="$prefix/current/bin/lcu"; '
                    'case "${LCU_SESSION_MODE:-$default_session}" in '
                    'direct) exec "$node" "$adapter" "$server" "$@";; '
                    'discover) exec "$prefix/current/bin/lcu-session" --user "$(id -un)" -- '
                    '"$node" "$adapter" "$server" "$@";; '
                    '*) echo "LCU_SESSION_MODE must be discover or direct" >&2; exit 2;; esac')
    portable_codex_command = ['/bin/sh', '-c', codex_launch, 'lcu-export', *runtime_flags]
    mcp = {'mcpServers': {'lcu': {'type': 'stdio', 'command': portable_command[0],
                                 'args': portable_command[1:]}}}
    changes = [Change(destination / 'plugin.json', None, (json.dumps(manifest, indent=2) + '\n').encode()),
               Change(destination / 'mcp.json', None, (json.dumps(mcp, indent=2) + '\n').encode()),
               Change(destination / 'host-contract.json', None, (json.dumps(policy, indent=2) + '\n').encode())]
    bootstrap_metadata = {
        'requiresInstalledApplication': True,
        'computerAudioOptIn': ('Enabled in the registered MCP command with --audio. The original optional recording API may require its own approval. A saved audio file does not mean the selected model receives audio. LCU does not add audio-specific instructions.'
                               if audio else 'Disabled unless the caller explicitly sets both original audio environment flags.'),
        'applicationResourceRoot': resource_root,
        'destinationSetup': ('Install the matching thin LCU archive and selected application, then run '
                             'lcu setup --export /new/path ' + setup_flags
                             + '--yes on the destination account and import that newly generated export.'),
        'runtimePrefix': 'Set LCU_PREFIX for a nondefault destination prefix: /opt/lcu on Linux, $HOME/.local/share/lcu on macOS.',
        'sessionMode': 'Linux defaults to XFCE discovery; set LCU_SESSION_MODE=direct inside its desktop session. macOS defaults to direct.',
        'instructions': 'The original MCP server instructions, tool descriptions and tool results, as in official Codex; no skill.',
    }
    changes.append(Change(destination / 'lcu-bootstrap.json', None,
                          (json.dumps(bootstrap_metadata, indent=2) + '\n').encode()))
    codex = {'mcpServers': {'lcu': {**policy, 'command': portable_codex_command[0],
                                   'args': portable_codex_command[1:]}}}
    changes.append(Change(destination / 'codex.mcp.json', None, (json.dumps(codex, indent=2) + '\n').encode()))
    from .codex_hooks import export_files
    resources = installed_app_resources(release_root)
    original_plugins = resources / 'plugins/openai-bundled'
    changes += [Change(destination / name, None, data)
                for name, data in export_files(portable_codex_command, original_plugins).items()]
    apply_changes(changes)


def parser():
    p = argparse.ArgumentParser(description=__doc__, epilog='Run on the machine hosting the agent backend. For Codex SSH remote projects, that is the VM. This command never installs or authenticates the agent itself.')
    p.add_argument('--prefix', type=Path,
                   default=(Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'LCU')
                   if sys.platform == 'win32' else (Path.home() / '.local/share/lcu' if sys.platform == 'darwin' else Path('/opt/lcu')),
                   help='Runtime prefix (Linux: /opt/lcu; macOS: ~/.local/share/lcu; Windows: %%LOCALAPPDATA%%\\LCU)')
    p.add_argument('--user', help='Target account; root must select one explicitly')
    p.add_argument('--agent', action='append', default=[], help='Agent ID; repeat for several, all for every supported client, or auto for detected clients. Use --list-agents.')
    p.add_argument('--scope', choices=['user', 'project'], default='user')
    p.add_argument('--project', type=Path, help='Absolute existing project directory for project scope')
    p.add_argument('--yes', action='store_true', help='Apply explicit choices without a confirmation prompt')
    p.add_argument('--list-agents', action='store_true', help='List supported adapters and exit')
    p.add_argument('--export', type=Path, help='Export a portable tools plugin for custom clients to a new directory')
    p.add_argument('--chrome', action='store_true', help='Opt into original Chrome control, extension connector, and browser guidance')
    p.add_argument('--no-chrome', action='store_true', help='Disable Chrome control, overriding a saved opt-in')
    p.add_argument('--audio', action='store_true', help='Opt into the original optional computer-audio recording API')
    p.add_argument('--no-audio', action='store_true', help='Disable computer-audio recording, overriding a saved opt-in')
    p.add_argument('--approval', choices=['ask', 'auto'],
                   help='optional, for unattended machines: auto adds only LCU\'s own harness approval entries so its tools run without a per-call prompt (per-app approval stays); '
                        'ask removes exactly those entries and leaves harness defaults (the default, kept from the previous setup)')
    p.add_argument('--session', choices=['discover', 'direct'], default='direct' if sys.platform in ('darwin', 'win32') else 'discover', help='discover attaches through lcu-session (XFCE); direct uses the current desktop account')
    p.add_argument('--allow-missing', action='store_true',
                   help='Skip pi, omp and hermes when their executable is not installed yet and record them as pending '
                        '(Codex and Claude Code still register); exit 0 when that is the only problem. '
                        '`lcu setup --reconcile` registers them once they appear')
    p.add_argument('--reconcile', action='store_true',
                   help='Register pending harnesses that are now installed, using the saved opt-ins and approval mode; '
                        'non-interactive, idempotent, and silent when there is nothing to do')
    p.add_argument('--browser-host', action='store_true', help=argparse.SUPPRESS)
    p.add_argument('--check-desktop', action='store_true',
                   help='Require live desktop readiness after setup; never opens System Settings automatically')
    p.add_argument('--validate-only', action='store_true', help=argparse.SUPPRESS)
    return p


def validate(args):
    if args.browser_host:
        raise ValueError('--browser-host was removed; use `lcu setup --agent AGENT --chrome` for external Chrome. Embedded in-app browser hosting is not supported.')
    if args.reconcile:
        used = [flag for flag, value in (
            ('--agent', args.agent), ('--export', args.export), ('--approval', args.approval),
            ('--chrome', args.chrome), ('--no-chrome', args.no_chrome), ('--audio', args.audio),
            ('--no-audio', args.no_audio), ('--project', args.project), ('--check-desktop', args.check_desktop),
            ('--allow-missing', args.allow_missing), ('--scope', args.scope != 'user')) if value]
        if used:
            raise ValueError('--reconcile uses the saved setup and cannot be combined with ' + ', '.join(used) + '.')
    if args.allow_missing and args.export:
        raise ValueError('--allow-missing configures a harness; it cannot be combined with --export.')
    if args.chrome and args.no_chrome:
        raise ValueError('Use either --chrome or --no-chrome, not both.')
    if args.audio and args.no_audio:
        raise ValueError('Use either --audio or --no-audio, not both.')
    prefix = args.prefix
    if not prefix.is_absolute() or len(prefix.parts) < 3 or '..' in prefix.parts or any(ord(c) < 32 for c in str(prefix)):
        raise ValueError('Use a dedicated absolute prefix, such as /opt/lcu.')
    if sys.platform == 'win32':
        username = getpass.getuser()
        if args.user and args.user.casefold() != username.casefold():
            raise ValueError('Windows setup only configures the current signed-in account.')
        account = SimpleNamespace(pw_name=username, pw_uid=None,
                                  pw_dir=os.environ.get('USERPROFILE', str(Path.home())))
        if args.session != 'direct':
            raise ValueError('Windows requires --session direct.')
        if args.export:
            raise ValueError('Windows portable export is not implemented; select --agent instead.')
    else:
        if os.getuid() == 0 and args.user is None:
            raise ValueError('Root must specify --user ACCOUNT.')
        try:
            account = pwd.getpwnam(args.user) if args.user else pwd.getpwuid(os.getuid())
        except KeyError:
            raise ValueError('The selected account does not exist. Create it before setup.') from None
        if os.getuid() not in (0, account.pw_uid):
            raise ValueError('Run as the selected account or root.')
    if not Path(account.pw_dir).is_absolute() or not Path(account.pw_dir).is_dir():
        raise ValueError('Selected account must have an existing absolute home directory.')
    if args.scope == 'project':
        if not args.project or not args.project.is_absolute() or not args.project.is_dir():
            raise ValueError('--scope project requires --project with an existing absolute directory.')
    elif args.project:
        raise ValueError('--project requires --scope project.')
    if args.export and args.agent:
        raise ValueError('Choose --export or --agent, not both.')
    if args.export and args.approval:
        raise ValueError('--approval configures a harness; it cannot be combined with --export.')
    if args.export:
        if not args.export.is_absolute():
            raise ValueError('--export requires an absolute path.')
        regular_path(args.export)
        if args.export.exists():
            raise ValueError('Export destination already exists; choose a new directory.')
    names = list(dict.fromkeys(ALIASES.get(name, name) for name in args.agent))
    unknown = set(names) - set(CLIENTS) - {'auto', 'all'}
    if unknown:
        raise ValueError('Unknown agent: ' + ', '.join(sorted(unknown)) + '. Run lcu setup --list-agents, or use --export for a custom client.')
    if {'auto', 'all'} & set(names) and len(names) > 1:
        raise ValueError('Use --agent all or --agent auto alone, or select explicit agent IDs.')
    if names == ['all']:
        names = list(CLIENTS)
    if names != ['auto']:
        validate_agent_scope(names, args.scope)
    return account, names


# Native harness plugins are profile-scoped; project scope is unsupported.
USER_ONLY_AGENTS = frozenset({'omp', 'hermes'})


def agent_scopes(name):
    return 'user' if name in USER_ONLY_AGENTS else 'user, project'


def validate_agent_scope(names, scope):
    if scope == 'project' and USER_ONLY_AGENTS & set(names):
        raise ValueError('Oh My Pi and Hermes native plugins are profile-scoped. Use --scope user with the intended profile; project scope is not supported.')


def detect(home):
    return [name for name, client in CLIENTS.items()
            if shutil.which(client.executable) or (home / client.detect_path).exists()]


def choose_agents(home):
    detected = detect(home)
    print('Select one or more agents for this account (comma-separated IDs).')
    for name, client in CLIENTS.items():
        print(f'  {name:16} {client.label}' + (' [detected]' if name in detected else ''))
    print('Use all for every supported client, including those not installed yet.\nFor other clients, cancel and use --export /absolute/new/plugin-directory.')
    answer = input('Agents: ').strip()
    names = list(dict.fromkeys(ALIASES.get(n.strip(), n.strip()) for n in answer.split(',') if n.strip()))
    if names == ['all']:
        return list(CLIENTS)
    if names == ['auto']:
        names = detected
    if not names or any(name not in CLIENTS for name in names):
        raise ValueError('Choose supported agent IDs, or use --export for a custom client.')
    return names



def desktop_readiness_mode(args, *, interactive):
    if args.check_desktop:
        return 'required'
    if args.export:
        return 'skip'
    if args.yes or not interactive:
        return 'deferred'
    return 'guided'


def desktop_readiness_request(args, *, interactive, desktop_command):
    """Choose the post-registration doctor invocation and timeout."""
    mode = desktop_readiness_mode(args, interactive=interactive)
    if mode == 'skip':
        return mode, None, None
    doctor = [*desktop_command, 'doctor']
    if mode == 'required':
        return mode, [*doctor, '--non-interactive', '--require-ready'], 50
    # Guided and deferred both run the plain doctor without a bounded timeout;
    # a person may need as long as they like to read settings guidance.
    return mode, doctor, None


def run_desktop_doctor(command, *, timeout=None, runner=None):
    """Run a doctor check with bounded time only when no human interaction is needed."""
    if runner is None:
        runner = subprocess.run
    options = {'check': False}
    if timeout is not None:
        options['timeout'] = timeout
    return runner(command, **options)


def runtime_paths(args, account, session=None):
    """Release root, runtime launcher, session launcher and the desktop command for the selected session mode."""
    session = session or args.session
    if sys.platform == 'win32':
        release_root = Path(__file__).resolve().parents[1]
        runtime = args.prefix / 'lcu.cmd'
        launcher = args.prefix / 'windows_launcher.py'
        desktop_command = [sys.executable, '-B', str(launcher)]
    else:
        release_root = args.prefix / 'current'
        runtime = release_root / 'bin/lcu'
        launcher = release_root / 'bin/lcu-session'
        desktop_command = ([str(runtime)] if session == 'direct' else
                           [str(launcher), '--user', account.pw_name, '--', str(runtime)])
    return release_root, runtime, launcher, desktop_command


def reconcile(args, account, home):
    """Register pending harnesses that have appeared since setup; quiet and cheap when there are none."""
    path = harness_search_path(home)

    def ready_harnesses(state):
        return [name for name in state['pending'] if harness_installed(name, home, path)]

    try:
        # Unlocked first look: the common login-time run reads one small file and exits.
        if not ready_harnesses(load_setup_state(home)):
            return
        with setup_lock(home):
            # Another setup or reconcile may have registered them while this one waited.
            state = load_setup_state(home)
            ready = ready_harnesses(state)
            if not ready:
                return
            context = state['pending_context'] or {'scope': 'user', 'project': None, 'session': args.session}
            project = Path(context['project']) if context['project'] else None
            if context['scope'] == 'project' and (not project or not project.is_dir()):
                raise ValueError(f'Saved project directory is missing: {context["project"]}. '
                                 'Rerun `lcu setup --agent all --allow-missing --scope project --project PATH`.')
            release_root, runtime, launcher, desktop_command = runtime_paths(args, account, context['session'])
            for item in (runtime, launcher):
                if not item.is_file() or not os.access(item, os.X_OK):
                    raise ValueError(f'Managed runtime missing or inaccessible: {item}.')
            runtime_flags = (['--chrome'] if state['chrome'] else []) + (['--audio'] if state['audio'] else [])
            direct_runtime = desktop_command if sys.platform == 'win32' else [str(runtime)]
            subprocess.run(direct_runtime + ['--version'], check=True, timeout=20, stdout=subprocess.DEVNULL)
            tools_root = release_root / 'agent-tools'
            environment = {**os.environ, 'PATH': path}
            installer_environment(home, ready, environment)
            installer_paths(tools_root)
            print('LCU: registering ' + ', '.join(CLIENTS[name].label for name in ready)
                  + ' (installed since setup) with the saved settings.')
            failures = configure(ready, home, [*desktop_command, *runtime_flags], tools_root, release_root,
                                 scope=context['scope'], project=project, setup_command=str(runtime),
                                 environ=environment, approval='auto' if state['approval'] == 'auto' else None)
            failed = {item[0] for item in failures}
            remaining = [name for name in state['pending'] if name not in ready or name in failed]
            save_setup_state(home, chrome=state['chrome'], audio=state['audio'], approval=state['approval'],
                             pending=remaining, pending_context=context)
            if failures:
                raise ValueError(f'{len(failures)} registration step(s) failed; still pending: '
                                 + ', '.join(remaining) + '. Fix the errors above; the next reconcile retries.')
            print('Registered: ' + ', '.join(ready) + '. Restart or reconnect those harnesses.')
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        parser().exit(1, f'Reconcile failed: {exc}\n')


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    if args.list_agents:
        for name, client in CLIENTS.items():
            print(f'{name:16} {client.label} ({agent_scopes(name)})')
        print('Custom clients: --export /absolute/new/plugin-directory')
        return
    try:
        account, names = validate(args)
        if args.validate_only:
            if not args.export:
                # Another account must never inherit the caller's profile overrides.
                environment = ({} if sys.platform != 'win32' and os.getuid() == 0 and account.pw_uid != 0
                               else os.environ)
                installer_environment(Path(account.pw_dir), names, environment)
            return
        # Account files are always written as their owner, including image builds.
        if sys.platform != 'win32' and os.getuid() == 0 and account.pw_uid != 0:
            os.initgroups(account.pw_name, account.pw_gid)
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
            os.environ.clear()
            os.environ.update(HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name,
                              PATH=f'{account.pw_dir}/.local/bin:/usr/local/bin:/usr/bin:/bin', LANG='C.UTF-8')
            os.chdir(account.pw_dir)
        home = Path(account.pw_dir)
        if args.reconcile:
            return reconcile(args, account, home)
        release_root, runtime, launcher, desktop_command = runtime_paths(args, account)
        for path in (runtime, launcher):
            if not path.is_file() or not os.access(path, os.X_OK):
                raise ValueError(f'Managed runtime missing or inaccessible: {path}. Run scripts/install.sh first, or select its --prefix.')
        if names == ['auto']:
            names = detect(home)
            if not names and not args.allow_missing:
                raise ValueError('No agents detected. Select --agent explicitly (works before the agent is installed), or use --export.')
        if not names and not args.export:
            if not sys.stdin.isatty():
                raise ValueError('Noninteractive setup requires --agent ID (repeatable), --agent all, --agent auto, or --export PATH.')
            names = choose_agents(home)
        validate_agent_scope(names, args.scope)
        missing = []
        setup_environment = None
        if args.allow_missing:
            # Registration through each harness's own CLI needs that CLI; defer those harnesses.
            setup_environment = {**os.environ, 'PATH': harness_search_path(home)}
            missing = [name for name in names if name in NEEDS_BINARY and not harness_installed(name, home)]
            names = [name for name in names if name not in missing]
        direct_runtime = desktop_command if sys.platform == 'win32' else [str(runtime)]
        subprocess.run(direct_runtime + ['--version'], check=True, timeout=20, stdout=subprocess.DEVNULL)
        tools_root = release_root / 'agent-tools'
        if not args.export:
            installer_environment(home, names)
            installer_paths(tools_root)
        setup_command = str(runtime)
        with setup_lock(home):
            state = load_setup_state(home)
            # A saved choice, including a declined prompt, suppresses the prompt.
            saved = setup_state_path(home).is_file()
            # Explicit flags win; otherwise a saved opt-in is kept.
            if args.audio:
                audio = True
            elif args.no_audio:
                audio = False
            elif state['audio']:
                audio = True
                print('Keeping computer-audio recording enabled from the previous setup (use --no-audio to disable).')
            else:
                audio = False
            if args.chrome:
                chrome = True
            elif args.no_chrome:
                chrome = False
            elif state['chrome']:
                chrome = True
                print('Keeping Chrome control enabled from the previous setup (use --no-chrome to disable).')
            elif not saved and not args.yes and sys.stdin.isatty():
                chrome = input('Enable Chrome browser control and its extension connector? [y/N] ').strip().lower() in ('y', 'yes')
            else:
                chrome = False
            args.chrome, args.audio = chrome, audio
            # `ask` keeps harness defaults. A saved `auto` is reapplied to each harness and scope
            # selected now; an explicit `--approval ask` is the only thing that removes entries.
            if args.approval:
                approval_mode = args.approval
            elif state['approval'] == 'auto':
                approval_mode = 'auto'
                print('Keeping automatic approval of LCU tools from the previous setup (use --approval ask to restore harness defaults).')
            else:
                approval_mode = 'ask'
            approval_action = 'auto' if approval_mode == 'auto' else ('ask' if args.approval == 'ask' else None)
            runtime_flags = (['--chrome'] if chrome else []) + (['--audio'] if audio else [])
            command = [*desktop_command, *runtime_flags]
            if args.export:
                print(f'Export tools to {args.export}')
            else:
                if missing:
                    for name in missing:
                        print(f'{CLIENTS[name].label}: not installed; will register when it appears '
                              f'(`{setup_command} setup --reconcile` registers it with these settings).')
                if names:
                    print(f'Configure {", ".join(names)} for {account.pw_name} ({args.scope} scope).')
                print('Existing LCU MCP entries will be updated and any old LCU skill removed; unrelated configuration is preserved.')
                if 'codex' in names:
                    print('Codex: install and trust the original Stop, Interrupt, and SubagentStop cleanup hooks for LCU.')
            if args.chrome:
                print('Chrome control selected: register the original extension connector for this desktop account and include Chrome guidance.')
                if 'claude-code' in names:
                    print('Claude Code: original turn cleanup runs on normal Stop and active MCP-call cancellation. Esc during model wait after a tool completes has no cleanup event and may leave temporary tabs open; Chrome remains experimental.')
            else:
                print('Native desktop control selected; Chrome connector and guidance are excluded.')
            if approval_mode == 'auto' and not args.export:
                entries = {'claude-code': 'Claude Code: allow `mcp__lcu__js` and `mcp__lcu__js_reset`',
                           'codex': 'Codex: `approval_mode = "approve"` for the `js` and `js_reset` tools of `[mcp_servers.lcu]`',
                           'omp': 'Oh My Pi: `tools.approval` `js` and `js_reset` set to `allow`'}
                chosen = [entries[name] for name in names if name in entries]
                print('Approval mode auto: add only LCU\'s own entries so its tools run without a per-call harness prompt'
                      + (': ' + '; '.join(chosen) if chosen else '') + '. '
                      + ('Pi and Hermes have no such gate. ' if {'pi', 'hermes'} & set(names) else '')
                      + 'Native-app and Chrome approvals from the original runtime are unchanged.')
            elif approval_action == 'ask' and not args.export:
                print('Approval mode ask: remove only the entries `--approval auto` added, restoring harness defaults.')
            if args.audio:
                print('Computer audio selected: enable the original optional recording API and its approval flow. A saved audio file is not model audio input.')
            if sys.platform == 'win32' and 'claude-code' in names:
                print('Claude Code: original turn cleanup runs on normal Stop and active MCP-call cancellation. Esc during model wait after a tool completes has no cleanup event and may leave native helpers active.')
            from .tested import report as report_tested_pair
            report_tested_pair(release_root)
            if not args.yes:
                if not sys.stdin.isatty():
                    raise ValueError('Review the selection above, then rerun with --yes for noninteractive setup.')
                if input('Apply this setup? [y/N] ').strip().lower() not in ('y', 'yes'):
                    print('Cancelled; no agent configuration changed.')
                    return
            if args.chrome:
                # The original native host is a per-account browser connection.
                from .browser import install as install_browser_host
                install_browser_host(release_root)
            remove_generated_skill(home)
            failures = []
            if args.export:
                export_bundle(args.export, command, release_root, chrome=chrome, audio=audio)
            else:
                failures = configure(names, home, command, tools_root, release_root,
                                     scope=args.scope, project=args.project,
                                     setup_command=setup_command, approval=approval_action,
                                     environ=setup_environment) if names else []
            # Remember opt-ins even when registration failed, so a retry or `--reconcile` keeps them.
            # Harnesses registered now leave the pending set; a later reconcile applies the saved
            # chrome, audio and approval mode to the rest. A pending harness whose registration failed
            # stays pending.
            failed = list(dict.fromkeys(item[0] for item in failures))
            pending = [] if args.export else [name for name in dict.fromkeys([*state['pending'], *missing])
                                              if name not in names or name in failed]
            save_setup_state(home, chrome=chrome, audio=audio, approval=approval_mode, pending=pending,
                             pending_context=({'scope': args.scope, 'session': args.session,
                                               'project': str(args.project) if args.project else None}
                                              if missing else state['pending_context']) if pending else None)
            if failures:
                retry = [*direct_runtime, 'setup', '--prefix', str(args.prefix), '--user', account.pw_name,
                         '--scope', args.scope, '--session', args.session, '--yes']
                if args.project:
                    retry += ['--project', str(args.project)]
                retry += ['--chrome'] if chrome else ['--no-chrome']
                retry += ['--audio'] if audio else ['--no-audio']
                # A defaulted `ask` must not be passed: it would remove approval entries.
                if args.approval or approval_mode == 'auto':
                    retry += ['--approval', approval_mode]
                if args.allow_missing:
                    retry += ['--allow-missing']
                for name in failed:
                    retry += ['--agent', name]
                steps = ', '.join(f'{item[0]}: {item[1]}' for item in failures)
                raise ValueError(f'{len(failures)} registration step(s) failed ({steps}). Choices were saved; '
                                 'completed steps remain installed. After resolving the errors, retry: '
                                 + shlex.join(retry))
            if not args.export and (missing or pending):
                print('Registered now: ' + (', '.join(names) or 'none') + '.')
                print('Pending (not installed): ' + (', '.join(pending) or 'none')
                      + f'. Install them, then run `{setup_command} setup --reconcile` (safe at every login).')
        print('Configuration prepared. Restart/reconnect the selected agent, then ask it to use LCU to inspect the desktop.')
        if sys.platform == 'darwin' and not args.export:
            from .platforms import mac_socket_path_problem
            problem = mac_socket_path_problem()
            if problem:
                print(f'Warning: {problem}')
        if args.chrome:
            try:
                browser_status = subprocess.run(direct_runtime + ['browser', 'status'],
                                                capture_output=True, text=True, timeout=20)
                if browser_status.stdout.strip():
                    print(browser_status.stdout.strip())
                if browser_status.returncode and not browser_status.stdout.strip():
                    print(f'Browser status unavailable; run `{setup_command} browser status` after setup.')
            except (OSError, subprocess.SubprocessError):
                print(f'Browser status unavailable; run `{setup_command} browser status` after setup.')
        else:
            print(f'Chrome browser control not enabled; add it later with `{setup_command} setup --agent AGENT --chrome`; other saved opt-ins are kept.')
        if not args.audio:
            print(f'Computer-audio recording not enabled; add it later with `{setup_command} setup --agent AGENT --audio`; other saved opt-ins are kept.')
        if args.export:
            print('Import this plugin with a compatible client, or use its mcp.json with your custom agent.')
        mode, doctor, doctor_timeout = desktop_readiness_request(
            args, interactive=sys.stdin.isatty(), desktop_command=desktop_command)
        if mode == 'required':
            print('Checking live desktop readiness. This check will not open System Settings.')
            try:
                result = run_desktop_doctor(doctor, timeout=doctor_timeout)
            except (OSError, subprocess.SubprocessError) as exc:
                p.exit(2, 'Agent configuration is saved, but desktop readiness was not verified. '
                       f'Check the runtime, then rerun lcu doctor.\nDetails: {exc}\n')
            except KeyboardInterrupt:
                p.exit(2, '\nAgent configuration is saved; the required desktop check was cancelled. '
                       'Rerun lcu doctor to check readiness.\n')
            if result.returncode:
                p.exit(2, 'Agent configuration is saved, but desktop readiness was not verified. '
                       'Review the status above, then rerun lcu doctor.\n')
            print('Desktop readiness check passed. Tool discovery still needs the first agent connection.')
        elif mode == 'guided':
            print('Starting the guided desktop readiness check. Settings opens only if you choose a pane.')
            try:
                result = run_desktop_doctor(doctor, timeout=doctor_timeout)
            except KeyboardInterrupt:
                print('\nAgent configuration is saved. The guided check was cancelled; rerun lcu doctor when ready.')
            except (OSError, subprocess.SubprocessError) as exc:
                print(f'Agent configuration is saved, but the guided check could not finish: {exc}')
                print('Reconnect your agent, then run lcu doctor to review desktop readiness.')
            else:
                if result.returncode:
                    print('Agent configuration is saved, but desktop readiness remains unverified. '
                          'Reconnect your agent and run lcu doctor after resolving the status above.')
        elif mode == 'deferred':
            print('Desktop readiness was not checked. Reconnect your agent, then run:')
            print('  ' + shlex.join(doctor))
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        p.exit(1, f'Setup failed: {exc}\n')


if __name__ == '__main__':
    main()
