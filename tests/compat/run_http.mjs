// Scenario runner for test_http.py: node run_http.mjs <scenario.json>
// scenario: {op, url, env, timeout, notes, args, dest}
import fs from 'node:fs';
import {
  latestTag, severityOf, fetchLatest, fetchBytes, fetchToFile, urlopen, curl, caughtByUpdate, describeError, sha256File,
  registrySettings,
} from '../../lcu/compat/http.mjs';
import crypto from 'node:crypto';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function run(s) {
  const env = s.env ?? {};
  // The macOS system proxy configuration is injected (never read from the host): {proxies, exclude_simple, exceptions}.
  const registry = (values) => registrySettings(new Map(Object.entries(values).map(([name, value]) => [name,
    typeof value === 'number' ? { type: 'REG_DWORD', data: `0x${value.toString(16)}` } : { type: 'REG_SZ', data: String(value) }])));
  const systemProxy = () => {
    if (!s.system) return null;
    if (s.system.registry) return registry(s.system.registry);
    return { proxies: s.system.proxies ?? {}, excludeSimple: Boolean(s.system.exclude_simple), exceptions: s.system.exceptions ?? [] };
  };
  try {
  let value;
  if (s.op === 'latest_tag') value = await latestTag({ latestUrl: s.url, env, timeout: s.timeout ?? 5, systemProxy });
  else if (s.op === 'severity') value = await severityOf(s.tag ?? 'v1.0.0', '1.0.0', { notesTemplate: s.notes, env, timeout: s.timeout ?? 5, systemProxy });
  else if (s.op === 'fetch_latest') {
    value = await fetchLatest({ latestUrl: s.url, notesTemplate: s.notes, env, timeout: s.timeout ?? 5, systemProxy });
  } else if (s.op === 'fetch_bytes') {
    const data = await fetchBytes(s.url, { env, timeout: s.timeout, systemProxy });
    value = { length: data.length, sha: sha(data) };
  } else if (s.op === 'fetch_file') {
    const digest = await fetchToFile(s.url, s.dest, { env, timeout: s.timeout, stderr: { isTTY: false, write() {} }, systemProxy });
    const size = fs.existsSync(s.dest) ? fs.statSync(s.dest).size : null;
    value = { digest, size, filesha: size === null ? null : sha256File(s.dest) };
  } else if (s.op === 'open') {
    const response = await urlopen(s.url, { followRedirects: false, env, timeout: s.timeout ?? 5, systemProxy });
    value = response.status;
    response.close();
  } else if (s.op === 'curl') {
    const data = curl(s.args, { env, timeout: s.curl_timeout ?? 5 });
    value = { length: data.length, sha: sha(data) };
  } else throw new Error(`unknown op ${s.op}`);
  return { ok: true, value };
  } catch (err) {
    return { ok: false, name: err.name, message: String(describeError(err)), caught: caughtByUpdate(err) };
  }
}

if (process.argv[2] === '--serve') {
  // One JSON scenario per stdin line; one JSON result per stdout line.
  const rl = (await import('node:readline')).createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    process.stdout.write(JSON.stringify(await run(JSON.parse(line))) + '\n');
  }
} else {
  process.stdout.write(JSON.stringify(await run(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))));
}
