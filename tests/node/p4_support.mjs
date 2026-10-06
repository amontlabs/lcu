// Shared support for the P4 setup-subsystem tests (approval, codex_hooks, claude_mod, claude_visibility,
// harness_setup, app_server). While the cut-over is in progress some sibling modules that lcu/setup.mjs imports
// may not exist yet; a resolve hook then substitutes an empty module for a MISSING lcu/*.mjs file only, so these
// tests exercise the real modules whenever they exist. Import this first, then import the modules with lcu().
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hook = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('./') && specifier.endsWith('.mjs') && context.parentURL && context.parentURL.includes('/lcu/')) {
    const url = new URL(specifier, context.parentURL);
    if (url.protocol === 'file:' && !existsSync(fileURLToPath(url))) {
      return { url: 'data:text/javascript,export default {}', shortCircuit: true };
    }
  }
  return next(specifier, context);
}`;
if (nodeModule.registerHooks) {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('./') && specifier.endsWith('.mjs') && context.parentURL?.includes('/lcu/')) {
        const url = new URL(specifier, context.parentURL);
        if (url.protocol === 'file:' && !existsSync(fileURLToPath(url))) {
          return { url: 'data:text/javascript,export default {}', shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
  });
} else {
  nodeModule.register('data:text/javascript,' + encodeURIComponent(hook));
}

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const lcu = (name) => import(new URL(`../../lcu/${name}.mjs`, import.meta.url).href);

/** tempfile.TemporaryDirectory() with a resolved path; removed after the test. */
export function tempdir(t, prefix = 'lcu-p4-') {
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/${prefix}`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
