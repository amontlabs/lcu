"""Install the original Codex turn lifecycle records using its own config writer."""
import copy
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import tomllib


def original_plugin(host_root):
    return Path(host_root) / 'plugins/unified-computer-use'


def original_hooks(host_root):
    manifest = json.loads((original_plugin(host_root) / '.codex-plugin/plugin.json').read_text())
    events = manifest['hooks']['hooks']
    if set(events) != {'Stop', 'Interrupt', 'SubagentStop'}:
        raise ValueError('Upstream lifecycle events changed; review before installation.')
    for groups in events.values():
        for group in groups:
            for hook in group['hooks']:
                if hook['type'] != 'mcp_tool' or hook['server'] != 'cua_repl' or hook['tool'] != 'turn_ended':
                    raise ValueError('Upstream lifecycle contract changed; review before installation.')
                hook['server'] = 'lcu'
    return events


NOTICE_EVENTS = ('SessionStart', 'UserPromptSubmit')
NOTICE_SUFFIXES = {event: f' update --notice --hook {event}' for event in NOTICE_EVENTS}
NOTICE_MATCHER = 'startup|resume'


def notice_hook(lcu, event='SessionStart'):
    """LCU's own command hook for `event` (harness integration, not an original lifecycle hook).

    `update --notice --hook EVENT` prints Codex's `hookSpecificOutput.additionalContext` for the model once per
    session and release, and at most once a day per release across the account; it is cache-only, exits 0 and prints nothing otherwise. SessionStart runs on startup and
    resume, UserPromptSubmit on every prompt (no matcher, no status message: it must stay quiet). Hook trust
    applies as for any other hook; this is never part of the upstream lifecycle contract.
    """
    lcu, suffix = str(lcu), NOTICE_SUFFIXES[event]
    hook = {'type': 'command', 'command': shlex.quote(lcu) + suffix,
            'commandWindows': subprocess.list2cmdline([lcu]) + suffix}
    if event == 'SessionStart':
        hook.update(timeout=10, statusMessage='Checking for LCU updates')
        return {'matcher': NOTICE_MATCHER, 'hooks': [hook]}
    hook['timeout'] = 5
    return {'hooks': [hook]}


def is_notice_group(group, event=None):
    """True for a group made only of LCU update-notice command hooks (ours to replace or remove)."""
    hooks = group.get('hooks') if isinstance(group, dict) else None
    suffixes = tuple(NOTICE_SUFFIXES.values() if event is None else [NOTICE_SUFFIXES[event]])
    try:
        return bool(hooks) and all(isinstance(h, dict) and h.get('type') == 'command'
                                   and str(h.get('command', '')).endswith(suffixes)
                                   and Path(shlex.split(h['command'])[0]).name in {'lcu', 'lcu.cmd'}
                                   for h in hooks)
    except ValueError:  # Unbalanced quoting in someone else's hook: not ours.
        return False


def export_files(command, host_root):
    """Native plugin files, mirroring the original unified-computer-use plugin (which has no skill)."""
    original = original_plugin(host_root)
    manifest = json.loads((original / '.codex-plugin/plugin.json').read_text())
    manifest.update(name='lcu', description='Computer use through the locally installed Codex runtime.')
    manifest['hooks']['hooks'] = original_hooks(host_root)
    descriptor = json.loads((original / '.mcp.json').read_text())
    server = descriptor['mcpServers'].pop('cua_repl')
    server.update(command=command[0], args=command[1:], enabled=True)
    descriptor['mcpServers']['lcu'] = server
    contract = {
        'hooks': manifest['hooks']['hooks'],
        'requestMetadata': 'Forward each real session_id and turn_id as x-codex-turn-metadata in MCP request _meta.',
        'lifecycle': 'Call lcu.turn_ended when the host stops or interrupts a turn, including a subagent turn; substitute the original hook input variables with real host identifiers. Keep the MCP connection alive until cleanup finishes.',
        'unsupportedHosts': 'Installing MCP alone does not supply turn lifecycle hooks. A host without equivalent hooks must implement this contract before claiming Codex lifecycle parity.',
        'codexTrust': 'Codex requires trust for these exact hooks. Use lcu setup --agent codex or review and trust them in Codex; this export does not bypass hook trust.',
    }
    return {name: (json.dumps(value, indent=2) + '\n').encode() for name, value in (
        ('.codex-plugin/plugin.json', manifest), ('.mcp.json', descriptor),
        ('lifecycle-contract.json', contract))}


from .app_server import app_server as config_writer


def _selected_codex_home(env):
    """Match the native CLI's `CODEX_HOME ?? join(homedir, '.codex')` selection.

    The pinned Codex host resolves the home with nullish coalescing, so an
    explicitly empty CODEX_HOME is kept verbatim (an unusable relative path)
    rather than falling back to ~/.codex. Reject it with a clear error instead
    of silently substituting a default, mirroring setup's absolute-path check.
    """
    if 'CODEX_HOME' in env and env['CODEX_HOME'] == '':
        raise ValueError('CODEX_HOME is set but empty; unset it or set an absolute path')
    return Path(env['CODEX_HOME']) if env.get('CODEX_HOME') else Path(env['HOME']) / '.codex'


def require_cli_hook_support(env):
    """Reject an installed Codex CLI that cannot parse the original MCP hook type.

    Registration also works before Codex CLI is installed. The probe has an
    empty home and never starts a model or loads account configuration.
    """
    # The probe uses its own isolated home, but reject an explicitly empty
    # CODEX_HOME up front so setup fails clearly instead of at hook install.
    if env.get('CODEX_HOME') == '':
        raise ValueError('CODEX_HOME is set but empty; unset it or set an absolute path')
    executable = shutil.which('codex', path=env.get('PATH'))
    if not executable:
        return
    with tempfile.TemporaryDirectory(prefix='lcu-codex-hook-probe-') as temporary:
        home = Path(temporary)
        (home / 'config.toml').write_text(
            '[hooks]\n'
            'Stop = [{ hooks = [{ type = "mcp_tool", server = "lcu", '
            'tool = "turn_ended", input = { session_id = "s", turn_id = "t" } }] }]\n')
        safe_env = {key: env[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'PATHEXT')
                    if key in env}
        safe_env.update(HOME=temporary, CODEX_HOME=temporary)
        try:
            version = subprocess.run([executable, '--version'], cwd=temporary, env=safe_env,
                                     stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                     encoding='utf-8', errors='replace',
                                     timeout=10).stdout.strip()
            result = subprocess.run([executable, 'mcp', 'list'], cwd=temporary, env=safe_env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    encoding='utf-8', errors='replace', timeout=20)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError(f'Cannot check installed Codex CLI hook support: {exc}') from exc
        if result.returncode:
            detail = ' '.join((result.stderr or result.stdout).split())
            if detail:
                detail = f' Codex reported: {detail[-1000:]}. '
            raise ValueError(f'Installed Codex CLI {executable} ({version or "unknown version"}) '
                             'cannot load the original MCP lifecycle hooks.' + detail + ' '
                             'Update this standalone Codex CLI to the latest public release with MCP tool hook '
                             'support (official npm package: `npm install -g @openai/codex@latest`), then rerun '
                             '`lcu setup --agent codex`.')


def install_hooks(cli, config_path, cwd, env, host_root, notice_command=None):
    """Preserve scope and unrelated hooks; trust only the reviewed original records.

    The pinned native API writes user config only. A disposable CODEX_HOME lets
    it edit either target scope without creating CLI state in the user's project.
    Commit the target config and exact per-hook trust through concurrent-edit
    guards. Project hook trust is stored in the selected user config.
    """
    from .setup import Change, apply_changes, read_file, regular_path
    config_path = regular_path(config_path)
    before = read_file(config_path)
    current = tomllib.loads((before or b'').decode())
    trust_path = regular_path(_selected_codex_home(env) / 'config.toml')
    trust_before = before if trust_path == config_path else read_file(trust_path)
    tomllib.loads((trust_before or b'').decode())
    hooks = copy.deepcopy(current.get('hooks', {}))
    expected = original_hooks(host_root)
    for event, original in expected.items():
        groups = hooks.setdefault(event, [])
        if not isinstance(groups, list):
            raise ValueError(f'Invalid existing Codex hook list: {event}')
        for group in groups:
            if any(h.get('server') == 'lcu' and h.get('tool') == 'turn_ended' for h in group.get('hooks', [])) and group not in original:
                raise ValueError(f'Existing LCU {event} hook differs from upstream; review it before setup.')
        for group in original:
            if group not in groups:
                groups.append(group)
    # LCU-owned update notices: replaced when present, removed when notice_command is None.
    notices, notice_edits = {}, []
    for event in NOTICE_EVENTS:
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            raise ValueError(f'Invalid existing Codex hook list: {event}')
        kept = [g for g in existing if not is_notice_group(g, event)]
        if notice_command:
            notices[event] = notice_hook(notice_command, event)
            kept.append(notices[event])
        if kept != existing:
            hooks[event] = kept
            notice_edits.append({'keyPath': 'hooks.' + event, 'value': kept, 'mergeStrategy': 'replace'})
    with tempfile.TemporaryDirectory(prefix='lcu-codex-config-') as temporary:
        # macOS tempfile paths can use /var while Codex reports /private/var.
        # Match the native writer's canonical source path for exact hook trust.
        scratch = Path(temporary).resolve()
        config = scratch / 'config.toml'
        config.write_bytes(before or b'')
        # The scratch home keeps account credentials and project layers out of
        # this configuration-only process. No model turn or hook is executed.
        isolated = {**env, 'HOME': temporary, 'CODEX_HOME': temporary}
        with config_writer(cli, scratch, isolated) as call:
            edits = [{'keyPath': 'hooks.' + event, 'value': hooks[event], 'mergeStrategy': 'replace'} for event in expected]
            call('config/batchWrite', {'edits': edits + notice_edits})
            # Match the exact source path; unrelated/plugin hooks are not trusted.
            listed = call('hooks/list', {'cwds': [temporary]})
            trust = []
            for entry in listed['data']:
                if entry['errors']:
                    raise ValueError('Codex could not read lifecycle hooks: ' + json.dumps(entry['errors']))
                for hook in entry['hooks']:
                    if hook['sourcePath'] == str(config) and hook.get('eventName') in {'stop', 'interrupt', 'subagentStop'} and hook.get('server') == 'lcu' and hook.get('tool') == 'turn_ended':
                        suffix = hook['key'].removeprefix(str(config))
                        if suffix == hook['key']:
                            raise ValueError('Upstream hook key format changed.')
                        key = str(config_path) + suffix
                        trust.append({'keyPath': 'hooks.state.' + json.dumps(key) + '.trusted_hash',
                                      'value': hook['currentHash'], 'mergeStrategy': 'replace'})
            if len(trust) != sum(len(g['hooks']) for groups in expected.values() for g in groups):
                raise ValueError('Codex did not discover exactly the original LCU lifecycle hooks.')
            for event, notice in notices.items():
                # Trust only the exact LCU notice command at this source path.
                found = [h for entry in listed['data'] for h in entry['hooks']
                         if h['sourcePath'] == str(config) and h.get('eventName') == event[0].lower() + event[1:]
                         and h.get('command') == notice['hooks'][0]['command']]
                if len(found) != 1:
                    raise ValueError(f'Codex did not discover exactly the LCU {event} update notice hook.')
                suffix = found[0]['key'].removeprefix(str(config))
                if suffix == found[0]['key']:
                    raise ValueError('Upstream hook key format changed.')
                trust.append({'keyPath': 'hooks.state.' + json.dumps(str(config_path) + suffix) + '.trusted_hash',
                              'value': found[0]['currentHash'], 'mergeStrategy': 'replace'})
            after = config.read_bytes()
            if trust_path != config_path:
                # Native Codex ignores project-provided hook trust. Store only
                # these path-specific approvals in the real user's config.
                config.write_bytes(trust_before or b'')
            call('config/batchWrite', {'edits': trust})
        trusted = config.read_bytes()
    changes = [Change(config_path, before, trusted if trust_path == config_path else after)]
    if trust_path != config_path:
        changes.append(Change(trust_path, trust_before, trusted))
    apply_changes(changes)
    return config_path
