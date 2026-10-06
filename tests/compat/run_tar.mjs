// Batch runner for test_tar.py: node run_tar.mjs <spec.json>  (spec: [{id, archive, dest, mode}])
import fs from 'node:fs';
import './inflate_mode.mjs';
import { extractLcuTar, openTarGz, extractall } from '../../lcu/compat/tar.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const { id, archive, dest, mode } of spec) {
  try {
    if (mode === 'lcu') extractLcuTar(archive, dest);
    else {
      const opened = openTarGz(archive);
      try { extractall(opened, dest); } finally { opened.close(); }
    }
    out[id] = { ok: true };
  } catch (err) {
    out[id] = { ok: false, name: err.name, message: String(err.message) };
  }
}
process.stdout.write(JSON.stringify(out));
