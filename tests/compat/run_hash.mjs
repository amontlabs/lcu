// Runner for test_hash.py: node run_hash.mjs <spec.json> ; spec: [{id, op, root, target, version, arch, file}]
import fs from 'node:fs';
import { dumps } from '../../lcu/compat/pyjson.mjs';
import {
  sha256File, inventory, manifestText, seal, verify, applicationInventory, inventorySha256, architecture,
} from '../../lcu/compat/hash.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const s of spec) {
  try {
    let value;
    if (s.op === 'sha256_file') value = sha256File(s.file);
    else if (s.op === 'inventory') value = dumps(inventory(s.root, s.target), { sort_keys: true });
    else if (s.op === 'seal') { seal(s.root, s.version, s.arch, s.target); value = fs.readFileSync(`${s.root}/bundle.json`, 'utf8'); }
    else if (s.op === 'verify') { verify(s.root, s.version, s.arch, s.target); value = 'ok'; }
    else if (s.op === 'manifest_text') value = manifestText(s.version, s.target, s.arch, inventory(s.root, s.target));
    else if (s.op === 'app_inventory') {
      const inv = applicationInventory(s.root);
      value = [dumps(inv, { sort_keys: true }), inventorySha256(inv)];
    } else if (s.op === 'architecture') value = architecture(s.target);
    else throw new Error(`unknown op ${s.op}`);
    out[s.id] = { ok: true, value };
  } catch (err) {
    out[s.id] = { ok: false, name: err.name, message: String(err.message) };
  }
}
process.stdout.write(JSON.stringify(out));
