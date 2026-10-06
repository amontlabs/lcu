// Optional approval mode: add or remove only LCU's own harness approval entries.
//
// `auto` lets each selected harness run LCU's model-visible computer-use tools
// (`js`, `js_reset`) without its own per-call prompt. Entries name those tools
// exactly, never the whole server. LCU records what `auto` changed (per config path, profile and
// scope; a Codex config value LCU replaced) in `approval.json` beside `setup.json`, and
// `ask` reverses exactly that. An entry LCU did not add, even one identical to
// what `auto` writes, is never removed; it is left alone and reported.
//
// Native-app and Chrome approvals come from the original runtime and are not
// affected. Chrome site approvals stay exact-origin only.
//
// Port of lcu/approval.py. Paths are absolute path strings; the environment is a plain object.
//   * load_record returns the record as loaded (a Map of Maps, pyjson's lossless model); save_record writes it
//     with sort_keys. codex_plan returns a plain object; its `policy` uses fixed identifier keys and its `record`
//     is a Map, null or KEEP.
//   * Claude/OMP settings are handled in pyjson's lossless model (Map/BigInt/PyFloat) so they round-trip.
//   * merge_codex_policy returns the same kind of table as `host` (Map or plain object).
// Test injection points (Python: patch('lcu.approval.shutil.which'/'subprocess.run')): `internals.which/run`.
import { posix as path } from 'node:path';

import { pyStrip } from './compat/argparse.mjs';
import {
  JSONDecodeError, PyFloat, UnicodeDecodeError, isInt, compareCodePoints, dumps, equal, fromPlain, loads, reprFloat, ValueError,
} from './compat/pyjson.mjs';
import { run } from './compat/subprocess.mjs';
import { loadsBytes } from './compat/toml.mjs';
import { decode } from './compat/utf8.mjs';
import { which } from './compat/which.mjs';
import { _selected_codex_home } from './codex_hooks.mjs';
// Paths follow setup's selected pathlib flavour (PosixPath / WindowsPath).
import {
  Change, apply_changes, atomic_write, join_path, path_parent, read_file, setup_state_path,
} from './setup.mjs';

export const internals = { run, which };

export const MODES = ['ask', 'auto'];

// The tools the model sees. Approval entries name exactly these, never the whole
// server, so a tool LCU adds later (especially one that requires the user) is not
// allowed by an earlier `auto`. The other tools of the server are host-only.
export const MODEL_TOOLS = ['js', 'js_reset'];
// Claude Code: exact permission rules. Host-only tools also stay denied (deny
// takes precedence over allow).
export const CLAUDE_RULES = MODEL_TOOLS.map((tool) => `mcp__lcu__${tool}`);
// Earlier versions added this server-wide rule; `auto` replaces it, `ask` still removes it.
export const LEGACY_CLAUDE_RULE = 'mcp__lcu';
// Codex: per-tool `approval_mode` under `[mcp_servers.lcu.tools.<tool>]`. Earlier
// versions wrote the server-wide `default_tools_approval_mode = "approve"`.
export const CODEX_KEY = 'default_tools_approval_mode';
export const CODEX_VALUE = 'approve';
// OMP: per-tool policies for the tools the LCU extension registers.
export const OMP_TOOLS = MODEL_TOOLS;

export const NOTHING_TO_CONFIGURE = {
  pi: 'Pi has no permission system; nothing to configure',
  hermes: 'Hermes gates only plugin tools through a pre_tool_call hook, which LCU does not register; ' +
    'nothing to configure',
};

const has = (object, key) => Object.hasOwn(object, key);
const isMap = (value) => value instanceof Map;
const sorted = (items) => [...items].sort(compareCodePoints);

// set(value) as Python evaluates it on a recorded JSON value: None/numbers/bools are not iterable (TypeError
// "'NoneType' object is not iterable"), a str yields its characters, a dict its keys; dict/list members are
// unhashable. Raised before anything is written, as in Python.
function pySet(value) {
  const kind = value === null ? 'NoneType' : typeof value === 'boolean' ? 'bool' : isInt(value) ? 'int'
    : typeof value === 'number' || value instanceof PyFloat ? 'float' : null;
  if (kind) throw new TypeError(`'${kind}' object is not iterable`);
  const items = typeof value === 'string' ? [...value] : isMap(value) ? [...value.keys()] : value;
  for (const item of items) {
    if (isMap(item) || Array.isArray(item)) throw new TypeError(`unhashable type: '${isMap(item) ? 'dict' : 'list'}'`);
  }
  return new Set(items);
}

/** LCU's own record of what approval mode changed, beside setup.json. */
export function record_path(home) {
  return join_path(path_parent(setup_state_path(home)), 'approval.json');
}

export function load_record(home) {
  const file = record_path(home);
  const data = read_file(file);
  if (data === null) return new Map();
  let record;
  try {
    record = loads(data);
  } catch (error) {
    if (!(error instanceof JSONDecodeError || error instanceof UnicodeDecodeError)) throw error;
    record = null;
  }
  if (!isMap(record) || ![...record.values()].every(isMap)) {
    throw new ValueError(`Malformed LCU approval record at ${file}; check it, then delete it and rerun setup.`);
  }
  return record;
}

export function save_record(home, record) {
  atomic_write(record_path(home), Buffer.from(dumps(record, { indent: 2, sort_keys: true }) + '\n'));
}

/** Store (or, with null, forget) what LCU changed for one config location. */
function _commit(home, key, value) {
  const record = load_record(home);
  if (value === null) {
    if (!record.has(key)) return;
    record.delete(key);
  } else {
    record.set(key, value);
  }
  save_record(home, record);
}

export const KEEP = 'keep'; // codex_plan: leave the stored record as it is

export function codex_config_path(home, scope, project, env) {
  if (scope === 'project') return join_path(project, '.codex/config.toml');
  return join_path(_selected_codex_home({ ...env, HOME: has(env, 'HOME') ? env.HOME : String(home) }), 'config.toml');
}

/** The server-wide default and the per-tool approval modes in `[mcp_servers.lcu]`. */
function _codex_state(file) {
  const data = read_file(file);
  if (data === null) return [null, {}];
  const document = loadsBytes(data);
  const servers = document.has('mcp_servers') ? document.get('mcp_servers') : null;
  const table = isMap(servers) && servers.has('lcu') ? servers.get('lcu') : null;
  if (!isMap(table)) return [null, {}];
  const default_ = table.has(CODEX_KEY) ? table.get(CODEX_KEY) : null;
  const tools = table.has('tools') ? table.get('tools') : null;
  const modes = {};
  for (const tool of MODEL_TOOLS) {
    const entry = isMap(tools) && tools.has(tool) ? tools.get(tool) : null;
    const mode = isMap(entry) && entry.has('approval_mode') ? entry.get('approval_mode') : null;
    if (typeof mode === 'string') modes[tool] = mode;
  }
  return [typeof default_ === 'string' ? default_ : null, modes];
}

// dict(entry) / {**a, **b} over a Map or a plain object, keeping the kind of `a`.
const entriesOf = (table) => (isMap(table) ? [...table] : Object.entries(table));
const lookup = (table, key) => (isMap(table) ? (table.has(key) ? table.get(key) : undefined) : (has(table, key) ? table[key] : undefined));

/** Merge a `codex_plan` policy over the host contract, combining their `tools` tables. */
export function merge_codex_policy(host, policy) {
  const merged = new Map(entriesOf(host));
  for (const [key, value] of entriesOf(policy)) {
    if (key !== 'tools') merged.set(key, isMap(host) && value !== null && typeof value === 'object' && !Array.isArray(value) ? fromPlain(value) : value);
  }
  const policyTools = lookup(policy, 'tools');
  if (policyTools !== undefined && entriesOf(policyTools).length) {
    const hostTools = lookup(host, 'tools');
    const tools = new Map();
    for (const [name, entry] of hostTools ? entriesOf(hostTools) : []) tools.set(name, new Map(entriesOf(entry)));
    for (const [name, entry] of entriesOf(policyTools)) {
      tools.set(name, new Map([...(tools.get(name) ?? []), ...entriesOf(entry)]));
    }
    merged.set('tools', isMap(host)
      ? tools
      : Object.fromEntries([...tools].map(([name, entry]) => [name, Object.fromEntries(entry)])));
  }
  return isMap(host) ? merged : Object.fromEntries(merged);
}

/**
 * Decide the approval keys registration writes for `[mcp_servers.lcu]`.
 *
 * Registration replaces that whole table (it is LCU's own), so values the user set
 * there must be carried through explicitly. `auto` approves exactly the model-visible
 * tools through their own `approval_mode`; a tool the user already configured is kept
 * as theirs. The server-wide default is never written; a record left by an earlier
 * version (`prior`) is migrated away: `auto` and `ask` restore the user's old default.
 * Returns {'policy': keys merged at registration, 'key': record key, 'record': what to
 * store once registration succeeds (null forgets it, KEEP leaves it)}.
 */
export function codex_plan(mode, home, { scope, project, env }) {
  const file = codex_config_path(home, scope, project, env);
  const key = `codex|${file}`;
  let default_;
  let tools;
  let record;
  try {
    [default_, tools] = _codex_state(file);
    record = load_record(home);
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    if (mode === null || mode === undefined) return { policy: {}, key, record: KEEP };
    throw new ValueError(`Cannot read the Codex config at ${file}: ${error.message}`);
  }
  const recorded = record.has(key) ? record.get(key) : null;
  const legacy = recorded !== null && !recorded.has('tools');
  const added = recorded === null || legacy ? new Set() : pySet(recorded.get('tools'));
  let restored = null;
  if (legacy && (mode === 'auto' || mode === 'ask') && (default_ === CODEX_VALUE || default_ === null)) {
    // LCU's old server-wide approve: put the user's own value back.
    const prior = recorded.has('prior') ? recorded.get('prior') : null;
    default_ = typeof prior === 'string' ? prior : null;
    restored = prior;
  }
  const result = { ...tools };
  let new_record;
  if (mode === 'auto') {
    for (const tool of MODEL_TOOLS) {
      if (!has(tools, tool) || (added.has(tool) && tools[tool] === CODEX_VALUE)) {
        result[tool] = CODEX_VALUE;
        added.add(tool);
      } else {
        added.delete(tool); // the user's own setting
      }
    }
    new_record = added.size ? new Map([['tools', sorted(added)]]) : null;
  } else if (mode === 'ask' && recorded !== null) {
    for (const tool of added) {
      if (has(tools, tool) && tools[tool] === CODEX_VALUE) delete result[tool];
    }
    new_record = null;
  } else {
    // Not recorded (or no explicit mode): whatever is there belongs to the user.
    new_record = KEEP;
  }
  const policy = {};
  if (default_ !== null) policy[CODEX_KEY] = default_;
  if (Object.keys(result).length) {
    policy.tools = Object.fromEntries(Object.entries(result).map(([tool, value]) => [tool, { approval_mode: value }]));
  }
  return { policy, key, record: new_record, restored, migrated: legacy };
}

export function claude_settings_path(home, project = null) {
  return project ? join_path(project, '.claude/settings.local.json') : join_path(home, '.claude/settings.json');
}

export function apply_claude(mode, home, { project = null } = {}) {
  const file = claude_settings_path(home, project);
  const key = `claude-code|${file}`;
  const recorded = load_record(home).has(key);
  const before = read_file(file);
  if (before === null && mode !== 'auto') {
    _commit(home, key, null);
    return 'unchanged (no settings file)';
  }
  const settings = before && before.length ? loads(before) : new Map();
  if (!isMap(settings)) throw new ValueError(`Claude settings must be an object: ${file}`);
  if (!settings.has('permissions')) settings.set('permissions', new Map());
  const permissions = settings.get('permissions');
  if (!isMap(permissions)) throw new ValueError(`Claude permissions must be an object: ${file}`);
  const allow = permissions.has('allow') ? permissions.get('allow') : [];
  if (!Array.isArray(allow) || allow.some((rule) => typeof rule !== 'string')) {
    throw new ValueError(`Claude allow rules must be a string array: ${file}`);
  }
  const ours = new Set([...CLAUDE_RULES, LEGACY_CLAUDE_RULE]);
  // Only an entry LCU recorded adding is LCU's to remove.
  let added;
  if (recorded) {
    const entry = load_record(home).get(key) ?? new Map();
    // Deliberate hardening over Python (AGENTS.md: approval changes add/remove only LCU's own entries): a record
    // naming rules LCU never writes (edited or corrupt) cannot make `ask` remove them.
    added = new Set([...pySet(entry.has('added') ? entry.get('added') : [])]
      .filter((rule) => ours.has(rule) && allow.includes(rule)));
  } else {
    added = new Set();
  }
  let rules = [...allow];
  let note = '';
  let outcome;
  let removed;
  if (mode === 'auto') {
    const migrated = added.has(LEGACY_CLAUDE_RULE);
    if (migrated) {
      rules = rules.filter((rule) => rule !== LEGACY_CLAUDE_RULE);
      added.delete(LEGACY_CLAUDE_RULE);
    }
    if (rules.includes(LEGACY_CLAUDE_RULE)) {
      note = `; kept your own \`${LEGACY_CLAUDE_RULE}\` rule, which LCU did not add`;
    } else {
      for (const rule of CLAUDE_RULES) {
        if (!rules.includes(rule)) {
          rules.push(rule);
          added.add(rule);
        }
      }
    }
    const changed = rules.filter((rule) => !allow.includes(rule));
    outcome = changed.length ? 'added' : (migrated ? 'replaced' : 'unchanged');
    if (migrated) note = `; replaced the server-wide \`${LEGACY_CLAUDE_RULE}\` rule LCU added earlier`;
  } else {
    removed = allow.filter((rule) => added.has(rule));
    rules = allow.filter((rule) => !added.has(rule));
    outcome = removed.length ? 'removed' : 'unchanged';
    const kept = rules.filter((rule) => ours.has(rule));
    if (kept.length) note = '; kept your own ' + kept.map((rule) => `\`${rule}\``).join(', ') + ', which LCU did not add';
  }
  if (!equal(rules, allow)) {
    if (rules.length) {
      permissions.set('allow', rules);
    } else {
      permissions.delete('allow');
      if (permissions.size === 0) settings.delete('permissions');
    }
    apply_changes([new Change(file, before, Buffer.from(dumps(settings, { indent: 2 }) + '\n'))]);
  }
  if (mode === 'auto') _commit(home, key, added.size ? new Map([['added', sorted(added)]]) : null);
  else _commit(home, key, null);
  const shown = (mode !== 'auto' && removed.length ? removed : CLAUDE_RULES).map((rule) => `\`${rule}\``).join(', ');
  return `${outcome} ${shown} in permissions.allow (${file})${note}`;
}

function _omp(executable, env, home, ...args) {
  const result = internals.run([executable, 'config', ...args], {
    cwd: home, env, stdin: 'devnull', capture: true, errors: 'replace', timeout: 60000,
  });
  if (result.returncode) {
    const detail = pyStrip(result.stderr || result.stdout);
    throw new ValueError(`omp config exited ${result.returncode}` + (detail ? `: ${detail}` : ''));
  }
  return result.stdout;
}

function _omp_key(home, env) {
  const profile = {};
  for (const name of ['PI_CODING_AGENT_DIR', 'OMP_PROFILE']) {
    if (has(env, name) && env[name]) profile[name] = env[name];
  }
  return `omp|${home}|${dumps(profile, { sort_keys: true })}`;
}

// f'{value}' for the JSON values an OMP policy can hold.
function pyFormat(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (isInt(value)) return String(value);
  if (typeof value === 'number') return reprFloat(value);
  if (value instanceof PyFloat) return reprFloat(value.value);
  return dumps(value);
}

export function apply_omp(mode, home, { env }) {
  const executable = internals.which('omp', has(env, 'PATH') ? env.PATH : null);
  if (!executable) throw new ValueError('Oh My Pi is not on the target account PATH. Install OMP, then rerun setup.');
  const key = _omp_key(home, env);
  const entry = load_record(home).get(key) ?? new Map();
  const added = pySet(entry.has('added') ? entry.get('added') : []);
  let current;
  try {
    const document = loads(_omp(executable, env, home, 'get', 'tools.approval', '--json'));
    if (!isMap(document)) throw new TypeError('not a mapping');
    if (!document.has('value')) throw new RangeError("'value'");
    current = document.get('value');
  } catch (error) {
    if (error instanceof JSONDecodeError || error instanceof TypeError || error instanceof RangeError) {
      throw new ValueError('omp config returned an unexpected tools.approval value');
    }
    throw error;
  }
  if (!isMap(current)) throw new ValueError('OMP tools.approval must be a mapping of tool names to policies');
  const updated = new Map(current);
  const notes = [];
  for (const tool of OMP_TOOLS) {
    if (mode === 'auto') {
      if (!updated.has(tool)) {
        updated.set(tool, 'allow');
        added.add(tool);
        notes.push(`added \`${tool}: allow\``);
      } else if (updated.get(tool) !== 'allow') {
        added.delete(tool);
        notes.push(`kept your \`${tool}: ${pyFormat(updated.get(tool))}\``);
      }
    } else if (added.has(tool) && updated.get(tool) === 'allow') {
      updated.delete(tool);
      notes.push(`removed \`${tool}: allow\``);
    } else if (updated.has(tool)) {
      notes.push(`kept your \`${tool}: ${pyFormat(updated.get(tool))}\`, which LCU did not add`);
    }
  }
  if (!equal(updated, current)) {
    if (updated.size) _omp(executable, env, home, 'set', 'tools.approval', dumps(updated, { sort_keys: true }));
    else _omp(executable, env, home, 'reset', 'tools.approval');
  }
  _commit(home, key, mode === 'auto' && added.size ? new Map([['added', sorted(added)]]) : null);
  return notes.length ? notes.join(', ') + ' in tools.approval' : 'unchanged';
}

/**
 * Apply an approval mode for one harness; return a short description.
 *
 * `plan` is the `codex_plan` computed before registration, which is when the
 * previous Codex value is still readable.
 */
export function apply(mode, name, home, { scope, project, env, plan = null }) {
  if (!MODES.includes(mode)) throw new ValueError(`Unknown approval mode: ${mode}`);
  if (name === 'claude-code') return apply_claude(mode, home, { project: scope === 'project' ? project : null });
  if (name === 'omp') return apply_omp(mode, home, { env });
  if (name === 'codex') {
    if (plan === null) plan = codex_plan(mode, home, { scope, project, env });
    if (plan.record !== KEEP) _commit(home, plan.key, plan.record);
    if (mode === 'auto') {
      return 'registered `approval_mode = "approve"` for the `js` and `js_reset` tools of ' +
        '`[mcp_servers.lcu]`' + (plan.migrated ? '; replaced the server-wide default LCU added earlier' : '');
    }
    const restored = plan.restored ?? null;
    return typeof restored === 'string'
      ? `restored your previous \`default_tools_approval_mode = "${restored}"\` for \`[mcp_servers.lcu]\``
      : 'registered `[mcp_servers.lcu]` without an `approval_mode` LCU added';
  }
  if (!has(NOTHING_TO_CONFIGURE, name)) {
    const error = new Error(`'${name}'`);
    error.name = 'KeyError';
    throw error;
  }
  return NOTHING_TO_CONFIGURE[name];
}
