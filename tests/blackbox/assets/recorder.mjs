// Recorder used by every fake executable and fake original-runtime entry point.
// It appends one JSON line per invocation to $LCU_BB_LOG and then behaves per $LCU_BB_CONFIG.
import { appendFileSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// Harness variables, plus what the shell wrappers and macOS inject on exec (not set by LCU).
const HIDDEN = /^(LCU_BB_|PWD$|OLDPWD$|SHLVL$|_$|__CF_USER_TEXT_ENCODING$)/;

export function config(name) {
  let all = {};
  try { all = JSON.parse(readFileSync(process.env.LCU_BB_CONFIG, 'utf8')); } catch {}
  return all[name] || {};
}

function selectEnv(wanted) {
  if (wanted === '*') {
    return Object.fromEntries(Object.entries(process.env)
      .filter(([k]) => !HIDDEN.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  const out = {};
  for (const key of wanted || []) if (key in process.env) out[key] = process.env[key];
  return out;
}

export function log(entry) {
  appendFileSync(process.env.LCU_BB_LOG, JSON.stringify(entry) + '\n');
}

function pick(cfg, argv) {
  const text = argv.join(' ');
  for (const rule of cfg.rules || []) {
    if (rule.argv && !rule.argv.every((value, index) => argv[index] === value)) continue;
    if (rule.match && !new RegExp(rule.match).test(text)) continue;
    return rule;
  }
  return cfg.default || {};
}

function readStdin() {
  try { return readFileSync(0).toString('utf8'); } catch { return ''; }
}

const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

// A fake Codex `app-server`: records each JSON-RPC request and answers just what LCU's hook installer asks.
async function appServer(name) {
  const home = process.env.CODEX_HOME || join(process.env.HOME, '.codex');
  const state = new Map();
  const rl = createInterface({ input: process.stdin });
  const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
  for await (const line of rl) {
    const message = JSON.parse(line);
    if (message.method) log({ tool: name + ':rpc', method: message.method, params: message.params ?? null });
    if (message.id === undefined) continue;
    if (message.method === 'initialize') reply(message.id, { userAgent: 'fake-codex' });
    else if (message.method === 'config/batchWrite') {
      mkdirSync(home, { recursive: true });
      for (const edit of message.params.edits) {
        state.set(edit.keyPath, edit.value);
        appendFileSync(join(home, 'config.toml'), `# edit ${edit.keyPath} = ${JSON.stringify(edit.value)}\n`);
      }
      reply(message.id, { status: 'ok' });
    } else if (message.method === 'hooks/list') {
      const source = join(realpathSync(home), 'config.toml');
      const hooks = [];
      for (const [keyPath, groups] of state) {
        if (!keyPath.startsWith('hooks.') || keyPath.startsWith('hooks.state.')) continue;
        const event = keyPath.slice('hooks.'.length);
        groups.forEach((group, gi) => group.hooks.forEach((hook, hi) => hooks.push({
          sourcePath: source, eventName: lowerFirst(event), server: hook.server, tool: hook.tool,
          command: hook.command, key: `${source}:${event}:${gi}:${hi}`, currentHash: `sha256:${event}:${gi}:${hi}`,
        })));
      }
      reply(message.id, { data: [{ errors: [], hooks }] });
    } else reply(message.id, {});
  }
}

export async function run(name, argv, extra = {}) {
  const cfg = config(name);
  const entry = { tool: name, argv, cwd: process.cwd(), ...extra };
  // Not when this recorder is the process's main script: that is an exec chain (the shim's execve keeps the pid of
  // the wrapper-started Node), not the app's Node running the script that imports the recorder.
  if (process.env.LCU_BB_ARGV0 && process.env.LCU_BB_ARGV0_PID === String(process.pid) && !isMain()) entry.argv0 = process.env.LCU_BB_ARGV0;
  const env = selectEnv(cfg.env);
  if (Object.keys(env).length) entry.env = env;
  if (cfg.stdin) entry.stdin = readStdin();
  log(entry);
  if (cfg.appServer && argv.includes('app-server')) { await appServer(name); return; }
  const rule = pick(cfg, argv);
  if (rule.stdout) process.stdout.write(rule.stdout);
  if (rule.stderr) process.stderr.write(rule.stderr);
  if (rule.sleep) await new Promise((r) => setTimeout(r, rule.sleep));
  process.exitCode = rule.exit || 0;
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (process.argv[1] && isMain()) {
  await run(process.argv[2], process.argv.slice(3));
}
