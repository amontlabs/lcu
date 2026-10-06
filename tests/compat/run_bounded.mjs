// Extract one archive and report how many bytes were inflated: node run_bounded.mjs <spec.json>
// spec: {kind: 'zip' | 'tar', archive, dest}. Output: {ok, name?, message?, inflated}.
import fs from 'node:fs';
import './inflate_mode.mjs';
import { inflateStats, usesFallback } from '../../lcu/compat/inflate.mjs';
import { extractLcuTar } from '../../lcu/compat/tar.mjs';
import { extractLcuZip } from '../../lcu/compat/zip.mjs';

const { kind, archive, dest } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let result;
try {
  (kind === 'zip' ? extractLcuZip : extractLcuTar)(archive, dest);
  result = { ok: true };
} catch (err) {
  result = { ok: false, name: err.name, message: String(err.message) };
}
result.inflated = inflateStats.written;
result.peak = inflateStats.peak;
result.fallback = usesFallback();
process.stdout.write(JSON.stringify(result));
