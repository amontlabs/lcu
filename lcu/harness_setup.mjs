// Local harness packages for Oh My Pi and Hermes; host configuration remains with their native installers.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { real } from './fsutil.mjs';
import { atomicWrite, checked, json, regularPath, seams, spacedJson } from './setup.mjs';

const MARKER = '.lcu-generated.json';

/** Replace only our own generated package at `destination` with `files`, run `register`, and restore it if that fails. */
function withPackage(destination, harness, files, register) {
  destination = regularPath(destination);
  const identity = { harness };
  if (existsSync(destination)) {
    const manifest = regularPath(join(destination, MARKER));
    let ours = false;
    try {
      ours = statSync(manifest).isFile() && JSON.stringify(JSON.parse(readFileSync(manifest, 'utf8'))) === JSON.stringify(identity);
    } catch {
      // not ours
    }
    if (!ours) throw new Error(`Refusing to replace an unowned plugin directory: ${destination}`);
    for (const name of readdirSync(destination, { recursive: true })) regularPath(join(destination, name));
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(join(dirname(destination), '.lcu-plugin-'));
  try {
    const stage = join(temporary, 'next');
    mkdirSync(stage);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      writeFileSync(join(stage, name), content);
    }
    writeFileSync(join(stage, MARKER), json(identity));
    const previous = join(temporary, 'previous');
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(stage, destination);
      return register(destination);
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function configureOmp(home, command, release, { scope, project, env }) {
  if (scope !== 'user') {
    throw new Error('Oh My Pi native plugin links are profile-scoped. Use --scope user with the intended OMP profile; project scope is not supported.');
  }
  const executable = seams.which('omp', env.PATH);
  if (!executable) throw new Error('Oh My Pi is not on the target account PATH. Install OMP, then rerun `lcu setup --agent omp`.');
  const adapter = join(release, 'adapters/pi/index.ts');
  if (!existsSync(adapter)) throw new Error(`LCU Pi/OMP adapter missing: ${adapter}`);
  // Separate package trees prevent profile setup from changing another registration's selected runtime command
  // or Chrome opt-in. The name derives from the identity as earlier releases wrote it, so it stays the same.
  const identity = [scope, project ? real(project) : '', ...['OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_DIR'].map((key) => env[key] ?? '')];
  const suffix = createHash('sha256').update(spacedJson(identity)).digest('hex').slice(0, 16);
  const data = join(home, process.platform === 'win32' ? 'AppData/Local/LCU' : '.local/share/lcu');
  const destination = join(data, 'omp', `${scope}-${suffix}`);
  const manifest = { name: 'lcu-computer-use', version: '0.1.0', private: true, type: 'module', omp: { extensions: ['./index.ts'] } };
  // OMP's compiled loader walks relative imports to resolve transitive npm dependencies. A file:// import
  // bypasses that graph in OMP 18.1.6.
  let specifier = relative(destination, adapter).replaceAll('\\', '/');
  if (isAbsolute(specifier)) throw new Error('OMP requires its generated plugin and the LCU release on the same filesystem drive.');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  const wrapper = `import lcu from ${JSON.stringify(specifier)};\n` +
    `export default pi => lcu(pi, {command: ${JSON.stringify(command)}, connectOnLoad: true, ompEssentialTools: true});\n`;
  withPackage(destination, 'omp', { 'package.json': json(manifest), 'index.ts': wrapper },
    (pkg) => checked('installer', executable, ['plugin', 'link', pkg], { cwd: home, env, timeout: 120_000 }));
}

export function configureHermes(home, command, node, release, { scope, env }) {
  if (scope !== 'user') {
    throw new Error('Hermes native plugins are profile-scoped. Use --scope user with the intended HERMES_HOME; project scope is not supported.');
  }
  const executable = seams.which('hermes', env.PATH);
  if (!executable) throw new Error('Hermes is not on the target account PATH. Install Hermes, then rerun `lcu setup --agent hermes`.');
  const root = env.HERMES_HOME || join(home, '.hermes');
  if (!isAbsolute(root)) throw new Error('HERMES_HOME must be absolute.');
  const source = join(release, 'adapters/hermes');
  const files = {};
  for (const name of ['plugin.yaml', '__init__.py']) {
    if (!existsSync(join(source, name))) throw new Error(`LCU Hermes plugin missing: ${join(source, name)}`);
    files[name] = readFileSync(join(source, name));
  }
  const bridge = join(source, 'bridge.mjs');
  if (!existsSync(bridge)) throw new Error(`LCU Hermes bridge missing: ${bridge}`);
  files['lcu-config.json'] = json({ command, node: String(node), bridge });
  withPackage(join(root, 'plugins/lcu-cua'), 'hermes', files,
    () => checked('installer', executable, ['plugins', 'enable', 'lcu-cua'], { cwd: home, env: { ...env, HERMES_HOME: root }, timeout: 120_000 }));
}


/** Where the DeepSeek Harness keeps its capability store, relative to the account home. */
export const DEEPSEEK_STATE = ['.dsh', 'bot', 'state.json'];

/**
 * Register LCU as a DeepSeek Harness MCP capability.
 *
 * The harness has no installer or registration CLI for MCP servers: its desktop app owns the
 * capability store in `~/.dsh/bot/state.json`. Setup therefore writes that one entry itself,
 * preserving every other value, keeping a backup of the previous file and publishing the result by
 * rename. The harness reads the store at start, so the person restarts it afterwards.
 */
export function configureDeepseek(home, mcpCommand, { clock = Date.now, scope = 'user' } = {}) {
  // The store is one file per account; the harness has no project-level capability scope.
  if (scope !== 'user') throw new Error('DeepSeek Harness capabilities are account-wide. Use --scope user.');
  if (!Array.isArray(mcpCommand) || mcpCommand.length < 2) {
    throw new TypeError('DeepSeek Harness registration needs the relay command');
  }
  const stateFile = join(home, ...DEEPSEEK_STATE);
  const stamp = clock();
  let before;
  try {
    before = readFileSync(stateFile, 'utf8');
  } catch {
    throw new Error(`DeepSeek Harness has no capability store at ${stateFile}. ` +
      'Start DeepSeek Harness once so it creates its profile, then rerun `lcu setup --agent deepseek`.');
  }
  let state;
  try {
    state = JSON.parse(before);
  } catch {
    throw new Error(`Refusing to edit a capability store that is not plain JSON: ${stateFile}`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`Refusing to edit an unexpected capability store: ${stateFile}`);
  }
  const objectAt = (parent, key) => {
    const current = parent[key];
    if (current === undefined) return (parent[key] = {});
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Refusing to edit ${stateFile}: ${key} is not an object`);
    }
    return current;
  };
  const items = objectAt(objectAt(state, 'capabilities'), 'items');
  const previous = items.lcu && typeof items.lcu === 'object' && !Array.isArray(items.lcu) ? items.lcu : {};
  items.lcu = {
    ...previous,
    name: 'lcu',
    kind: 'mcp',
    description: typeof previous.description === 'string' && previous.description
      ? previous.description : 'LCU: Codex computer-use runtime (control Mac desktop apps via ChatGPT.app CUA)',
    transport: 'stdio',
    command: mcpCommand[0],
    args: mcpCommand.slice(1),
    env: previous.env && typeof previous.env === 'object' && !Array.isArray(previous.env) ? previous.env : {},
    approved: true,
    createdAt: previous.createdAt ?? stamp,
    updatedAt: stamp,
  };
  // Keep the store exactly as private as it was: `atomicWrite` preserves an existing mode and creates
  // new files 0600, where a bare write would follow the account umask (0644 under 022). Capability
  // entries can carry private values in `env`, and the backup holds the same content as the store.
  const mode = statSync(stateFile).mode & 0o777;
  atomicWrite(`${stateFile}.lcu-backup`, before);
  atomicWrite(stateFile, json(state));
  chmodSync(`${stateFile}.lcu-backup`, mode);
  return stateFile;
}
