#!/usr/bin/env node
// Select an existing signed macOS app and install LCU's thin adapters.
// Port of scripts/install_macos.py. Run it through scripts/install.sh.
import './startup_env.mjs';
import { mkdirSync, readFileSync, closeSync, openSync, statSync, realpathSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isatty } from 'node:tty';

import { io, PyPath, types } from '../lcu/compat/argparse.mjs';
import { pathExpanduser } from '../lcu/compat/pathlib.mjs';
import { loads, ValueError } from '../lcu/compat/pyjson.mjs';
import { runProcess } from '../lcu/compat/runas.mjs';
import { resolve_installed_mac_app } from '../lcu/platforms.mjs';
import * as setupModule from '../lcu/setup.mjs';
import { report as reportTestedPair } from '../lcu/tested.mjs';
import { architecture, verify } from './bundle_runtime.mjs';
import {
  checked_prefix, forwarded_setup_arguments, run_main, select_release, SystemExit,
} from './install.mjs';

export const SOURCE = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
export const PROG = 'install_macos.py';
export const DOC = "Select an existing signed macOS app and install LCU's thin adapters.";

/** Injection points for tests (Python's mock.patch targets in tests/test_macos_installation.py). */
export const internals = {
  SOURCE,
  architecture,
  verify,
  resolve_installed_mac_app,
  checked_prefix,
  select_release,
  install: (prefix, application, options) => install(prefix, application, options),
  setup: { ...setupModule },
  run: runProcess,
  isatty: (fd) => isatty(fd),
  report: reportTestedPair,
};

const isDir = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

const dictGet = (map, key) => {
  if (!(map instanceof Map) || !map.has(key)) throw new Error(`KeyError: '${key}'`);
  return map.get(key);
};

export function install(prefix, application, { account = null } = {}) {
  prefix = internals.checked_prefix(prefix);
  const arch = internals.architecture('darwin');
  internals.verify(internals.SOURCE, arch, 'darwin');
  const policy = dictGet(dictGet(loads(readFileSync(join(internals.SOURCE, 'runtime.lock.json'), 'utf8')), 'platforms'), 'darwin');
  const architectures = policy.has('architectures') ? policy.get('architectures') : new Map();
  if (!architectures.has(arch)) {
    throw new ValueError(`This LCU release does not support macOS ${arch}`);
  }
  if (!isDir(pathExpanduser(String(application)))) {
    throw new ValueError(internals.setup.app_prerequisite_message(application, { alternate_location: true }));
  }
  const selected = internals.resolve_installed_mac_app(String(application), { arch });
  // Validate before creating the prefix or changing the selected release.
  mkdirSync(prefix, { recursive: true });
  closeSync(openSync(join(prefix, '.lcu-install'), 'a'));
  const now = new Date();
  utimesSync(join(prefix, '.lcu-install'), now, now);
  return internals.select_release(prefix, arch, selected.app, {
    platform: 'darwin', architecture: arch, package_version: selected.version,
    runtime: selected.runtime_version,
  }, { account, target: 'darwin', source: internals.SOURCE });
}

/** The installer parser: lcu.setup.parser() plus the macOS installer options (scripts/install_macos.py main()). */
export function build_parser() {
  const parser = internals.setup.parser();
  parser.prog = PROG;
  parser.description = DOC;
  parser.set_defaults({ prefix: new PyPath(`${homedir()}/.local/share/lcu`), session: 'direct' });
  parser.add_argument('--existing-app', {
    type: types.Path, default: new PyPath('/Applications/ChatGPT.app'),
    help: 'Existing signed ChatGPT.app; reused in place without modification',
  });
  parser.add_argument('--runtime-only', { action: 'store_true' });
  parser.add_argument('--offline', { action: 'store_true', help: 'Accepted for consistency; macOS setup always uses local files' });
  parser.add_argument('--skip-system', { action: 'store_true', help: 'Accepted for consistency; no system packages are installed' });
  return parser;
}

const truthy = (value) => value !== null && value !== undefined && value !== false && value !== '' &&
  !(Array.isArray(value) && value.length === 0);

export async function main(argv = null) {
  const parser = build_parser();
  const args = parser.parse_args(argv ?? process.argv.slice(2));
  const setup = internals.setup;
  if (args.get('list_agents')) {
    await setup.main(['--list-agents']);
    return;
  }
  if (args.get('reconcile')) {
    throw new ValueError('--reconcile runs after installation: use `lcu setup --reconcile` from the installed release.');
  }
  const [account, names] = setup.validate(args);
  if (args.get('session') !== 'direct') {
    throw new ValueError('macOS uses --session direct; XFCE session discovery is Linux-only');
  }
  if (args.get('runtime_only')) {
    if (truthy(args.get('agent')) || args.get('export') !== null || args.get('project') !== null
        || args.get('scope') !== 'user' || args.get('check_desktop') || args.get('chrome') || args.get('audio')
        || args.get('no_chrome') || args.get('no_audio') || args.get('approval') || args.get('allow_missing')) {
      throw new ValueError('--runtime-only cannot include agent setup options');
    }
  } else if (!truthy(names) && args.get('export') === null && (args.get('yes') || !internals.isatty(0))) {
    throw new ValueError('Select --agent NAME, --export PATH, or --runtime-only');
  }
  internals.install(args.get('prefix'), args.get('existing_app'), { account });
  const runtime = `${args.get('prefix')}/current/bin/lcu`;
  io.stdout(`LCU installed: ${runtime}\n`);
  io.stdout('The signed application is reused in place. Compatible updates are detected automatically.\n');
  if (args.get('runtime_only')) {
    // Agent setup reports this itself, before applying anything.
    internals.report(`${args.get('prefix')}/current`);
  }
  if (!args.get('runtime_only')) {
    const forwarded = forwarded_setup_arguments(args, args.get('prefix'), account, { session: 'direct' });
    const result = internals.run([runtime, 'setup', ...forwarded], { check: false });
    if (result.returncode) {
      io.stderr(`LCU runtime installed at ${runtime}, but setup failed; see the errors above. `
        + `After resolving the errors, retry: ${runtime} setup ${forwarded.join(' ')}\n`);
      throw new SystemExit(result.returncode);
    }
  }
  if (args.get('runtime_only')) {
    io.stdout('When you configure an agent interactively, LCU guides you through macOS privacy settings.\n');
    io.stdout(`You can review the guidance now with: ${runtime} doctor\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run_main(null, { prefix: 'LCU macOS installer', entry: main });
}
