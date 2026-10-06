// Python's int(str) and float(str) grammar for text that LCU does not control (PAX header values, URL ports):
// surrounding Unicode whitespace, a sign, single underscores between digits, Unicode decimal digits, and for float
// also inf/infinity/nan and exponents. A text Python would reject is null.
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const isDecimal = (cp) => cp > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp));

/** str.strip() */
export const pyStrip = (text) => {
  let start = 0, end = text.length;
  while (start < end && PY_SPACE.test(text[start])) start++;
  while (end > start && PY_SPACE.test(text[end - 1])) end--;
  return text.slice(start, end);
};

// float()/int() (CPython's _PyUnicode_TransformDecimalAndSpaceToASCII) turn NON-ASCII Unicode whitespace into spaces and
// Unicode decimal digits into ASCII digits. ASCII characters are left alone: only space, \t \n \v \f \r are skipped by the
// number parser afterwards, so the separators U+001C..U+001F stay and make the text invalid (round-2 R07).
const ASCII_BLANK = /[ \t\n\v\f\r]/;
function normalise(text) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) out += ASCII_BLANK.test(ch) ? ' ' : ch;
    else if (PY_SPACE.test(ch)) out += ' ';
    else if (isDecimal(cp)) {
      let base = cp;
      while (isDecimal(base - 1)) base--; // decimal digits come in runs of ten from the start of a contiguous block
      out += String((cp - base) % 10);
    } else out += ch;
  }
  return out.replace(/^ +| +$/g, '');
}
const badUnderscore = (t) => /(^|[^0-9])_|_([^0-9]|$)/.test(t);

/** CPython's limit on the digits of a decimal str -> int conversion (sys.int_info.default_max_str_digits). */
export const MAX_STR_DIGITS = 4300;

/**
 * The shared decimal int() grammar (the one argparse's type=int and this module's pyInt use):
 * {negative, digits} (digits: ASCII digit string without underscores), {error: 'invalid'} or {error: 'limit', count}.
 */
export function decimalInt(text) {
  const t = normalise(text);
  if (!/^[+-]?[0-9]+(_[0-9]+)*$/.test(t) || badUnderscore(t)) return { error: 'invalid' };
  const digits = t.replace(/^[+-]/, '').replace(/_/g, '');
  if (digits.length > MAX_STR_DIGITS) return { error: 'limit', count: digits.length };
  return { negative: t[0] === '-', digits };
}

/**
 * int(text) as a BigInt, or null when Python raises ValueError (`int(bytes, 16)`: pass base 16 and the decoded text).
 * Base 10 enforces the 4300-digit limit like CPython (a ValueError, so null); base 16 is a power-of-two conversion and
 * has no limit.
 */
export function pyInt(text, base = 10) {
  if (base === 16) {
    // bytes/str in base 16: ASCII white space, a sign, an optional 0x prefix (one underscore may follow it), digits
    // with single underscores between them.
    const t = text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
    const m = /^([+-]?)(?:0[xX]_?)?([0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)$/.exec(t);
    if (!m) return null;
    const value = BigInt('0x' + m[2].replace(/_/g, ''));
    return m[1] === '-' ? -value : value;
  }
  const parsed = decimalInt(text);
  if (parsed.error) return null;
  const value = BigInt(parsed.digits);
  return parsed.negative ? -value : value;
}

/** str.split(None, maxsplit): runs of white space separate tokens, the remainder after maxsplit splits keeps its tail. */
export function pySplit(text, maxsplit = -1) {
  const parts = [];
  let i = 0;
  const n = text.length;
  const isSpace = (ch) => PY_SPACE.test(ch);
  while (i < n) {
    while (i < n && isSpace(text[i])) i++;
    if (i >= n) break;
    if (maxsplit >= 0 && parts.length === maxsplit) { parts.push(text.slice(i)); break; }
    let j = i;
    while (j < n && !isSpace(text[j])) j++;
    parts.push(text.slice(i, j));
    i = j;
  }
  return parts;
}

/** float(text), or null when Python raises ValueError. */
export function pyFloat(text) {
  const t = normalise(text);
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (badUnderscore(t)) return null;
  const u = t.replace(/_/g, '');
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(u)) return null;
  return parseFloat(u);
}
