// Batch runner for the argparse differential test: reads {shared, cases} as JSON on stdin, runs each case
// in-process against lcu/compat/argparse.mjs with captured output, and prints the results as JSON.
// Each result is {ns, stdout, stderr, code} (ns is json.dumps(vars(namespace), sort_keys=True, default=str) text).
import { readFileSync } from 'node:fs';
import { io, PySystemExit, pyStr } from '../../lcu/compat/argparse.mjs';
import { BUILDERS } from './argparse_parsers.mjs';

export function pyJson(value) {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (typeof value === 'string' || (typeof value === 'object' && typeof value.toJSON === 'function')) {
    const text = typeof value === 'string' ? value : pyStr(value);
    let out = '"';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const code = text.charCodeAt(i);
      if (ch === '\\' || ch === '"') out += `\\${ch}`;
      else if (code >= 0x20 && code <= 0x7e) out += ch;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\b') out += '\\b';
      else if (ch === '\f') out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return `${out}"`;
  }
  throw new Error(`cannot serialise ${value}`);
}

export function namespaceJson(namespace) {
  const entries = namespace.entries().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${pyJson(k)}: ${pyJson(v)}`).join(', ')}}`;
}

function runCase(parser, hooks, argv, shared) {
  let stdout = '';
  let stderr = '';
  io.stdout = (text) => { stdout += text; };
  io.stderr = (text) => { stderr += text; };
  io.exit = (status) => { throw new PySystemExit(status); };
  let ns = null;
  let code = 0;
  try {
    const args = hooks.pre(parser, argv);
    const namespace = parser.parse_args(args);
    hooks.post(parser, namespace, shared);
    ns = namespaceJson(namespace);
  } catch (error) {
    if (error instanceof PySystemExit) code = error.status;
    else return { exc: `${error.constructor.name}: ${error.message}`, stdout, stderr, ns: null, code: null };
  }
  return { ns, stdout, stderr, code };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { shared, cases } = JSON.parse(readFileSync(0, 'utf8'));
  const info = { ...shared.docs, clients: shared.clients, aliases: shared.aliases, scripts_dir: shared.scripts_dir };
  io.argv0 = () => '/x/tool';
  const built = new Map();
  const results = cases.map(({ parser: name, argv, columns }) => {
    if (columns === null) delete process.env.COLUMNS;
    else process.env.COLUMNS = columns;
    if (!built.has(name)) {
      const [builder, hooks] = BUILDERS[name];
      built.set(name, { parser: builder(info), hooks });
    }
    const { parser, hooks } = built.get(name);
    return runCase(parser, hooks, argv, info);
  });
  process.stdout.write(JSON.stringify(results));
}
