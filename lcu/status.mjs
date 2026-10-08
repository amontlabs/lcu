// `lcu status`: the installed LCU release, the selected app, and whether the pair is tested.
const { existsSync, readFileSync } = process.getBuiltinModule('node:fs');
const { homedir } = process.getBuiltinModule('node:os');
const { join } = process.getBuiltinModule('node:path');
const { parseArgs } = process.getBuiltinModule('node:util');

import * as diagnosticLog from './diagnostic_log.mjs';
import { paths } from './runtime.mjs';
import * as update from './update.mjs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The signed-in account's remembered opt-ins, or null when none are saved or readable. */
async function savedSetup() {
  try {
    const { loadSetupState, setupStatePath } = await import('./setup.mjs');
    return existsSync(setupStatePath(homedir())) ? loadSetupState(homedir()) : null;
  } catch {
    return null;
  }
}

/** Machine-readable status for one release; throws when the app cannot be read. */
export async function collect(root) {
  const descriptorPath = join(root, 'installation.json');
  if (!existsSync(descriptorPath)) throw new Error(`No application is selected for this release: ${descriptorPath} is missing.`);
  const descriptor = readJson(descriptorPath);
  const bundle = join(root, 'bundle.json');
  const version = existsSync(bundle) ? readJson(bundle).version : 'source-checkout';
  const tested = await import('./tested.mjs');
  const resolved = paths(root, descriptor);
  const observed = tested.observe(root, descriptor, resolved.metadata);
  const saved = await savedSetup();
  return {
    lcu_version: version,
    release: root,
    platform: observed.platform,
    architecture: observed.architecture,
    app: { path: resolved.app, version: observed.appVersion, runtime: observed.runtime },
    compatibility: tested.assess(root, observed),
    changed_since_install: tested.changedSinceInstall(descriptor, { version: observed.appVersion, runtime: observed.runtime }),
    setup: saved,
    pending: saved ? saved.pending : [],
    update: update.cachedNotice(root),
    diagnostic_log: diagnosticLog.status(),
  };
}

const USAGE = 'usage: lcu status [-h] [--json]\n\nReport the installed LCU release, the selected app and whether the pair is tested.\n\n' +
  '  --json  print one JSON object instead of text\n';

/** `lcu status ARGV` for the release `root`; returns the exit status. */
export async function main(root, argv = []) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    process.stderr.write(`${USAGE}lcu status: ${error.message}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let status;
  try {
    status = await collect(root);
  } catch (error) {
    if (values.json) process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    else process.stderr.write(`lcu status: ${error.message}\n`);
    return 1;
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const tested = await import('./tested.mjs');
  const { app, setup: saved } = status;
  const lines = [`LCU ${status.lcu_version} (${status.platform} ${status.architecture}).`,
    `Original app: ChatGPT ${app.version} (CUA ${app.runtime}) at ${app.path}.`, ...tested.statusLines(status.compatibility)];
  if (status.changed_since_install) lines.push(`Warning: ${status.changed_since_install}`);
  if (saved) {
    lines.push(`Saved setup: chrome ${saved.chrome ? 'on' : 'off'}, audio ${saved.audio ? 'on' : 'off'}, approval ${saved.approval}.`);
    if (saved.pending.length) {
      lines.push(`Pending harnesses (not installed yet; \`lcu setup --reconcile\` registers them): ${saved.pending.join(', ')}.`);
    }
  }
  if (status.update) lines.push(update.statusLine(root));
  lines.push(diagnosticLog.summary());
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
