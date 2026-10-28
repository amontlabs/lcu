// Keep the original CUA host-only tools out of Claude Code's model context and add LCU's lifecycle hooks.
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { applyChanges, change, json, member, parseJson, readFile, regularPath } from './setup.mjs';
import { writePrivate } from './cross_turn.mjs';

export const HOST_ONLY = ['mcp__lcu__turn_ended', 'mcp__lcu__js_add_node_module_dir', 'mcp__lcu__set_turn_context'];
// The approval tools the lcu-approve mod calls. They cannot be in `permissions.deny` (a denied MCP tool leaves the
// tool list, so the mod's `$.mcp.call` would fail) and are never allowed; the relay refuses any call without a
// mod (`toolu_plugin_`) tool-use id.
export const MOD_ONLY = ['mcp__lcu__approval_request', 'mcp__lcu__approval_choice'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const turnEnded = (hookEventName, sessionId) => ({ hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'turn_ended',
  input: { hook_event_name: hookEventName, session_id: sessionId, turn_id: '${prompt_id}' } }] });
const LEGACY = {
  PreToolUse: { matcher: 'mcp__lcu__js|mcp__lcu__js_reset', hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'set_turn_context',
    input: { session_id: '${session_id}', turn_id: '${prompt_id}', tool_use_id: '${tool_use_id}', agent_id: '${agent_id}' } }] },
  Stop: turnEnded('Stop', '${session_id}'),
  StopFailure: turnEnded('Interrupt', '${session_id}'),
  SubagentStop: turnEnded('SubagentStop', '${agent_id}'),
};

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stableRoot = (root) => basename(dirname(root)) === 'releases' ? join(dirname(dirname(root)), 'current') : root;

export function helperPath(home, platform = process.platform) {
  return platform === 'win32' ? win32.join(home, 'AppData/Local/LCU/claude/claude-hook.mjs')
    : join(home, '.local/share/lcu/claude/claude-hook.mjs');
}

export function lifecycleHooks(home, node = process.execPath, platform = process.platform) {
  if (!(platform === 'win32' ? win32.isAbsolute(node) : isAbsolute(node))) throw new Error('Claude hooks require an absolute Node executable path');
  const hook = { type: 'command', command: node, args: [helperPath(home, platform)], timeout: 600 };
  return Object.fromEntries(Object.entries(LEGACY).map(([event, group]) => [event,
    { ...('matcher' in group ? { matcher: group.matcher } : {}), hooks: [structuredClone(hook)] }]));
}

// All published Python and Node MCP templates used these exact handlers, including the pre-SubagentStop release.
function ownedHandler(event, group, hook, root, home) {
  const legacy = LEGACY[event];
  if (group.matcher !== legacy.matcher) return false;
  if (isDeepStrictEqual(hook, legacy.hooks[0])) return true;
  const previous = [[join(root, 'lcu/claude_hook.mjs')], [join(stableRoot(root), 'lcu/claude_hook.mjs')]];
  if (process.platform === 'win32' && basename(dirname(root)) === 'releases') {
    previous.push([join(dirname(dirname(root)), 'windows_launcher.mjs'), 'claude-hook']);
  }
  const args = [[helperPath(home)], ...previous];
  return hook.type === 'command' && typeof hook.command === 'string' && isAbsolute(hook.command) &&
    args.some(value => isDeepStrictEqual(hook.args, value)) &&
    isDeepStrictEqual(hook, { type: 'command', command: hook.command, args: hook.args, timeout: 600 });
}

function installLifecycleHooks(settings, root, node, home) {
  const hooks = member(settings, 'hooks', {}, 'Claude hooks must be an object');
  for (const [event, group] of Object.entries(lifecycleHooks(home, node))) {
    const groups = member(hooks, event, [], `Claude ${event} hooks must be an array of objects`);
    for (const existing of groups) {
      if (!isObject(existing)) throw new Error(`Claude ${event} hooks must be an array of objects`);
      if ('matcher' in existing && typeof existing.matcher !== 'string') throw new Error(`Claude ${event} hook matcher must be a string`);
      if (!Array.isArray(existing.hooks) || !existing.hooks.every(isObject)) throw new Error(`Claude ${event} hook entries must be an array of objects`);
    }
    // Remove handlers, not whole groups: a person's matcher and neighboring hooks survive migration.
    hooks[event] = groups.flatMap(existing => {
      const kept = existing.hooks.filter(hook => !ownedHandler(event, existing, hook, root, home));
      return kept.length === existing.hooks.length ? [existing] : kept.length ? [{ ...existing, hooks: kept }] : [];
    });
    hooks[event].push(structuredClone(group));
  }
}

function installHelper(home) {
  const helper = regularPath(helperPath(home));
  const root = dirname(dirname(helper));
  // Existing account data parents belong to the user; only the LCU and Claude directories are repaired.
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  for (const directory of [root, dirname(helper)]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(regularPath(directory), 0o700);
  }
  const content = readFileSync(new URL('./claude_hook.mjs', import.meta.url));
  const previous = readFile(helper);
  if (previous === null || !previous.equals(content) ||
      (process.platform !== 'win32' && (statSync(helper).mode & 0o777) !== 0o600)) {
    writePrivate(helper, content);
  }
}

/** Add exact deny rules and the lifecycle hooks at the selected Claude Code scope, preserving other settings. */
export function install(home, { project = null, root = ROOT, node = process.execPath } = {}) {
  const path = project ? join(project, '.claude/settings.local.json') : join(home, '.claude/settings.json');
  const before = readFile(path);
  const settings = parseJson(before);
  if (!isObject(settings)) throw new Error(`Claude settings must be an object: ${path}`);
  const permissions = member(settings, 'permissions', {}, `Claude permissions must be an object: ${path}`);
  const deny = member(permissions, 'deny', [], `Claude deny rules must be a string array: ${path}`);
  if (deny.some((rule) => typeof rule !== 'string')) throw new Error(`Claude deny rules must be a string array: ${path}`);
  for (const rule of HOST_ONLY) if (!deny.includes(rule)) deny.push(rule);
  installLifecycleHooks(settings, root, node, home);
  installHelper(home);
  if (before === null || !isDeepStrictEqual(parseJson(before), settings)) applyChanges([change(path, before, json(settings))]);
  return path;
}

/** Refresh an existing account helper and owned user hooks. Project settings still require re-running setup. */
export function refresh(home, root, node = process.execPath) {
  const hasHelper = readFile(helperPath(home)) !== null;
  if (hasHelper) installHelper(home);
  const settings = parseJson(readFile(join(home, '.claude/settings.json')));
  if (!isObject(settings?.hooks)) return hasHelper;
  const owned = Object.keys(LEGACY).some(event => Array.isArray(settings.hooks[event]) &&
    settings.hooks[event].some(group => isObject(group) && Array.isArray(group.hooks) &&
      group.hooks.some(hook => ownedHandler(event, group, hook, root, home))));
  if (!owned) return hasHelper;
  install(home, { root, node });
  return true;
}
