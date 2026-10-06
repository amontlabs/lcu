// Keep the original CUA host-only tools out of Claude Code's model context.
//
// Port of lcu/claude_visibility.py. Settings are handled in pyjson's lossless model (dict -> Map, int ->
// BigInt, float -> PyFloat) so unrelated settings round-trip byte-for-byte as json.dumps would write them.
import { pathStr } from './compat/pathlib.mjs';
import { dumps, equal, fromPlain, loads, ValueError } from './compat/pyjson.mjs';
import { Change, apply_changes, read_file } from './setup.mjs';

export const HOST_ONLY = ['mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir',
  'mcp__lcu__set_turn_context'];

// The approval tools the lcu-approve mod calls. They cannot be in `permissions.deny`
// (a denied MCP tool leaves the tool list, so the mod's `$.mcp.call` would fail) and are
// never allowed; the relay refuses any call without a mod (`toolu_plugin_`) tool-use id.
export const MOD_ONLY = ['mcp__lcu__approval_request', 'mcp__lcu__approval_choice'];

// dict.setdefault
function setdefault(map, key, value) {
  if (!map.has(key)) map.set(key, value);
  return map.get(key);
}

function _install_lifecycle_hooks(settings) {
  const hooks = setdefault(settings, 'hooks', new Map());
  if (!(hooks instanceof Map)) throw new ValueError('Claude hooks must be an object');

  const groups = [
    ['PreToolUse', {
      matcher: 'mcp__lcu__js|mcp__lcu__js_reset',
      hooks: [{
        type: 'mcp_tool',
        server: 'lcu',
        tool: 'set_turn_context',
        input: {
          session_id: '${session_id}',
          turn_id: '${prompt_id}',
          tool_use_id: '${tool_use_id}',
          agent_id: '${agent_id}',
        },
      }],
    }],
    ['Stop', {
      hooks: [{
        type: 'mcp_tool',
        server: 'lcu',
        tool: 'turn_ended',
        input: {
          hook_event_name: 'Stop',
          session_id: '${session_id}',
          turn_id: '${prompt_id}',
        },
      }],
    }],
    ['StopFailure', {
      hooks: [{
        type: 'mcp_tool',
        server: 'lcu',
        tool: 'turn_ended',
        input: {
          hook_event_name: 'Interrupt',
          session_id: '${session_id}',
          turn_id: '${prompt_id}',
        },
      }],
    }],
    ['SubagentStop', {
      hooks: [{
        type: 'mcp_tool',
        server: 'lcu',
        tool: 'turn_ended',
        input: {
          hook_event_name: 'SubagentStop',
          session_id: '${agent_id}',
          turn_id: '${prompt_id}',
        },
      }],
    }],
  ];
  for (const [event, plain] of groups) {
    const group = fromPlain(plain);
    const eventGroups = setdefault(hooks, event, []);
    if (!Array.isArray(eventGroups)) throw new ValueError(`Claude ${event} hooks must be an array of objects`);
    for (const existing of eventGroups) {
      if (!(existing instanceof Map)) throw new ValueError(`Claude ${event} hooks must be an array of objects`);
      if (existing.has('matcher') && typeof existing.get('matcher') !== 'string') {
        throw new ValueError(`Claude ${event} hook matcher must be a string`);
      }
      const nested = existing.get('hooks');
      if (!Array.isArray(nested) || nested.some((item) => !(item instanceof Map))) {
        throw new ValueError(`Claude ${event} hook entries must be an array of objects`);
      }
    }
    const handler = group.get('hooks')[0];
    const matcher = group.has('matcher') ? group.get('matcher') : null;
    if (!eventGroups.some((existing) => equal(existing.has('matcher') ? existing.get('matcher') : null, matcher) &&
        existing.get('hooks').some((item) => equal(item, handler)))) {
      eventGroups.push(group);
    }
  }
}

/** Add exact deny rules at the selected Claude Code scope, preserving other settings. */
export function install(home, { project = null } = {}) {
  const path = project ? pathStr(project, '.claude/settings.local.json') : pathStr(home, '.claude/settings.json');
  const before = read_file(path);
  const settings = before && before.length ? loads(before) : new Map();
  if (!(settings instanceof Map)) throw new ValueError(`Claude settings must be an object: ${path}`);
  const permissions = setdefault(settings, 'permissions', new Map());
  if (!(permissions instanceof Map)) throw new ValueError(`Claude permissions must be an object: ${path}`);
  const deny = setdefault(permissions, 'deny', []);
  if (!Array.isArray(deny) || deny.some((rule) => typeof rule !== 'string')) {
    throw new ValueError(`Claude deny rules must be a string array: ${path}`);
  }
  for (const rule of HOST_ONLY) {
    if (!deny.includes(rule)) deny.push(rule);
  }
  _install_lifecycle_hooks(settings);
  if (before === null || !equal(loads(before), settings)) {
    apply_changes([new Change(path, before, Buffer.from(dumps(settings, { indent: 2 }) + '\n'))]);
  }
  return path;
}
