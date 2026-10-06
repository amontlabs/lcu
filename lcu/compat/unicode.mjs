// Python str behaviours that JavaScript strings do not have, code-point correct:
//
//   casefold(s)     str.casefold(): full Unicode case folding (CaseFolding.txt C+F, e.g. "ß" -> "ss",
//                   "ﬃ" -> "ffi", final sigma -> "σ"), NOT toLowerCase(). The table is generated from Python
//                   3.12 (Unicode 15.0) by tests/compat/gen_unicode_tables.py, so it does not depend on the
//                   ICU data of whichever Node runs LCU.
//   len(s)          len(str): number of code points (a JS string's .length counts UTF-16 units).
//   ljust(s, w)     str.ljust(w): pads with spaces to w CODE POINTS (not display columns, exactly like Python).
//   compare(a, b)   sort order of Python str: by code point (JS's default sort is by UTF-16 unit, which
//                   differs for astral characters versus U+E000..U+FFFF).
//   stem(name)      PurePath.stem of a final path component.
//
// Lone surrogates (JS strings can hold them, as Python str can) pass through unchanged.
import { CASEFOLD } from './unicode_tables.mjs';

let table = null;

function load() {
  table = new Map();
  for (const line of CASEFOLD.split('\n')) {
    if (!line) continue;
    const [cp, folded] = line.split('=');
    table.set(Number.parseInt(cp, 16),
      String.fromCodePoint(...folded.split(' ').map((hex) => Number.parseInt(hex, 16))));
  }
  return table;
}

export function casefold(text) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase(); // ASCII: only A-Z fold, to a-z
  const map = table ?? load();
  let out = '';
  for (const ch of text) out += map.get(ch.codePointAt(0)) ?? ch;
  return out;
}

export function len(text) {
  let count = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of text) count++;
  return count;
}

export function ljust(text, width) {
  const missing = width - len(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

export function compare(a, b) {
  const x = Array.from(a, (ch) => ch.codePointAt(0));
  const y = Array.from(b, (ch) => ch.codePointAt(0));
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Path(name).stem for a final component (pathlib: the suffix starts at the last dot, not a leading or trailing one). */
export function stem(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}
