// A configurable fake Codex: the app's `codex` entry point for scenarios that need the `app-server` JSON-RPC
// exchange to misbehave. Behaviour comes from the recorder config entry `app-codex`:
//   mode: ok | hooks-errors | count-mismatch | rpc-error | rpc-error-trust | server-request | exit-early | bad-key
//         | blank-line | notification | no-hooks | extra-notice | nonjson
//   version: stdout for `--version`
import { appendFileSync, mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { config, log } from './recorder.mjs';

const cfg = config('app-codex');
const mode = cfg.mode || 'ok';
const argv = process.argv.slice(2);
const entry = { tool: 'app-codex', argv, cwd: process.cwd() };
if (cfg.env) entry.env = Object.fromEntries(cfg.env.filter((key) => key in process.env).map((key) => [key, process.env[key]]));
log(entry);

if (!argv.includes('app-server')) {
  process.stdout.write(cfg.version || 'codex-cli 0.0.0-fake\n');
  process.exit(cfg.exit || 0);
}
if (mode === 'exit-early') process.exit(3);
if (mode === 'ignore-term') {
  // Outlive stdin EOF and SIGTERM, so the client's teardown has to escalate (it kills its own child).
  process.on('SIGTERM', () => log({ tool: 'app-codex:signal', signal: 'SIGTERM' }));
  setInterval(() => {}, 1000);
}

const home = process.env.CODEX_HOME || join(process.env.HOME, '.codex');
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);
const state = new Map();
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => out({ id, result });
const fail = (id, code, message) => out({ id, error: { code, message } });
let writes = 0;

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const message = JSON.parse(line);
  log({ tool: 'app-codex:rpc', ...(message.id === undefined ? {} : { hasId: true }), method: message.method ?? null,
        params: message.params ?? null, ...(message.result !== undefined ? { result: message.result } : {}),
        ...(message.error !== undefined ? { error: message.error } : {}) });
  if (message.method === undefined) continue; // an answer to a request this server made
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    if (mode === 'server-request') out({ id: 900, method: 'item/tool/requestUserInput', params: { q: 1 } });
    if (mode === 'notification') out({ method: 'thread/started', params: { n: 1 } });
    if (mode === 'blank-line') process.stdout.write('\n');
    if (mode === 'nonjson') process.stdout.write('not json\n');
    reply(message.id, { userAgent: 'fake-codex' });
  } else if (message.method === 'config/batchWrite') {
    writes += 1;
    if (mode === 'rpc-error' && writes === 1) { fail(message.id, -32000, 'config write refused'); continue; }
    if (mode === 'rpc-error-trust' && writes === 2) { fail(message.id, -32001, 'trust write refused'); continue; }
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
        command: hook.command, key: mode === 'bad-key' ? `other:${event}:${gi}:${hi}` : `${source}:${event}:${gi}:${hi}`,
        currentHash: `sha256:${event}:${gi}:${hi}`,
      })));
    }
    if (mode === 'hooks-errors') reply(message.id, { data: [{ errors: [{ message: 'bad hook' }], hooks }] });
    else if (mode === 'count-mismatch') reply(message.id, { data: [{ errors: [], hooks: hooks.slice(1) }] });
    else if (mode === 'no-hooks') reply(message.id, { data: [] });
    else if (mode === 'extra-notice') reply(message.id, { data: [{ errors: [], hooks: [...hooks, ...hooks.filter((h) => h.eventName === 'sessionStart')] }] });
    else reply(message.id, { data: [{ errors: [], hooks }] });
  } else reply(message.id, {});
}
