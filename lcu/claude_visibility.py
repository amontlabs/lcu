"""Keep the original CUA host-only tools out of Claude Code's model context."""
import json
from pathlib import Path


HOST_ONLY = ('mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir',
             'mcp__lcu__set_turn_context')

# The approval tools the lcu-approve mod calls. They cannot be in `permissions.deny`
# (a denied MCP tool leaves the tool list, so the mod's `$.mcp.call` would fail) and are
# never allowed; the relay refuses any call without a mod (`toolu_plugin_`) tool-use id.
MOD_ONLY = ('mcp__lcu__approval_request', 'mcp__lcu__approval_wait', 'mcp__lcu__approval_choice')


def _install_lifecycle_hooks(settings):
    hooks = settings.setdefault('hooks', {})
    if not isinstance(hooks, dict):
        raise ValueError('Claude hooks must be an object')

    groups = {
        'PreToolUse': {
            'matcher': 'mcp__lcu__js|mcp__lcu__js_reset',
            'hooks': [{
                'type': 'mcp_tool',
                'server': 'lcu',
                'tool': 'set_turn_context',
                'input': {
                    'session_id': '${session_id}',
                    'turn_id': '${prompt_id}',
                    'tool_use_id': '${tool_use_id}',
                    'agent_id': '${agent_id}',
                },
            }],
        },
        'Stop': {
            'hooks': [{
                'type': 'mcp_tool',
                'server': 'lcu',
                'tool': 'turn_ended',
                'input': {
                    'hook_event_name': 'Stop',
                    'session_id': '${session_id}',
                    'turn_id': '${prompt_id}',
                },
            }],
        },
        'StopFailure': {
            'hooks': [{
                'type': 'mcp_tool',
                'server': 'lcu',
                'tool': 'turn_ended',
                'input': {
                    'hook_event_name': 'Interrupt',
                    'session_id': '${session_id}',
                    'turn_id': '${prompt_id}',
                },
            }],
        },
        'SubagentStop': {
            'hooks': [{
                'type': 'mcp_tool',
                'server': 'lcu',
                'tool': 'turn_ended',
                'input': {
                    'hook_event_name': 'SubagentStop',
                    'session_id': '${agent_id}',
                    'turn_id': '${prompt_id}',
                },
            }],
        },
    }
    for event, group in groups.items():
        event_groups = hooks.setdefault(event, [])
        if not isinstance(event_groups, list):
            raise ValueError(f'Claude {event} hooks must be an array of objects')
        for existing in event_groups:
            if not isinstance(existing, dict):
                raise ValueError(f'Claude {event} hooks must be an array of objects')
            if 'matcher' in existing and not isinstance(existing['matcher'], str):
                raise ValueError(f'Claude {event} hook matcher must be a string')
            nested = existing.get('hooks')
            if not isinstance(nested, list) or any(not isinstance(item, dict) for item in nested):
                raise ValueError(f'Claude {event} hook entries must be an array of objects')
        handler = group['hooks'][0]
        matcher = group.get('matcher')
        if not any(existing.get('matcher') == matcher and handler in existing['hooks']
                   for existing in event_groups):
            event_groups.append(group)


def install(home, *, project=None):
    """Add exact deny rules at the selected Claude Code scope, preserving other settings."""
    from .setup import Change, apply_changes, read_file

    path = ((Path(project) / '.claude/settings.local.json') if project else
            (Path(home) / '.claude/settings.json'))
    before = read_file(path)
    settings = json.loads(before) if before else {}
    if not isinstance(settings, dict):
        raise ValueError(f'Claude settings must be an object: {path}')
    permissions = settings.setdefault('permissions', {})
    if not isinstance(permissions, dict):
        raise ValueError(f'Claude permissions must be an object: {path}')
    deny = permissions.setdefault('deny', [])
    if not isinstance(deny, list) or any(not isinstance(rule, str) for rule in deny):
        raise ValueError(f'Claude deny rules must be a string array: {path}')
    for rule in HOST_ONLY:
        if rule not in deny:
            deny.append(rule)
    _install_lifecycle_hooks(settings)
    if before is None or json.loads(before) != settings:
        apply_changes([Change(path, before, (json.dumps(settings, indent=2) + '\n').encode())])
    return path
