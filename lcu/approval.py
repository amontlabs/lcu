"""Optional approval mode: add or remove only LCU's own harness approval entries.

`auto` lets each selected harness run LCU's model-visible computer-use tools
(`js`, `js_reset`) without its own per-call prompt. Entries name those tools
exactly, never the whole server. LCU records what `auto` changed (per config path, profile and
scope; a Codex config value LCU replaced) in `approval.json` beside `setup.json`, and
`ask` reverses exactly that. An entry LCU did not add, even one identical to
what `auto` writes, is never removed; it is left alone and reported.

Native-app and Chrome approvals come from the original runtime and are not
affected. Chrome site approvals stay exact-origin only.
"""
import json
import shutil
import subprocess
from pathlib import Path

MODES = ('ask', 'auto')

# The tools the model sees. Approval entries name exactly these, never the whole
# server, so a tool LCU adds later (especially one that requires the user) is not
# allowed by an earlier `auto`. The other tools of the server are host-only.
MODEL_TOOLS = ('js', 'js_reset')
# Claude Code: exact permission rules. Host-only tools also stay denied (deny
# takes precedence over allow).
CLAUDE_RULES = tuple(f'mcp__lcu__{tool}' for tool in MODEL_TOOLS)
# Earlier versions added this server-wide rule; `auto` replaces it, `ask` still removes it.
LEGACY_CLAUDE_RULE = 'mcp__lcu'
# Codex: per-tool `approval_mode` under `[mcp_servers.lcu.tools.<tool>]`. Earlier
# versions wrote the server-wide `default_tools_approval_mode = "approve"`.
CODEX_KEY = 'default_tools_approval_mode'
CODEX_VALUE = 'approve'
# OMP: per-tool policies for the tools the LCU extension registers.
OMP_TOOLS = MODEL_TOOLS

NOTHING_TO_CONFIGURE = {
    'pi': 'Pi has no permission system; nothing to configure',
    'hermes': 'Hermes gates only plugin tools through a pre_tool_call hook, which LCU does not register; '
              'nothing to configure',
}


def record_path(home):
    """LCU's own record of what approval mode changed, beside setup.json."""
    from .setup import setup_state_path
    return setup_state_path(Path(home)).with_name('approval.json')


def load_record(home):
    from .setup import read_file
    path = record_path(home)
    data = read_file(path)
    if data is None:
        return {}
    try:
        record = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        record = None
    if not isinstance(record, dict) or not all(isinstance(value, dict) for value in record.values()):
        raise ValueError(f'Malformed LCU approval record at {path}; check it, then delete it and rerun setup.')
    return record


def save_record(home, record):
    from .setup import atomic_write
    atomic_write(record_path(home), (json.dumps(record, indent=2, sort_keys=True) + '\n').encode())


def _commit(home, key, value):
    """Store (or, with None, forget) what LCU changed for one config location."""
    record = load_record(home)
    if value is None:
        if key not in record:
            return
        del record[key]
    else:
        record[key] = value
    save_record(home, record)


KEEP = 'keep'  # codex_plan: leave the stored record as it is


def codex_config_path(home, scope, project, env):
    from .codex_hooks import _selected_codex_home
    if scope == 'project':
        return Path(project) / '.codex/config.toml'
    return _selected_codex_home({**env, 'HOME': env.get('HOME', str(home))}) / 'config.toml'


def _codex_state(path):
    """The server-wide default and the per-tool approval modes in `[mcp_servers.lcu]`."""
    from .setup import read_file
    import tomllib
    data = read_file(path)
    if data is None:
        return None, {}
    servers = tomllib.loads(data.decode()).get('mcp_servers')
    table = servers.get('lcu') if isinstance(servers, dict) else None
    if not isinstance(table, dict):
        return None, {}
    default = table.get(CODEX_KEY)
    tools = table.get('tools')
    modes = {}
    for tool in MODEL_TOOLS:
        entry = tools.get(tool) if isinstance(tools, dict) else None
        mode = entry.get('approval_mode') if isinstance(entry, dict) else None
        if isinstance(mode, str):
            modes[tool] = mode
    return (default if isinstance(default, str) else None), modes


def merge_codex_policy(host, policy):
    """Merge a `codex_plan` policy over the host contract, combining their `tools` tables."""
    merged = {**host, **{key: value for key, value in policy.items() if key != 'tools'}}
    if policy.get('tools'):
        tools = {name: dict(entry) for name, entry in (host.get('tools') or {}).items()}
        for name, entry in policy['tools'].items():
            tools[name] = {**tools.get(name, {}), **entry}
        merged['tools'] = tools
    return merged


def codex_plan(mode, home, *, scope, project, env):
    """Decide the approval keys registration writes for `[mcp_servers.lcu]`.

    Registration replaces that whole table (it is LCU's own), so values the user set
    there must be carried through explicitly. `auto` approves exactly the model-visible
    tools through their own `approval_mode`; a tool the user already configured is kept
    as theirs. The server-wide default is never written; a record left by an earlier
    version (`prior`) is migrated away: `auto` and `ask` restore the user's old default.
    Returns {'policy': keys merged at registration, 'key': record key, 'record': what to
    store once registration succeeds (None forgets it, KEEP leaves it)}.
    """
    path = codex_config_path(home, scope, project, env)
    key = f'codex|{path}'
    try:
        default, tools = _codex_state(path)
        record = load_record(home)
    except (ValueError, UnicodeDecodeError) as exc:
        if mode is None:
            return {'policy': {}, 'key': key, 'record': KEEP}
        raise ValueError(f'Cannot read the Codex config at {path}: {exc}') from exc
    recorded = record.get(key)
    legacy = recorded is not None and 'tools' not in recorded
    added = set() if recorded is None or legacy else set(recorded.get('tools', []))
    restored = None
    if legacy and mode in ('auto', 'ask') and default in (CODEX_VALUE, None):
        # LCU's old server-wide approve: put the user's own value back.
        prior = recorded.get('prior')
        default = prior if isinstance(prior, str) else None
        restored = prior
    result = dict(tools)
    if mode == 'auto':
        for tool in MODEL_TOOLS:
            if tool not in tools or (tool in added and tools[tool] == CODEX_VALUE):
                result[tool] = CODEX_VALUE
                added.add(tool)
            else:
                added.discard(tool)  # the user's own setting
        new_record = {'tools': sorted(added)} if added else None
    elif mode == 'ask' and recorded is not None:
        for tool in added:
            if tools.get(tool) == CODEX_VALUE:
                del result[tool]
        new_record = None
    else:
        # Not recorded (or no explicit mode): whatever is there belongs to the user.
        new_record = KEEP
    policy = {}
    if default is not None:
        policy[CODEX_KEY] = default
    if result:
        policy['tools'] = {tool: {'approval_mode': value} for tool, value in result.items()}
    return {'policy': policy, 'key': key, 'record': new_record, 'restored': restored, 'migrated': legacy}


def claude_settings_path(home, project=None):
    return (Path(project) / '.claude/settings.local.json') if project else (Path(home) / '.claude/settings.json')


def apply_claude(mode, home, *, project=None):
    from .setup import Change, apply_changes, read_file
    path = claude_settings_path(home, project)
    key = f'claude-code|{path}'
    recorded = key in load_record(home)
    before = read_file(path)
    if before is None and mode != 'auto':
        _commit(home, key, None)
        return 'unchanged (no settings file)'
    settings = json.loads(before) if before else {}
    if not isinstance(settings, dict):
        raise ValueError(f'Claude settings must be an object: {path}')
    permissions = settings.setdefault('permissions', {})
    if not isinstance(permissions, dict):
        raise ValueError(f'Claude permissions must be an object: {path}')
    allow = permissions.get('allow', [])
    if not isinstance(allow, list) or any(not isinstance(rule, str) for rule in allow):
        raise ValueError(f'Claude allow rules must be a string array: {path}')
    ours = {*CLAUDE_RULES, LEGACY_CLAUDE_RULE}
    # Only an entry LCU recorded adding is LCU's to remove.
    added = set(load_record(home).get(key, {}).get('added', [])) & set(allow) if recorded else set()
    rules = list(allow)
    note = ''
    if mode == 'auto':
        migrated = LEGACY_CLAUDE_RULE in added
        if migrated:
            rules = [rule for rule in rules if rule != LEGACY_CLAUDE_RULE]
            added.discard(LEGACY_CLAUDE_RULE)
        if LEGACY_CLAUDE_RULE in rules:
            note = f'; kept your own `{LEGACY_CLAUDE_RULE}` rule, which LCU did not add'
        else:
            for rule in CLAUDE_RULES:
                if rule not in rules:
                    rules.append(rule)
                    added.add(rule)
        changed = [rule for rule in rules if rule not in allow]
        outcome = 'added' if changed else ('replaced' if migrated else 'unchanged')
        if migrated:
            note = f'; replaced the server-wide `{LEGACY_CLAUDE_RULE}` rule LCU added earlier'
    else:
        removed = [rule for rule in allow if rule in added]
        rules = [rule for rule in allow if rule not in added]
        outcome = 'removed' if removed else 'unchanged'
        kept = [rule for rule in rules if rule in ours]
        if kept:
            note = '; kept your own ' + ', '.join(f'`{rule}`' for rule in kept) + ', which LCU did not add'
    if rules != allow:
        if rules:
            permissions['allow'] = rules
        else:
            del permissions['allow']
            if not permissions:
                del settings['permissions']
        apply_changes([Change(path, before, (json.dumps(settings, indent=2) + '\n').encode())])
    if mode == 'auto':
        _commit(home, key, {'added': sorted(added)} if added else None)
    else:
        _commit(home, key, None)
    shown = ', '.join(f'`{rule}`' for rule in (removed if mode != 'auto' and removed else CLAUDE_RULES))
    return f'{outcome} {shown} in permissions.allow ({path}){note}'


def _omp(executable, env, home, *args):
    result = subprocess.run([executable, 'config', *args], cwd=home, env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise ValueError(f'omp config exited {result.returncode}' + (f': {detail}' if detail else ''))
    return result.stdout


def _omp_key(home, env):
    profile = {name: env[name] for name in ('PI_CODING_AGENT_DIR', 'OMP_PROFILE') if env.get(name)}
    return f'omp|{home}|{json.dumps(profile, sort_keys=True)}'


def apply_omp(mode, home, *, env):
    executable = shutil.which('omp', path=env.get('PATH'))
    if not executable:
        raise ValueError('Oh My Pi is not on the target account PATH. Install OMP, then rerun setup.')
    key = _omp_key(home, env)
    added = set(load_record(home).get(key, {}).get('added', []))
    try:
        current = json.loads(_omp(executable, env, home, 'get', 'tools.approval', '--json'))['value']
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError('omp config returned an unexpected tools.approval value') from exc
    if not isinstance(current, dict):
        raise ValueError('OMP tools.approval must be a mapping of tool names to policies')
    updated, notes = dict(current), []
    for tool in OMP_TOOLS:
        if mode == 'auto':
            if tool not in updated:
                updated[tool] = 'allow'
                added.add(tool)
                notes.append(f'added `{tool}: allow`')
            elif updated[tool] != 'allow':
                added.discard(tool)
                notes.append(f'kept your `{tool}: {updated[tool]}`')
        elif tool in added and updated.get(tool) == 'allow':
            del updated[tool]
            notes.append(f'removed `{tool}: allow`')
        elif tool in updated:
            notes.append(f'kept your `{tool}: {updated[tool]}`, which LCU did not add')
    if updated != current:
        if updated:
            _omp(executable, env, home, 'set', 'tools.approval', json.dumps(updated, sort_keys=True))
        else:
            _omp(executable, env, home, 'reset', 'tools.approval')
    _commit(home, key, {'added': sorted(added)} if mode == 'auto' and added else None)
    return ', '.join(notes) + ' in tools.approval' if notes else 'unchanged'


def apply(mode, name, home, *, scope, project, env, plan=None):
    """Apply an approval mode for one harness; return a short description.

    `plan` is the `codex_plan` computed before registration, which is when the
    previous Codex value is still readable.
    """
    if mode not in MODES:
        raise ValueError(f'Unknown approval mode: {mode}')
    if name == 'claude-code':
        return apply_claude(mode, home, project=project if scope == 'project' else None)
    if name == 'omp':
        return apply_omp(mode, home, env=env)
    if name == 'codex':
        if plan is None:
            plan = codex_plan(mode, home, scope=scope, project=project, env=env)
        if plan['record'] != KEEP:
            _commit(home, plan['key'], plan['record'])
        if mode == 'auto':
            return ('registered `approval_mode = "approve"` for the `js` and `js_reset` tools of '
                    '`[mcp_servers.lcu]`' + ('; replaced the server-wide default LCU added earlier'
                                             if plan.get('migrated') else ''))
        restored = plan.get('restored')
        return (f'restored your previous `default_tools_approval_mode = "{restored}"` for `[mcp_servers.lcu]`'
                if isinstance(restored, str)
                else 'registered `[mcp_servers.lcu]` without an `approval_mode` LCU added')
    return NOTHING_TO_CONFIGURE[name]
