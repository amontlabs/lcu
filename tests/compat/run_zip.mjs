// Batch runner for test_zip.py: node run_zip.mjs <spec.json>  (spec: [{id, archive, dest}])
import fs from 'node:fs';
import './inflate_mode.mjs';
import { extractLcuZip } from '../../lcu/compat/zip.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const { id, archive, dest } of spec) {
  try {
    extractLcuZip(archive, dest);
    out[id] = { ok: true };
  } catch (err) {
    out[id] = { ok: false, name: err.name, message: String(err.message) };
  }
}
process.stdout.write(JSON.stringify(out));
