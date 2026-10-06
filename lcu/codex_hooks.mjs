// Install the original Codex turn lifecycle records using its own config writer.
//
// Port of lcu/codex_hooks.py. Paths are absolute path strings; the environment is a plain object.
// Structured data (plugin manifests, TOML config, app-server replies) is held in pyjson's lossless model
// (dict -> Map, int -> Number/BigInt, float -> PyFloat) so it is compared and re-serialised as Python would.
//
// install_hooks is SYNCHRONOUS, like the Python it ports: lcu/app_server.mjs drives the child process through a
// worker thread and blocks the caller with Atomics.wait. `app_server(cli, cwd, env, body)` replaces the Python
// context manager `with app_server(cli, cwd, env) as call:` (see that module).
//
// Test injection points (Python: unittest.mock.patch): `internals.run`, `internals.which`.
import {
  readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { posix as path } from 'node:path';

import { pyStrip } from './compat/argparse.mjs';
import { pathStr } from './compat/pathlib.mjs';
import {
  deepcopy, dumps, equal, fromPlain, loads, ValueError,
} from './compat/pyjson.mjs';
import { list2cmdline, quote, split } from './compat/shlex.mjs';
import { SubprocessError, isOSError, run } from './compat/subprocess.mjs';
import { mkdtemp } from './compat/tempfile.mjs';
import { loadsBytes } from './compat/toml.mjs';
import { decode } from './compat/utf8.mjs';
import { which } from './compat/which.mjs';
import { app_server as config_writer } from './app_server.mjs';
// Paths follow setup's selected pathlib flavour (PosixPath / WindowsPath).
import {
  Change, apply_changes, impl as setup_impl, join_path, read_file, regular_path,
} from './setup.mjs';
import { winName } from './compat/winpath.mjs';
import { attribute_error_get } from './compat/pystr.mjs';

export { config_writer };
export const internals = { run, which };

/** Python's KeyError for a missing dict key (uncaught by LCU's handlers, as in Python). */
class KeyError extends Error {
  constructor(key) {
    super(dumps(key).replaceAll('"', "'"));
    this.name = 'KeyError';
  }
}

// d[key] on a dict (Map) or plain object.
function at(dict, key) {
  if (dict instanceof Map) {
    if (!dict.has(key)) throw new KeyError(key);
    return dict.get(key);
  }
  if (dict !== null && typeof dict === 'object' && !Array.isArray(dict) && Object.hasOwn(dict, key)) return dict[key];
  throw new KeyError(key);
}

// d.get(key, default) on a dict (Map) or plain object.
function get(dict, key, fallback = null) {
  if (dict instanceof Map) return dict.has(key) ? dict.get(key) : fallback;
  if (dict !== null && typeof dict === 'object' && !Array.isArray(dict)) return Object.hasOwn(dict, key) ? dict[key] : fallback;
  throw attribute_error_get(dict);
}

const isDict = (value) => value instanceof Map || (value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype);

const WHITESPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
// str.split() with no argument
const pyWords = (text) => text.split(WHITESPACE).filter((word) => word !== '');

export function original_plugin(host_root) {
  return join_path(host_root, 'plugins/unified-computer-use');
}

export function original_hooks(host_root) {
  const manifest = loads(decode(readFileSync(join_path(original_plugin(host_root), '.codex-plugin/plugin.json'))));
  const events = at(at(manifest, 'hooks'), 'hooks');
  const names = [...events.keys()];
  if (names.length !== 3 || !['Stop', 'Interrupt', 'SubagentStop'].every((name) => events.has(name))) {
    throw new ValueError('Upstream lifecycle events changed; review before installation.');
  }
  for (const groups of events.values()) {
    for (const group of groups) {
      for (const hook of at(group, 'hooks')) {
        if (at(hook, 'type') !== 'mcp_tool' || at(hook, 'server') !== 'cua_repl' || at(hook, 'tool') !== 'turn_ended') {
          throw new ValueError('Upstream lifecycle contract changed; review before installation.');
        }
        hook.set('server', 'lcu');
      }
    }
  }
  return events;
}

export const NOTICE_EVENTS = ['SessionStart', 'UserPromptSubmit'];
export const NOTICE_SUFFIXES = Object.fromEntries(NOTICE_EVENTS.map((event) => [event, ` update --notice --hook ${event}`]));
export const NOTICE_MATCHER = 'startup|resume';

/**
 * LCU's own command hook for `event` (harness integration, not an original lifecycle hook).
 *
 * `update --notice --hook EVENT` prints Codex's `hookSpecificOutput.additionalContext` for the model once per
 * session and release, and at most once a day per release across the account; it is cache-only, exits 0 and prints nothing otherwise. SessionStart runs on startup and
 * resume, UserPromptSubmit on every prompt (no matcher, no status message: it must stay quiet). Hook trust
 * applies as for any other hook; this is never part of the upstream lifecycle contract.
 *
 * Returns a Map (a dict), like everything parsed from a Codex config.
 */
export function notice_hook(lcu, event = 'SessionStart') {
  lcu = String(lcu);
  const suffix = NOTICE_SUFFIXES[event];
  if (suffix === undefined) throw new KeyError(event);
  const hook = fromPlain({
    type: 'command', command: quote(lcu) + suffix, commandWindows: list2cmdline([lcu]) + suffix,
  });
  if (event === 'SessionStart') {
    hook.set('timeout', 10);
    hook.set('statusMessage', 'Checking for LCU updates');
    return fromPlain({ matcher: NOTICE_MATCHER, hooks: [hook] });
  }
  hook.set('timeout', 5);
  return fromPlain({ hooks: [hook] });
}

// Path(x).name
function pathName(value) {
  if (setup_impl.windows_paths) return winName(String(value));
  const normal = pathStr(value);
  return normal === '.' ? '' : path.basename(normal);
}

/** True for a group made only of LCU update-notice command hooks (ours to replace or remove). */
export function is_notice_group(group, event = null) {
  const hooks = isDict(group) ? get(group, 'hooks') : null;
  const suffixes = event === null ? Object.values(NOTICE_SUFFIXES) : [NOTICE_SUFFIXES[event]];
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  return hooks.every((h) => {
    if (!isDict(h) || get(h, 'type') !== 'command') return false;
    const command = get(h, 'command', '');
    if (typeof command !== 'string' || !suffixes.some((suffix) => command.endsWith(suffix))) return false;
    try {
      return ['lcu', 'lcu.cmd'].includes(pathName(split(at(h, 'command'))[0]));
    } catch (error) {
      if (error instanceof Error && !(error instanceof KeyError) && !(error instanceof TypeError)) return false; // Unbalanced quoting
      throw error;
    }
  });
}

/** Native plugin files, mirroring the original unified-computer-use plugin (which has no skill). */
export function export_files(command, host_root) {
  const original = original_plugin(host_root);
  const manifest = loads(decode(readFileSync(join_path(original, '.codex-plugin/plugin.json'))));
  manifest.set('name', 'lcu');
  manifest.set('description', 'Computer use through the locally installed Codex runtime.');
  at(manifest, 'hooks').set('hooks', original_hooks(host_root));
  const descriptor = loads(decode(readFileSync(join_path(original, '.mcp.json'))));
  const servers = at(descriptor, 'mcpServers');
  const server = at(servers, 'cua_repl');
  servers.delete('cua_repl');
  server.set('command', command[0]);
  server.set('args', command.slice(1));
  server.set('enabled', true);
  servers.set('lcu', server);
  const contract = fromPlain({
    hooks: null,
    requestMetadata: 'Forward each real session_id and turn_id as x-codex-turn-metadata in MCP request _meta.',
    lifecycle: 'Call lcu.turn_ended when the host stops or interrupts a turn, including a subagent turn; substitute the original hook input variables with real host identifiers. Keep the MCP connection alive until cleanup finishes.',
    unsupportedHosts: 'Installing MCP alone does not supply turn lifecycle hooks. A host without equivalent hooks must implement this contract before claiming Codex lifecycle parity.',
    codexTrust: 'Codex requires trust for these exact hooks. Use lcu setup --agent codex or review and trust them in Codex; this export does not bypass hook trust.',
  });
  contract.set('hooks', at(at(manifest, 'hooks'), 'hooks'));
  const files = {};
  for (const [name, value] of [['.codex-plugin/plugin.json', manifest], ['.mcp.json', descriptor],
    ['lifecycle-contract.json', contract]]) {
    files[name] = Buffer.from(dumps(value, { indent: 2 }) + '\n');
  }
  return files;
}

/**
 * Match the native CLI's `CODEX_HOME ?? join(homedir, '.codex')` selection.
 *
 * The pinned Codex host resolves the home with nullish coalescing, so an
 * explicitly empty CODEX_HOME is kept verbatim (an unusable relative path)
 * rather than falling back to ~/.codex. Reject it with a clear error instead
 * of silently substituting a default, mirroring setup's absolute-path check.
 */
export function _selected_codex_home(env) {
  if (Object.hasOwn(env, 'CODEX_HOME') && env.CODEX_HOME === '') {
    throw new ValueError('CODEX_HOME is set but empty; unset it or set an absolute path');
  }
  if (env.CODEX_HOME) return join_path(env.CODEX_HOME);
  if (!Object.hasOwn(env, 'HOME')) throw new KeyError('HOME');
  return join_path(env.HOME, '.codex');
}

/**
 * Reject an installed Codex CLI that cannot parse the original MCP hook type.
 *
 * Registration also works before Codex CLI is installed. The probe has an
 * empty home and never starts a model or loads account configuration.
 */
export function require_cli_hook_support(env) {
  // The probe uses its own isolated home, but reject an explicitly empty
  // CODEX_HOME up front so setup fails clearly instead of at hook install.
  if (env.CODEX_HOME === '') throw new ValueError('CODEX_HOME is set but empty; unset it or set an absolute path');
  const executable = internals.which('codex', Object.hasOwn(env, 'PATH') ? env.PATH : null);
  if (!executable) return;
  const temporary = mkdtemp({ prefix: 'lcu-codex-hook-probe-' });
  try {
    const home = temporary;
    writeFileSync(join_path(home, 'config.toml'),
      '[hooks]\n' +
      'Stop = [{ hooks = [{ type = "mcp_tool", server = "lcu", ' +
      'tool = "turn_ended", input = { session_id = "s", turn_id = "t" } }] }]\n');
    const safe_env = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'PATHEXT']) {
      if (Object.hasOwn(env, key)) safe_env[key] = env[key];
    }
    Object.assign(safe_env, { HOME: temporary, CODEX_HOME: temporary });
    let version;
    let result;
    try {
      version = pyStrip(internals.run([executable, '--version'], {
        cwd: temporary, env: safe_env, stdin: 'devnull', capture: true, errors: 'replace', timeout: 10000,
      }).stdout);
      result = internals.run([executable, 'mcp', 'list'], {
        cwd: temporary, env: safe_env, stdin: 'devnull', capture: true, errors: 'replace', timeout: 20000,
      });
    } catch (error) {
      if (isOSError(error) || error instanceof SubprocessError) {
        throw new ValueError(`Cannot check installed Codex CLI hook support: ${error.message}`);
      }
      throw error;
    }
    if (result.returncode) {
      let detail = pyWords(result.stderr || result.stdout).join(' ');
      if (detail) detail = ` Codex reported: ${Array.from(detail).slice(-1000).join('')}. `;
      throw new ValueError(`Installed Codex CLI ${executable} (${version || 'unknown version'}) ` +
        'cannot load the original MCP lifecycle hooks.' + detail + ' ' +
        'Update this standalone Codex CLI to the latest public release with MCP tool hook ' +
        'support (official npm package: `npm install -g @openai/codex@latest`), then rerun ' +
        '`lcu setup --agent codex`.');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// bool(x) for the values a TOML/JSON document can hold.
const truthy = (value) => !(value === null || value === false || value === 0 || value === 0n || value === '' ||
  (Array.isArray(value) && value.length === 0) || (value instanceof Map && value.size === 0));

// str.removeprefix
const removeprefix = (text, prefix) => (text.startsWith(prefix) ? text.slice(prefix.length) : text);

// list.__contains__ by Python equality
const contains = (list, item) => list.some((other) => equal(other, item));

/**
 * Preserve scope and unrelated hooks; trust only the reviewed original records.
 *
 * The pinned native API writes user config only. A disposable CODEX_HOME lets
 * it edit either target scope without creating CLI state in the user's project.
 * Commit the target config and exact per-hook trust through concurrent-edit
 * guards. Project hook trust is stored in the selected user config.
 */
export function install_hooks(cli, config_path, cwd, env, host_root, notice_command = null) {
  config_path = regular_path(config_path);
  const before = read_file(config_path);
  const current = loadsBytes(before ?? Buffer.alloc(0));
  const trust_path = regular_path(join_path(_selected_codex_home(env), 'config.toml'));
  const trust_before = trust_path === config_path ? before : read_file(trust_path);
  loadsBytes(trust_before ?? Buffer.alloc(0));
  const hooks = deepcopy(current.has('hooks') ? current.get('hooks') : new Map());
  const expected = original_hooks(host_root);
  for (const [event, original] of expected) {
    if (!hooks.has(event)) hooks.set(event, []);
    const groups = hooks.get(event);
    if (!Array.isArray(groups)) throw new ValueError(`Invalid existing Codex hook list: ${event}`);
    for (const group of groups) {
      if (get(group, 'hooks', []).some((h) => get(h, 'server') === 'lcu' && get(h, 'tool') === 'turn_ended') &&
          !contains(original, group)) {
        throw new ValueError(`Existing LCU ${event} hook differs from upstream; review it before setup.`);
      }
    }
    for (const group of original) {
      if (!contains(groups, group)) groups.push(group);
    }
  }
  // LCU-owned update notices: replaced when present, removed when notice_command is None.
  const notices = new Map();
  const notice_edits = [];
  for (const event of NOTICE_EVENTS) {
    const existing = hooks.has(event) ? hooks.get(event) : [];
    if (!Array.isArray(existing)) throw new ValueError(`Invalid existing Codex hook list: ${event}`);
    const kept = existing.filter((g) => !is_notice_group(g, event));
    if (notice_command) {
      notices.set(event, notice_hook(notice_command, event));
      kept.push(notices.get(event));
    }
    if (!equal(kept, existing)) {
      hooks.set(event, kept);
      notice_edits.push({ keyPath: 'hooks.' + event, value: kept, mergeStrategy: 'replace' });
    }
  }
  const temporary = mkdtemp({ prefix: 'lcu-codex-config-' });
  let after;
  let trusted;
  try {
    // macOS tempfile paths can use /var while Codex reports /private/var.
    // Match the native writer's canonical source path for exact hook trust.
    const scratch = realpathSync(temporary);
    const config = join_path(scratch, 'config.toml');
    writeFileSync(config, before ?? Buffer.alloc(0));
    // The scratch home keeps account credentials and project layers out of
    // this configuration-only process. No model turn or hook is executed.
    const isolated = { ...env, HOME: temporary, CODEX_HOME: temporary };
    config_writer(cli, scratch, isolated, (call) => {
      const edits = [...expected.keys()].map((event) => ({ keyPath: 'hooks.' + event, value: hooks.get(event), mergeStrategy: 'replace' }));
      call('config/batchWrite', { edits: [...edits, ...notice_edits] });
      // Match the exact source path; unrelated/plugin hooks are not trusted.
      const listed = call('hooks/list', { cwds: [temporary] });
      const trust = [];
      for (const entry of at(listed, 'data')) {
        if (truthy(at(entry, 'errors'))) {
          throw new ValueError('Codex could not read lifecycle hooks: ' + dumps(at(entry, 'errors')));
        }
        for (const hook of at(entry, 'hooks')) {
          if (at(hook, 'sourcePath') === config && ['stop', 'interrupt', 'subagentStop'].includes(get(hook, 'eventName')) &&
              get(hook, 'server') === 'lcu' && get(hook, 'tool') === 'turn_ended') {
            const suffix = removeprefix(at(hook, 'key'), config);
            if (suffix === at(hook, 'key')) throw new ValueError('Upstream hook key format changed.');
            const key = config_path + suffix;
            trust.push({
              keyPath: 'hooks.state.' + dumps(key) + '.trusted_hash',
              value: at(hook, 'currentHash'), mergeStrategy: 'replace',
            });
          }
        }
      }
      let wanted = 0;
      for (const groups of expected.values()) for (const g of groups) wanted += at(g, 'hooks').length;
      if (trust.length !== wanted) {
        throw new ValueError('Codex did not discover exactly the original LCU lifecycle hooks.');
      }
      for (const [event, notice] of notices) {
        // Trust only the exact LCU notice command at this source path.
        const found = [];
        for (const entry of at(listed, 'data')) {
          for (const h of at(entry, 'hooks')) {
            if (at(h, 'sourcePath') === config && get(h, 'eventName') === event[0].toLowerCase() + event.slice(1) &&
                equal(get(h, 'command'), at(at(notice, 'hooks')[0], 'command'))) found.push(h);
          }
        }
        if (found.length !== 1) throw new ValueError(`Codex did not discover exactly the LCU ${event} update notice hook.`);
        const suffix = removeprefix(at(found[0], 'key'), config);
        if (suffix === at(found[0], 'key')) throw new ValueError('Upstream hook key format changed.');
        trust.push({
          keyPath: 'hooks.state.' + dumps(config_path + suffix) + '.trusted_hash',
          value: at(found[0], 'currentHash'), mergeStrategy: 'replace',
        });
      }
      after = readFileSync(config);
      if (trust_path !== config_path) {
        // Native Codex ignores project-provided hook trust. Store only
        // these path-specific approvals in the real user's config.
        writeFileSync(config, trust_before ?? Buffer.alloc(0));
      }
      call('config/batchWrite', { edits: trust });
    });
    trusted = readFileSync(config);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const changes = [new Change(config_path, before, trust_path === config_path ? trusted : after)];
  if (trust_path !== config_path) changes.push(new Change(trust_path, trust_before, trusted));
  apply_changes(changes);
  return config_path;
}
