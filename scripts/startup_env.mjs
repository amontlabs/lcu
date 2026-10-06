// Restore the launch channel scripts/install.sh (or the Windows bridge) filled (BRIEF addendum B), before any other
// LCU module is evaluated: imported FIRST by scripts/install*.mjs. The protocol and the variable list are the shared
// ones in lcu/startup_vars.mjs (every __LCU_* key consumed; quarantined Node startup variables restored as data).
// As lcu/entry.mjs does, it then
//   * refuses argv/environment bytes that are not UTF-8 (Python passed them on unchanged; Node strings cannot):
//     macOS through the shim's __LCU_ENV_INVALID flag, Linux through /proc/self/{environ,cmdline};
//   * keeps the signals the caller left ignored ignored in this process (Node reset them at startup).
import { readFileSync, writeSync } from 'node:fs';

import { QUARANTINED, restore_environment } from '../lcu/startup_vars.mjs';

export { QUARANTINED };

const PREFIX = { 'install.mjs': 'LCU installer: ', 'install_macos.mjs': 'LCU macOS installer: ',
  'install_windows.mjs': 'LCU Windows installer: ' };

// First non-UTF-8 entry among NUL-separated byte strings: the variable name ('' for an argument), else null.
function invalid_utf8(raw, environ) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let start = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw[i] === 0) {
      const item = raw.subarray(start, i);
      try {
        decoder.decode(item);
      } catch {
        if (!environ) return '';
        const at = item.indexOf(0x3d);
        return Buffer.from(item.subarray(0, at < 0 ? item.length : at)).toString('latin1');
      }
      start = i + 1;
    }
  }
  return null;
}

const { ignored, invalid } = restore_environment();
let bad = invalid ? '' : null;
if (process.platform === 'linux') {
  for (const file of ['/proc/self/environ', '/proc/self/cmdline']) {
    try {
      const name = invalid_utf8(readFileSync(file), file.endsWith('environ'));
      if (name !== null) bad = name;
    } catch {
      // /proc unavailable: nothing more to check
    }
    if (bad !== null) break;
  }
}
if (bad !== null) {
  const prefix = PREFIX[(process.argv[1] ?? '').split(/[\\/]/).at(-1)] ?? 'LCU installer: ';
  writeSync(2, `${prefix}${bad ? `The environment variable ${bad}` : 'An argument or environment variable'} is not valid `
    + 'UTF-8; LCU cannot pass it on unchanged. Unset or re-encode it and retry.\n');
  process.exit(1);
}
for (const name of ignored) process.on(`SIG${name}`, () => {});
