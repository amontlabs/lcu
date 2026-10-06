// Fake `SkyComputerUseClient` (the signed macOS client the lifecycle host runs as `client turn-ended PAYLOAD`).
// Records argv, cwd, full environment and what kind of file descriptor 0 is, then behaves per $RT_CLIENT:
//   {"rules": [{"match": "<regex on argv.slice(1).join(' ')>", "exit": n, "sleepMs": n, "stdout": bytes,
//               "stderr": bytes, "say": "text for stderr"}], "default": {...}}
import { appendFileSync, fstatSync, writeSync } from 'node:fs';

const HIDDEN = /^(LCU_BB_|RT_|PWD$|OLDPWD$|SHLVL$|_$|__CF_USER_TEXT_ENCODING$)/;
const cfg = JSON.parse(process.env.RT_CLIENT || '{}');
const argv = process.argv.slice(2);
const kind = (() => {
  try {
    const info = fstatSync(0);
    return info.isFIFO() ? 'pipe' : info.isCharacterDevice() ? 'chr' : info.isFile() ? 'file' : info.isSocket() ? 'socket' : 'other';
  } catch { return 'closed'; }
})();
const entry = { tool: 'SkyComputerUseClient', argv, cwd: process.cwd(), stdinKind: kind,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !HIDDEN.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
if (cfg.quietEnv) delete entry.env;
appendFileSync(process.env.LCU_BB_LOG, JSON.stringify(entry) + '\n');

const text = argv.slice(1).join(' ');
const rule = (cfg.rules || []).find((r) => new RegExp(r.match).test(text)) || cfg.default || {};
const fill = (bytes) => Buffer.alloc(bytes, 'x');
const writeAll = (fd, buffer) => { let o = 0; while (o < buffer.length) { try { o += writeSync(fd, buffer, o); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } };
if (rule.stdout) writeAll(1, fill(rule.stdout));
if (rule.stderr) writeAll(2, fill(rule.stderr));
if (rule.say) writeAll(2, Buffer.from(rule.say));
if (rule.sleepMs) await new Promise((resolve) => setTimeout(resolve, rule.sleepMs));
process.exitCode = rule.exit || 0;
