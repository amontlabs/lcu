// Batch runner for test_xml_limits.py: node run_xml_limits.mjs  (stdin: [{id, b64}] -> stdout: {id: "OK" | "Name: message"})
import { readFileSync } from 'node:fs';

import { parseAppxManifest } from '../../lcu/compat/appx_xml.mjs';

const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
for (const { id, b64 } of cases) {
  try {
    parseAppxManifest(Buffer.from(b64, 'base64'));
    out[id] = 'OK';
  } catch (error) {
    out[id] = `${error.name}: ${error.message}`;
  }
}
process.stdout.write(JSON.stringify(out));
