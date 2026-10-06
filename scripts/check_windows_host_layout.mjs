#!/usr/bin/env node
// Development check: can LCU extract the native-pipe host from an installed app.asar?
// Port of scripts/check_windows_host_layout.py (LCU 0.9.6, #20), which is now a trampoline to this file because the
// Python host module it imported is gone. Same arguments, output and exit codes. Not shipped in any archive.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ArgumentParser, io, PyPath, types } from '../lcu/compat/argparse.mjs';
import { dumps, loads } from '../lcu/compat/pyjson.mjs';
import { pyStrip } from '../lcu/compat/argparse.mjs';
import { pyStr } from '../lcu/compat/pyerr.mjs';
import { isOSError, run, SubprocessError } from '../lcu/compat/subprocess.mjs';
import { which } from '../lcu/compat/which.mjs';
import { plan_original_asar, write_original_host } from '../lcu/windows_host.mjs';

const DOC = `Development check: can LCU extract the native-pipe host from an installed app.asar?

Reads a user-supplied app.asar (any platform's ChatGPT build), reports the
structural result, writes the extraction to a temporary directory, loads the
generated module in plain Node with Electron blocked, and calls the factory
(listen, closeActiveTurn on an unknown turn, dispose). It never writes into the
app and removes its temporary files; do not commit anything it extracts.
`;

const PROBE = String.raw`
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request.startsWith('electron/')) throw new Error('blocked ' + request);
  return resolve.call(this, request, ...rest);
};
const factory = require(process.argv[2]);
(async () => {
  const host = await factory({codexCliPath: 'codex', nativePipeDirectory: process.argv[3],
    windowsHelperPath: 'helper.exe', windowsHelperTransportModulePath: 'transport.js'});
  const closed = await host.closeActiveTurn({sessionId: 'unknown', turnId: 'unknown'});
  await host.dispose();
  console.log(JSON.stringify({keys: Object.keys(host).sort(), closeActiveTurnUnknown: closed}));
})().catch(error => { console.error(error); process.exit(1); });
`;

class SystemExitText extends Error {}

export function main(argv = null) {
  const parser = new ArgumentParser({ prog: 'check_windows_host_layout.py', description: DOC });
  parser.add_argument('asar', { type: types.Path, help: 'path to the installed app.asar (read only)' });
  parser.add_argument('--node', { type: types.Path, default: new PyPath(which('node') ?? 'node'),
    help: 'Node executable that runs the analyzer and the load check' });
  const args = parser.parse_args(argv ?? process.argv.slice(2));
  const node = String(args.node);
  const plan = plan_original_asar(String(args.asar), { node });
  io.stdout(`main bundle: ${plan.main}\n`);
  io.stdout(`factory: ${plan.factory} (${Array.from(plan.module).length} generated characters)\n`);
  io.stdout(`top-level calls on imported modules not carried: ${plan.uncarried}\n`);
  io.stdout(`chunk files: ${plan.contents.size}\n`);
  for (const name of [...plan.contents.keys()].sort()) io.stdout(`  ${name}\n`);
  const scratch = mkdtempSync(path.join(tmpdir(), 'lcu-host-check-'));
  try {
    const entry = write_original_host(plan, path.join(scratch, 'host'));
    const generated = path.join(path.dirname(entry), plan.main.split('/').slice(0, -1).join('/'), 'lcu-original-pipe-host.cjs');
    const probe = path.join(scratch, 'probe.cjs');
    writeFileSync(probe, PROBE);
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\lcu-host-check-${randomUUID()}` : path.join(scratch, 'pipe');
    const result = run([node, probe, generated, pipe], { capture: true, timeout: 60000 });
    if (result.returncode !== 0) {
      io.stderr(`${pyStrip(result.stderr)}\n`);
      throw new SystemExitText('The generated module did not load and run in plain Node.');
    }
    io.stdout(`plain Node load with Electron blocked: ${dumps(loads(result.stdout))}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof SystemExitText) {
      io.stderr(`${error.message}\n`);
      process.exit(1);
    }
    if (error?.name === 'ValueError' || error instanceof SubprocessError || isOSError(error)) {
      io.stderr(`check_windows_host_layout: ${pyStr(error)}\n`);
      process.exit(1);
    }
    throw error;
  }
}
