// JS declarations of the real LCU parsers for the argparse differential test (twin of argparse_parsers.py).
// Each builder mirrors the Python construction in the source file named in its comment, using lcu/compat/argparse.mjs.
import os from 'node:os';
import path from 'node:path';
import {
  ArgumentDefaultsHelpFormatter, ArgumentParser, BooleanOptionalAction, RawDescriptionHelpFormatter, RawTextHelpFormatter,
  REMAINDER, SUPPRESS, types,
} from '../../lcu/compat/argparse.mjs';
import { parser as setupModuleParser } from '../../lcu/setup.mjs';

const { Path, int } = types;

const noHooks = { pre: (parser, argv) => argv, post: () => {} };

// lcu/setup.py parser(): single-sourced from lcu/setup.mjs (its description DOC is checked against docs.setup by the
// differential's help comparison).
function setupParser() {
  return setupModuleParser();
}

// lcu/apps.py parser()
const APPS_USAGE = 'lcu apps [list] [--json]\n       lcu apps allow <app>\n       lcu apps revoke <app>';
function appsParser() {
  const top = new ArgumentParser({
    prog: 'lcu apps',
    usage: APPS_USAGE,
    formatter_class: RawDescriptionHelpFormatter,
    description: 'Manage the apps Computer Use may always control, without the Codex app.',
    epilog: '<app> is an app name ("Zed"), a bundle identifier (dev.zed.Zed) or the path to an .app.\n'
      + 'allow and revoke ask for Touch ID or your login password; list does not.',
  });
  const sub = top.add_subparsers({ dest: 'action' });
  const listing = sub.add_parser('list', { usage: 'lcu apps list [--json]', help: 'show the always-allowed apps' });
  listing.add_argument('--json', { action: 'store_true', help: 'print JSON instead of a table' });
  for (const [name, summary] of [
    ['allow', 'always allow an app (asks for Touch ID or your password)'],
    ['revoke', 'remove an app (asks for Touch ID or your password)'],
  ]) {
    const command = sub.add_parser(name, { usage: `lcu apps ${name} <app>`, help: summary });
    command.add_argument('app', { help: 'app name, bundle identifier or .app path' });
  }
  return top;
}

const appsHooks = {
  pre(parser, argv) {
    const args = [...argv];
    if (!args.length || (args[0].startsWith('-') && !['-h', '--help'].includes(args[0]))) args.unshift('list');
    return args;
  },
  post(parser, args) {
    if (args.get('action') === null) args.set('json', false);
  },
};

// lcu/browser.py main()
function browserParser(docs) {
  const parser = new ArgumentParser({ description: docs.browser });
  const subparsers = parser.add_subparsers({ dest: 'action', required: true });
  const setup = subparsers.add_parser('install', { help: 'Install the original native host for the current desktop account' });
  setup.add_argument('--directory', { type: Path, help: 'Private writable host directory' });
  const check = subparsers.add_parser('status', { help: 'Check extension and connector setup without changing the browser' });
  check.add_argument('--browser', { choices: ['chrome', 'edge'], default: 'chrome' });
  return parser;
}

const browserHooks = {
  pre(parser, argv) {
    if (argv.length >= 1 && (argv[0] === 'serve' || argv[0] === 'protocol')) {
      parser.error('the in-app browser host and codex:// protocol commands were removed; use the installed app browser. For external Chrome, run `lcu browser install` and enable the official ChatGPT extension.');
    }
    return argv;
  },
  post() {},
};

// lcu/doctor.py main()
function doctorParser() {
  const parser = new ArgumentParser({ description: 'Check the original desktop provider and guide first-use permissions.' });
  parser.add_argument('--non-interactive', { action: 'store_true', help: 'Check without prompts or opening System Settings' });
  parser.add_argument('--require-ready', { action: 'store_true', help: 'Exit nonzero unless this platform can verify desktop readiness' });
  return parser;
}

// lcu/session.py main()
function sessionParser(docs) {
  const parser = new ArgumentParser({ description: docs.session });
  parser.add_argument('--user', { required: true });
  parser.add_argument('command', { nargs: REMAINDER });
  return parser;
}

const sessionHooks = {
  pre: (parser, argv) => argv,
  post(parser, args) {
    const raw = args.get('command');
    const command = raw[0] === '--' ? raw.slice(1) : raw;
    if (!command.length) parser.error('Provide a command after --');
    args.set('command', command);
  },
};

// lcu/maintenance.py main()
function pruneParser() {
  const parser = new ArgumentParser({ prog: 'lcu prune', description: 'Remove superseded LCU release and app generations.' });
  parser.add_argument('--keep', { type: int, default: 2, help: 'Number of releases to keep, including current (minimum 1).' });
  parser.add_argument('--yes', { action: 'store_true', help: 'Delete instead of a dry run.' });
  return parser;
}

// lcu/status.py main()
function statusParser(docs) {
  const parser = new ArgumentParser({ prog: 'lcu status', description: docs.status });
  parser.add_argument('--json', { action: 'store_true', help: 'Print one JSON object instead of text' });
  return parser;
}

// lcu/update.py main()
function updateParser(docs) {
  const parser = new ArgumentParser({ prog: 'lcu update', description: docs.update });
  const mode = parser.add_mutually_exclusive_group();
  mode.add_argument('--check', { action: 'store_true', help: 'Check now without installing' });
  mode.add_argument('--notice', { action: 'store_true', help: 'Print the cached update notice for an agent (never uses the network)' });
  mode.add_argument('--refresh', { action: 'store_true', help: SUPPRESS });
  mode.add_argument('--post-install', { action: 'store_true', help: SUPPRESS });
  parser.add_argument('--json', { action: 'store_true', help: 'Print JSON (with --check or --notice)' });
  parser.add_argument('--hook', { choices: ['SessionStart', 'UserPromptSubmit'], help: SUPPRESS });
  parser.add_argument('--yes', { action: 'store_true', help: 'Do not ask before installing' });
  return parser;
}

// scripts/install.py main()
function installParser(docs) {
  const parser = setupParser(docs);
  parser.description = `${docs.install} Requires Linux, X11 and D-Bus; apt system provisioning requires root.`;
  parser.add_argument('--runtime-only', { action: 'store_true', help: 'Install without registering an agent' });
  parser.add_argument('--skip-system', { action: 'store_true', help: 'Skip apt; system libraries must already exist' });
  parser.add_argument('--app-package', { type: Path, help: 'Removed: install the app yourself; this option now fails' });
  parser.add_argument('--existing-app', { type: Path, help: 'Use an already installed app outside the default /usr/lib/chatgpt location' });
  parser.add_argument('--offline', { action: 'store_true', help: 'Never use the network; requires --skip-system and preinstalled system libraries' });
  return parser;
}

const installHooks = {
  pre(parser, argv) {
    const args = [...argv];
    if (args.length && !args[0].startsWith('-')) return ['--prefix', args[0], ...args.slice(1)];
    return args;
  },
  post() {},
};

// scripts/install_macos.py main()
function installMacosParser(docs) {
  const parser = setupParser(docs);
  parser.description = docs.install_macos;
  parser.set_defaults({ prefix: Path(`${os.homedir()}/.local/share/lcu`), session: 'direct' });
  parser.add_argument('--existing-app', { type: Path, default: Path('/Applications/ChatGPT.app'), help: 'Existing signed ChatGPT.app; reused in place without modification' });
  parser.add_argument('--runtime-only', { action: 'store_true' });
  parser.add_argument('--offline', { action: 'store_true', help: 'Accepted for consistency; macOS setup always uses local files' });
  parser.add_argument('--skip-system', { action: 'store_true', help: 'Accepted for consistency; no system packages are installed' });
  return parser;
}

// scripts/install_windows.py main()
function installWindowsParser(docs) {
  const parser = new ArgumentParser({ description: docs.install_windows });
  const base = process.env.LOCALAPPDATA ?? `${os.homedir()}/AppData/Local`;
  parser.add_argument('--prefix', { type: Path, default: Path(`${base}/LCU`) });
  parser.add_argument('--runtime-only', { action: 'store_true' });
  parser.add_argument('--agent', { action: 'append', choices: [...docs.clients, ...docs.aliases] });
  parser.add_argument('--chrome', { action: 'store_true' });
  parser.add_argument('--no-chrome', { action: 'store_true' });
  parser.add_argument('--audio', { action: 'store_true' });
  parser.add_argument('--no-audio', { action: 'store_true' });
  parser.add_argument('--yes', { action: 'store_true' });
  parser.add_argument('--scope', { choices: ['user', 'project'], default: 'user' });
  parser.add_argument('--project', { type: Path });
  return parser;
}

const installWindowsHooks = {
  pre: (parser, argv) => argv,
  post(parser, args, docs) {
    const g = (k) => args.get(k);
    const truthy = (v) => v !== null && v !== false && v !== undefined && !(Array.isArray(v) && !v.length) && v !== '';
    if (g('runtime_only') && (truthy(g('agent')) || g('chrome') || g('audio') || g('no_chrome') || g('no_audio') || truthy(g('project')) || g('scope') !== 'user')) {
      parser.error('--runtime-only cannot include agent setup options');
    }
    if (!g('runtime_only') && !truthy(g('agent'))) parser.error(`Choose --agent NAME or --runtime-only. Agents: ${docs.clients.join(', ')}`);
  },
};

// scripts/provision_agent_tools.py main()
function provisionParser(docs) {
  const parser = new ArgumentParser({ description: docs.provision });
  parser.add_argument('--release', { type: Path, required: true });
  parser.add_argument('--source', { type: Path, default: Path(`${docs.scripts_dir}/agent-tools`) });
  parser.add_argument('--target', { choices: ['linux', 'darwin', 'windows'], default: 'linux' });
  parser.add_argument('--mac-node', { type: Path });
  parser.add_argument('--adapters-source', { type: Path });
  return parser;
}

// Not an LCU parser (see argparse_parsers.py build_kitchen).
function kitchenParser() {
  const parent = new ArgumentParser({ add_help: false });
  parent.add_argument('--common', { action: 'store_true', help: 'from the parent' });
  const p = new ArgumentParser({
    prog: 'kitchen',
    parents: [parent],
    formatter_class: ArgumentDefaultsHelpFormatter,
    description: 'Kitchen sink   with   odd spacing, long enough to need wrapping at a narrow terminal.',
    epilog: 'Epilog for %(prog)s.',
  });
  p.add_argument('pos', { nargs: '?', default: 'dflt', help: 'optional positional' });
  p.add_argument('rest', { nargs: '*', metavar: 'REST' });
  p.add_argument('-n', '--num', { type: int, nargs: 2, metavar: ['A', 'B'], help: 'two ints' });
  p.add_argument('-c', { action: 'count' });
  p.add_argument('--const', { action: 'store_const', const: 7, dest: 'seven' });
  p.add_argument('--ac', { action: 'append_const', const: 'z', dest: 'zs' });
  p.add_argument('--ext', { action: 'extend', nargs: '+' });
  p.add_argument('--flag', { action: BooleanOptionalAction, default: true });
  p.add_argument('--opt', { nargs: '?', const: 'C', default: 'D', choices: ['C', 'D', 'E'] });
  const group = p.add_mutually_exclusive_group({ required: true });
  group.add_argument('--ga');
  group.add_argument('--gb', { action: 'store_true' });
  const extra = p.add_argument_group({ title: 'extra', description: 'extra description' });
  extra.add_argument('--long-option-name-that-is-quite-long', { metavar: 'VALUE_WITH_LONG_NAME', help: `a ${'long help '.repeat(20)}` });
  const sub = p.add_subparsers({ title: 'cmds', description: 'sub desc', metavar: 'CMD', dest: 'cmd' });
  const one = sub.add_parser('one', { aliases: ['uno'], help: 'the first' });
  one.add_argument('--inner', { action: 'store_true' });
  sub.add_parser('two', { help: 'the second' });
  return p;
}

function kitchen2Parser() {
  const p = new ArgumentParser({
    prog: 'k2',
    allow_abbrev: false,
    formatter_class: RawTextHelpFormatter,
    prefix_chars: '-+',
    argument_default: SUPPRESS,
    description: 'Line one\n  indented line two',
    usage: '%(prog)s [options] <things...>',
  });
  p.add_argument('+x', '++extra', { action: 'store_true', help: 'plus option\n  second line' });
  p.add_argument('-y', { type: int, help: 'y value' });
  p.add_argument('things', { nargs: '+', help: 'things to do' });
  p.add_argument('--opt', { action: 'append', dest: 'opts', help: 'repeatable' });
  p.add_argument('-v', { action: 'store_false', dest: 'quiet' });
  p.add_argument('--n3', { nargs: 3, type: int });
  p.add_argument('--star', { nargs: '*' });
  p.add_argument('--rem', { nargs: REMAINDER });
  return p;
}

// See build_numeric / build_negopt in argparse_parsers.py.
function numericParser() {
  const p = new ArgumentParser({ prog: 'numeric' });
  p.add_argument('--n', { type: int, choices: [1, 2, 9007199254740993n, -3], default: 2 });
  p.add_argument('--keep', { type: int, default: 2 });
  p.add_argument('--big', { type: int, default: 2n ** 60n });
  p.add_argument('--e', { type: int, choices: [true, 0], default: 0 });
  p.add_argument('pos', { nargs: '*', type: int });
  return p;
}

function negoptParser() {
  const p = new ArgumentParser({ prog: 'negopt' });
  p.add_argument('-1', { dest: 'one', action: 'store_true' });
  p.add_argument('--val');
  p.add_argument('pos', { nargs: '*' });
  return p;
}

export const BUILDERS = {
  setup: [setupParser, noHooks],
  apps: [appsParser, appsHooks],
  browser: [browserParser, browserHooks],
  doctor: [doctorParser, noHooks],
  session: [sessionParser, sessionHooks],
  prune: [pruneParser, noHooks],
  status: [statusParser, noHooks],
  update: [updateParser, noHooks],
  install: [installParser, installHooks],
  install_macos: [installMacosParser, noHooks],
  install_windows: [installWindowsParser, installWindowsHooks],
  provision: [provisionParser, noHooks],
  kitchen: [kitchenParser, noHooks],
  kitchen2: [kitchen2Parser, noHooks],
  numeric: [numericParser, noHooks],
  negopt: [negoptParser, noHooks],
};
