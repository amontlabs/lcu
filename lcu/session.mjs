// Attach to one existing XFCE session owned by the calling account.
// Port of lcu/session.py.
import { readdirSync, readFileSync, statSync } from 'node:fs';

import { ArgumentParser, pyStrip, REMAINDER } from './compat/argparse.mjs';
import { findpwnam } from './compat/accounts.mjs';
import { execve, execvpe } from './compat/execve.mjs';
import { pathStr } from './compat/pathlib.mjs';
import { UnicodeDecodeError, ValueError } from './compat/pyjson.mjs';
import { decode } from './compat/utf8.mjs';

export const DOC = 'Attach to one existing XFCE session owned by the calling account.';
export const GUI_KEYS = ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE'];

/** Test injection points (Python's mock.patch targets). */
export const internals = {
  getuid: () => process.getuid(),
  execvpe,
  execve,
};

/**
 * os.execvpe(command[0], command, env). compat/execve re-ignores the signals the caller left ignored (Node reset
 * them at startup; Python's exec keeps them) after its own PATH search and checks, so errors stay os.execvpe's.
 * Limit of that path only: with ignored signals the program sees its resolved path as argv[0].
 */
export function exec_command(command, env) {
  return internals.execvpe(command[0], command, env);
}

// except (FileNotFoundError, ProcessLookupError, PermissionError, UnicodeError)
const skippable = (exc) => ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(exc?.code) || exc instanceof UnicodeDecodeError;

// str.isdigit() on a /proc entry name
const isdigit = (name) => /^\p{Nd}+$/u.test(name) || /^[\p{No}]+$/u.test(name);

/** Return the GUI environment of the one XFCE session `uid` owns; ValueError unless there is exactly one. */
export function discover(proc = '/proc', uid = null) {
  uid = uid === null ? internals.getuid() : uid;
  const sessions = new Map(); // tuple((key, value)...) as a Set of JSON texts
  proc = pathStr(proc);
  for (const entry of readdirSync(proc)) {
    if (!isdigit(entry)) continue;
    const process_path = pathStr(proc, entry);
    try {
      if (statSync(process_path).uid !== uid ||
          pyStrip(decode(readFileSync(pathStr(process_path, 'comm')))) !== 'xfce4-session') continue;
      const values = new Map();
      for (const item of decode(readFileSync(pathStr(process_path, 'environ'))).split('\0')) {
        const at = item.indexOf('=');
        if (at >= 0) values.set(item.slice(0, at), item.slice(at + 1));
      }
      if (values.get('DISPLAY') && values.get('DBUS_SESSION_BUS_ADDRESS')) {
        const tuple = GUI_KEYS.filter((key) => values.has(key)).map((key) => [key, values.get(key)]);
        sessions.set(JSON.stringify(tuple), tuple);
      }
    } catch (exc) {
      if (skippable(exc)) continue;
      throw exc;
    }
  }
  if (sessions.size !== 1) {
    throw new ValueError(`Expected one XFCE desktop for UID ${uid}; found ${sessions.size}. Start a desktop, or use ` +
                         '--session direct with an explicit GUI environment.');
  }
  return Object.fromEntries([...sessions.values()][0]);
}

/** The `lcu-session` command: process arguments are read like sys.argv[1:]. */
export function main() {
  const parser = new ArgumentParser({ description: DOC });
  parser.add_argument('--user', { required: true });
  parser.add_argument('command', { nargs: REMAINDER });
  const args = parser.parse_args();
  const account = findpwnam(args.user);
  if (!account) {
    throw new ValueError(`Unknown account: ${args.user}`);
  }
  if (account.pw_uid !== internals.getuid()) {
    throw new ValueError('Run the launcher as the selected desktop account.');
  }
  const command = args.command[0] === '--' ? args.command.slice(1) : args.command;
  if (command.length === 0) {
    parser.error('Provide a command after --');
  }
  const env = { ...process.env };
  for (const key of GUI_KEYS) {
    delete env[key];
  }
  Object.assign(env, discover());
  exec_command(command, env);
}
