// Byte-identical ports of Python 3.12 shlex.quote / join / split (POSIX mode, comments=False)
// and subprocess.list2cmdline. Strings are handled by code point, as Python does.
// split() errors are the shared ValueError of compat/pyjson.mjs (since 2026-10-05; they used to be a
// plain Error with the same message), so callers can catch them like Python's `except ValueError`.

import { ValueError } from './pyjson.mjs';

const UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

/** shlex.quote */
export function quote(text) {
  if (typeof text !== 'string') throw new TypeError('quote() expects a string');
  if (text === '') return "''";
  if (!UNSAFE.test(text)) return text;
  return "'" + text.replaceAll("'", `'"'"'`) + "'";
}

/** shlex.join */
export function join(parts) {
  return Array.from(parts, quote).join(' ');
}

const WHITESPACE = ' \t\r\n';

/** shlex.split(text) (posix=True, comments=False). Throws ValueError (compat/pyjson.mjs) with Python's text. */
export function split(text) {
  const chars = Array.from(text);
  const tokens = [];
  let position = 0;
  const next = () => (position < chars.length ? chars[position++] : '');

  // One call of shlex.read_token with whitespace_split=True, no commenters, no punctuation_chars.
  const readToken = () => {
    let token = '';
    let quoted = false;
    let state = ' ';
    let escapedState = ' ';
    for (;;) {
      const c = next();
      if (state === ' ') {
        if (c === '') return null;
        if (WHITESPACE.includes(c)) {
          if (token || quoted) return token;
        } else if (c === '\\') {
          escapedState = 'a';
          state = c;
        } else if (c === "'" || c === '"') {
          state = c;
        } else {
          token = c;
          state = 'a';
        }
      } else if (state === "'" || state === '"') {
        quoted = true;
        if (c === '') throw new ValueError('No closing quotation');
        if (c === state) state = 'a';
        else if (c === '\\' && state === '"') {
          escapedState = state;
          state = c;
        } else token += c;
      } else if (state === '\\') {
        if (c === '') throw new ValueError('No escaped character');
        // In posix shells only the quote itself or the escape character may be escaped within quotes.
        if ((escapedState === "'" || escapedState === '"') && c !== state && c !== escapedState) token += state;
        token += c;
        state = escapedState;
      } else {
        // state 'a'
        if (c === '') return token || quoted ? token : null;
        if (WHITESPACE.includes(c)) {
          state = ' ';
          if (token || quoted) return token;
        } else if (c === "'" || c === '"') state = c;
        else if (c === '\\') {
          escapedState = 'a';
          state = c;
        } else token += c;
      }
    }
  };

  for (;;) {
    const token = readToken();
    if (token === null) return tokens;
    tokens.push(token);
  }
}

/** subprocess.list2cmdline */
export function list2cmdline(args) {
  const result = [];
  for (const arg of args) {
    let backslashes = [];
    if (result.length) result.push(' ');
    const needQuote = arg.includes(' ') || arg.includes('\t') || arg === '';
    if (needQuote) result.push('"');
    for (const c of arg) {
      if (c === '\\') backslashes.push(c);
      else if (c === '"') {
        result.push('\\'.repeat(backslashes.length * 2));
        backslashes = [];
        result.push('\\"');
      } else {
        if (backslashes.length) {
          result.push(...backslashes);
          backslashes = [];
        }
        result.push(c);
      }
    }
    if (backslashes.length) result.push(...backslashes);
    if (needQuote) {
      result.push(...backslashes);
      result.push('"');
    }
  }
  return result.join('');
}
