// How CPython prints an uncaught exception, for the errors lcu/entry.mjs sees:
//
//   Traceback (most recent call last):
//     File "/path/to/file", line 12, in name
//   TypeName: message
//
// The frames come from the Node stack (oldest first, node:internal frames dropped); the last line is the Python
// exception type and message the Python implementation would have raised for the same failure. The Python type
// is behaviour (scripts and the black-box `traceback` normaliser look at it); the frames are not.
//
//   python_exception(error, root)  -> { type, message }
//   format_traceback(error, root)  -> the complete text, ending in "\n"
import { fileURLToPath } from 'node:url';

import { fromNodeError, isOSError } from './pyerr.mjs';

// JavaScript built-in error classes and the Python class that stands for each.
const JS_TO_PYTHON = {
  Error: 'Exception',
  TypeError: 'TypeError',
  RangeError: 'ValueError',
  ReferenceError: 'NameError',
  SyntaxError: 'SyntaxError',
  EvalError: 'RuntimeError',
  URIError: 'ValueError',
  AggregateError: 'ExceptionGroup',
};

// "No module named 'lcu.macos_host'": the dotted name of a missing file below the release root, or the package.
function missing_module(error, root) {
  const message = String(error.message ?? '');
  const file = /^Cannot find module '([^']+)'/.exec(message);
  if (file) {
    let path = file[1];
    if (path.startsWith('file://')) path = fileURLToPath(path);
    if (root && path.startsWith(`${root}/`)) {
      return path.slice(root.length + 1).replace(/\.(mjs|cjs|js)$/, '').split('/').join('.');
    }
    return path;
  }
  const pkg = /^Cannot find package '([^']+)'/.exec(message);
  return pkg ? pkg[1] : message;
}

export function python_exception(error, root = null) {
  if (error === null || typeof error !== 'object') return { type: 'Exception', message: String(error) };
  if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
    return { type: 'ModuleNotFoundError', message: `No module named '${missing_module(error, root)}'` };
  }
  if (isOSError(error)) {
    // PyOSError is already Python's text; a raw Node system error is described the way Python would raise it.
    const os = fromNodeError(error);
    if (os) return { type: os.name, message: os.message };
  }
  const name = String(error.name ?? 'Error');
  if (Object.hasOwn(JS_TO_PYTHON, name)) return { type: JS_TO_PYTHON[name], message: String(error.message ?? '') };
  return { type: name.replace(/^Py(?=[A-Z])/, ''), message: String(error.message ?? '') };
}

const FRAME = /^\s+at (?:(.*?) \()?(.*?):(\d+):\d+\)?$/;

function frames_of(error) {
  const stack = typeof error?.stack === 'string' ? error.stack.split('\n') : [];
  const out = [];
  for (const line of stack) {
    const match = FRAME.exec(line);
    if (!match) continue;
    let [, fn, file, number] = match;
    if (!fn && file.startsWith('async ')) file = file.slice(6);
    if (file.startsWith('node:')) continue;
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        // keep the URL
      }
    }
    fn = (fn ?? '<module>').replace(/^(async |new )/, '');
    if (fn === 'Object.<anonymous>' || fn === 'file:' || fn.startsWith('file://')) fn = '<module>';
    out.push(`  File "${file}", line ${number}, in ${fn}\n`);
  }
  return out.reverse();
}

export function format_traceback(error, root = null) {
  const { type, message } = python_exception(error, root);
  let frames = frames_of(error);
  if (!frames.length) {
    // A Python traceback always has at least one frame; an error whose stack is all Node-internal (a failed
    // dynamic import) is placed at the module that asked for it, when Node says so.
    const importer = /imported from (\S+)$/.exec(String(error?.message ?? ''))?.[1];
    frames = [`  File "${importer ?? '<lcu>'}", line 1, in <module>\n`];
  }
  return `Traceback (most recent call last):\n${frames.join('')}${message ? `${type}: ${message}` : type}\n`;
}
