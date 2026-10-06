// Stand-in for the upstream Chrome plugin's installer: writes native-host manifests next to the private copy.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { config, record, defaultManifests, hostRelative } = require('./fake-config.cjs');

export async function install(options) {
  const cfg = config().install || {};
  const here = dirname(fileURLToPath(import.meta.url));
  record({ tool: 'chrome-installManifest', options, argv: process.argv.slice(2), cwd: process.cwd(), here });
  if (cfg.stderr) process.stderr.write(cfg.stderr);
  if (cfg.stdout) process.stdout.write(cfg.stdout);
  if (cfg.exit) process.exit(cfg.exit);
  const host = join(here, '..', 'extension-host', ...hostRelative());
  const manifests = cfg.manifests || defaultManifests().map((file) => ({ file }));
  for (const item of manifests) {
    mkdirSync(dirname(item.file), { recursive: true });
    if (item.symlinkTo) { symlinkSync(item.symlinkTo, item.file); continue; }
    const target = item.host === undefined ? host : (isAbsolute(item.host) ? item.host : join(here, '..', item.host));
    const body = item.raw ?? JSON.stringify({
      name: 'com.openai.codexextension', description: 'OpenAI Codex extension host é ☃',
      path: item.nopath ? undefined : target, type: 'stdio',
      allowed_origins: ['chrome-extension://fakeextensionid/'], '2': 'numeric-looking key', zeta: { b: 1, a: [] },
    }, null, 2) + '\n';
    writeFileSync(item.file, body);
  }
}
