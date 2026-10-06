// Bridge from the Python test drivers to LCU's Node modules (tests/lcu_bridge.py is the Python side).
//
// LCU's runtime is Node; the developer/acceptance drivers under tests/ stay Python. Where a driver used to
// `from lcu.<module> import <function>` it now calls the same function of <root>/lcu/<module>.mjs through this
// script (one process per call), and anything that is a real entry point (bin/lcu, scripts/install.sh) is run as
// a subprocess by the driver itself. Nothing here re-implements LCU behaviour: it only loads the module, calls
// the exported function and converts the result to JSON.
//
//   node lcu_bridge.mjs call          request JSON on stdin
//        {root, module, function, args: [...], options: {...}|null, call_env: {...}|null}
//        -> prints anything the function printed, then a line  \0LCU-BRIDGE-RESULT\0{"ok":true,"result":...,"args":[...]}
//           (args are echoed after the call so a function that fills a caller-supplied dict, such as
//           runtime._configure_macos_lifecycle(root, runtime, env), can be observed)
//   node lcu_bridge.mjs app_server    request JSON on the first stdin line {root, cli, cwd, env}; then JSON lines
//        {op: 'call', method, params, timeout?} | {op: 'receive', timeout} | {op: 'close'}; one reply line each.
//        Drives lcu/app_server.mjs's AppServer exactly as `with app_server(cli, cwd, env) as api:` did.
//
// `options` is the trailing options object that Python keyword-only parameters became (CONVENTIONS.md).
import { readSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = '\0LCU-BRIDGE-RESULT\0';

function plain(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  if (value instanceof Set || Array.isArray(value)) return [...value].map(plain);
  if (typeof value === 'object') {
    if (typeof value.value === 'number' && value.constructor?.name === 'PyFloat') return value.value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function failure(error) {
  return { ok: false, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack ?? '' } };
}

function readAll() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EOF') break;
      throw error;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

let pending = Buffer.alloc(0);
function readLine() {
  const buffer = Buffer.alloc(65536);
  for (;;) {
    const newline = pending.indexOf(0x0a);
    if (newline !== -1) {
      const line = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      return line;
    }
    let n;
    try {
      n = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      if (error.code === 'EOF') return null;
      throw error;
    }
    if (n === 0) return null;
    pending = Buffer.concat([pending, buffer.subarray(0, n)]);
  }
}

async function load(root, module) {
  return import(pathToFileURL(join(root, 'lcu', `${module}.mjs`)).href);
}

async function callMode() {
  const request = JSON.parse(readAll());
  let reply;
  try {
    const target = await load(request.root, request.module);
    if (typeof target[request.function] !== 'function') throw new Error(`${request.module}.mjs has no function ${request.function}`);
    const args = request.args ?? [];
    const result = await target[request.function](...args, ...(request.options ? [request.options] : []));
    reply = { ok: true, result: plain(result), args: plain(args) };
  } catch (error) {
    reply = failure(error);
  }
  process.stdout.write(`${MARK}${JSON.stringify(reply)}\n`);
}

async function appServerMode() {
  const request = JSON.parse(readLine());
  const reply = (value) => process.stdout.write(`${MARK}${JSON.stringify(value)}\n`);
  let module;
  try {
    module = await load(request.root, 'app_server');
  } catch (error) {
    reply(failure(error));
    return;
  }
  try {
    module.app_server(request.cli, request.cwd, request.env, (api) => {
      reply({ ok: true, ready: true, initialization: plain(api.initialization) });
      for (;;) {
        const line = readLine();
        if (line === null) return;
        const command = JSON.parse(line);
        if (command.op === 'close') return;
        try {
          if (command.op === 'call') {
            reply({ ok: true, result: plain(api(command.method, command.params, command.timeout ?? 45)) });
          } else if (command.op === 'receive') {
            reply({ ok: true, result: plain(api.receive(command.timeout)) });
          } else {
            throw new Error(`unknown operation ${command.op}`);
          }
        } catch (error) {
          reply(failure(error));
        }
      }
    });
    reply({ ok: true, closed: true });
  } catch (error) {
    reply(failure(error));
  }
}

const mode = process.argv[2];
if (mode === 'call') await callMode();
else if (mode === 'app_server') await appServerMode();
else {
  process.stderr.write('usage: lcu_bridge.mjs call|app_server\n');
  process.exitCode = 2;
}
