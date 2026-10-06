// =============================================================================================
// CALLER RULES (binding for every porter; the same rules head lcu/compat/pyjson.mjs and
// .port/notes/compat-caller-rules.md)
//  1. Parsed namespace: read `args.keep`, `args.yes` (plain property access, like Python). Unset attributes are
//     `undefined`; use args.has('x') / 'x' in args when presence matters. vars(args) is args.vars() (an order-
//     preserving Map, ready for pyjson dumps()); a Namespace itself is not JSON-serialisable (neither is Python's).
//     A dest named get/set/has/delete/entries/vars/toObject must be read as args.get('get') (methods win).
//  2. ints: types.int and integer defaults are plain Numbers whenever Number.isSafeInteger, BigInt only beyond
//     (e.g. `--keep=9007199254740993`). Write integer defaults as plain numbers (`default: 2`), use BigInt literals
//     only for values past 2^53, and follow pyjson rule 1 (isInt, normInt, no Number/BigInt mixing: clamp
//     `--keep` to the number of releases before Number arithmetic or slicing, as Python's unbounded int allows).
//  3. type= callables: throw PyValueError/PyTypeError/ArgumentTypeError and set `.pyName`; they receive the raw
//     argv string. Use the exported `types` (str/int/Path) for the three Python built-ins LCU uses.
//  4. `choices` membership uses Python equality (1 == 1n == True) and its error text; pass choices in the same type
//     as the parsed values (Numbers for type=int).
//  5. All output and exits go through `io` (stdout/stderr/exit/argv0/argv). Leave the defaults in production code
//     (fd writes + process.exit); tests may replace them. parser.error()/exit() never return.
//  6. Parser definitions mirror Python one to one (same add_argument order, help text, defaults, metavar), because
//     usage/help/error texts are byte-compared against CPython 3.12.
// =============================================================================================
//
// Port of the subset of CPython 3.12's Lib/argparse.py (and the textwrap pieces it uses) that LCU needs,
// so Node-hosted LCU commands print byte-identical usage/help/error text and parse identically.
//
// Structure follows CPython (3.12.10): HelpFormatter, Action classes, _ActionsContainer / _ArgumentGroup /
// _MutuallyExclusiveGroup / ArgumentParser, _parse_known_args (consume_optional / consume_positionals),
// _match_argument, _get_option_tuples, _get_values, error()/exit().
//
// ---------------------------------------------------------------------------------------------------
// Inventory of every ArgumentParser in lcu/*.py and scripts/*.py (the features this port must cover)
// ---------------------------------------------------------------------------------------------------
// lcu/setup.py        parser(): ArgumentParser(description=__doc__, epilog=...); --prefix type=Path default=<platform>
//                     help with "%%"; --user; --agent action='append' default=[]; --scope choices default; --project
//                     type=Path; store_true flags; --export type=Path; --approval choices (no default, multi-part help);
//                     --session choices default=<platform>; --browser-host and --validate-only help=SUPPRESS.
// lcu/apps.py         parser(): prog='lcu apps', usage=USAGE (multi-line), RawDescriptionHelpFormatter, description,
//                     multi-line epilog; add_subparsers(dest='action') (not required, no title); add_parser('list',
//                     usage=..., help=...) with --json store_true; add_parser('allow'|'revoke', usage, help) with a
//                     positional 'app'. main() inserts 'list' before parsing when the first argument is an option.
// lcu/browser.py      main(): ArgumentParser(description=__doc__); add_subparsers(dest='action', required=True);
//                     'install' (--directory type=Path), 'status' (--browser choices default='chrome');
//                     parser.error(...) for the removed 'serve'/'protocol' commands.
// lcu/doctor.py       ArgumentParser(description=...); --non-interactive, --require-ready (store_true).
// lcu/session.py      ArgumentParser(description=__doc__); --user required=True; 'command' nargs=argparse.REMAINDER;
//                     parser.error('Provide a command after --'); parse_args() with no argument (process args).
// lcu/maintenance.py  ArgumentParser(prog='lcu prune', description=...); --keep type=int default=2; --yes store_true.
// lcu/status.py       ArgumentParser(prog='lcu status', description=__doc__); --json store_true.
// lcu/update.py       ArgumentParser(prog='lcu update', description=__doc__); add_mutually_exclusive_group() with
//                     --check/--notice store_true and --refresh/--post-install (help=SUPPRESS); --json; --hook
//                     choices=(...) help=SUPPRESS; --yes.
// scripts/install.py  setup.parser() reused: parser.description assigned after construction, then add_argument for
//                     --runtime-only, --skip-system, --app-package type=Path, --existing-app type=Path, --offline.
//                     main() rewrites a leading non-option argument into ['--prefix', arg].
// scripts/install_macos.py  setup.parser(); parser.description=__doc__; parser.set_defaults(prefix=Path, session=...)
//                     (changes defaults of existing actions); add_argument --existing-app type=Path default=Path;
//                     --runtime-only, --offline, --skip-system.
// scripts/install_windows.py  ArgumentParser(description=__doc__); --prefix type=Path default=...; store_true flags;
//                     --agent action='append' choices=tuple(...) (no default); --scope choices default; --project
//                     type=Path; parser.error() twice after parsing.
// scripts/provision_agent_tools.py  ArgumentParser(description=__doc__); --release type=Path required=True; --source
//                     type=Path default=Path; --target choices default; --mac-node and --adapters-source type=Path.
// (scripts/build_bundle.py, bundle.py, check_archive.py are release build tools and out of scope.)
//
// Features therefore implemented: prog derivation from the program name, usage/description/epilog, formatter
// classes (HelpFormatter, RawDescriptionHelpFormatter, RawTextHelpFormatter, ArgumentDefaultsHelpFormatter),
// actions store/store_const/store_true/store_false/append/append_const/extend/count/help/version/
// BooleanOptionalAction/subparsers, nargs None/N/?/*/+/REMAINDER/PARSER, choices, metavar (string or tuple), dest,
// default/const, required, SUPPRESS (help and default), types (str/int/Path or any function), set_defaults,
// get_default, parents, argument groups, mutually exclusive groups (nested usage rendering), allow_abbrev,
// prefix_chars, fromfile_prefix_chars, conflict_handler (error/resolve), exit_on_error=false,
// parse_args/parse_known_args/parse_intermixed_args, `--opt=value`, `-xVALUE`, `-xyz` clusters, `--`, negative
// numbers, error()/exit()/print_help()/print_usage()/format_help()/format_usage().
//
// Deliberately not ported (LCU never uses them): FileType, MetavarTypeHelpFormatter, i18n (gettext is the
// identity under the C/English locale LCU always runs in), deprecation warnings of BooleanOptionalAction.
// Known differences are listed at the end of this header block and in tests/compat/test_argparse.py.
//
// Known differences from CPython:
//  * Strings are measured in code points like Python, but arguments that are not valid UTF-8 (Python keeps them as
//    surrogate escapes) are decoded lossily by Node before this module sees them.
//  * Unicode tables (printable/word/digit properties) come from the Unicode version of the running Node, not
//    Python 3.12's (15.0); only characters added after 15.0 can differ.
//  * `%`-formatting of help/usage supports %(name)s, %(name)r, %(name)d and %% (what argparse documents).
//  * The default-value conversion check `action.default is namespace.dest` compares by value (JS strings have no
//    identity), so a string default shared by two actions with the same dest could be converted twice.
//  * Exceptions Python would raise as tracebacks (bad parser definitions) raise JS errors (TypeError/ValueError/
//    ArgumentError subclasses) instead.
import fs from 'node:fs';

import { stderr_write, stdout_write } from './pyio.mjs';
import { decimalInt, MAX_STR_DIGITS } from './pynum.mjs';

export const SUPPRESS = '==SUPPRESS==';
export const OPTIONAL = '?';
export const ZERO_OR_MORE = '*';
export const ONE_OR_MORE = '+';
export const PARSER = 'A...';
export const REMAINDER = '...';
const UNRECOGNIZED_ARGS_ATTR = '_unrecognized_args';

// ===========================================================================================
// Python runtime helpers (str methods, repr, % formatting, int(), pathlib.PurePosixPath, textwrap)
// ===========================================================================================

export class PyValueError extends Error {}
export class PyTypeError extends Error {}
export class PyAssertionError extends Error {}
export class PyKeyError extends Error {}
export class PySystemExit extends Error {
  constructor(status) {
    super(`SystemExit: ${status}`);
    this.status = status;
  }
}

// str.isspace() / str.strip() whitespace (Unicode White_Space + the four ASCII separators 0x1c-0x1f).
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_CLASS = `[${PY_WS}]`;
const PY_NONWS_CLASS = `[^${PY_WS}]`;
const LSTRIP_RE = new RegExp(`^${PY_WS_CLASS}+`);
const RSTRIP_RE = new RegExp(`${PY_WS_CLASS}+$`);

export const pyStrip = (s) => s.replace(LSTRIP_RE, '').replace(RSTRIP_RE, '');

const cpArray = (s) => Array.from(s);
export const cpLen = (s) => {
  let n = s.length;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n -= 1;
        i += 1;
      }
    }
  }
  return n;
};
const cpHead = (s) => String.fromCodePoint(s.codePointAt(0));
const cpTail = (s) => s.slice(cpHead(s).length);
const cpSlice = (s, start, end) => cpArray(s).slice(start, end).join('');
const ljust = (s, width) => s + ' '.repeat(Math.max(0, width - cpLen(s)));
const spaces = (n) => ' '.repeat(Math.max(0, n));

function pyPartition(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

// str.splitlines(keepends)
export function pySplitlines(text, keepends = false) {
  const out = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(last, keepends ? m.index + m[0].length : m.index));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const hex = (n, width) => n.toString(16).padStart(width, '0');

export class PyPath {
  // pathlib.PurePosixPath string normalisation (what str(Path(x)) yields).
  constructor(text) {
    if (text instanceof PyPath) {
      this.text = text.text;
      return;
    }
    const s = String(text);
    if (s === '') {
      this.text = '.';
      return;
    }
    let root = '';
    if (s.startsWith('/')) {
      root = s.startsWith('//') && !s.startsWith('///') ? '//' : '/';
    }
    const parts = s.split('/').filter((p) => p !== '' && p !== '.');
    this.text = root + parts.join('/') || (root ? root : '.');
  }
  toString() {
    return this.text;
  }
  toJSON() {
    return this.text;
  }
}

function strRepr(s) {
  let quote = "'";
  if (s.includes("'") && !s.includes('"')) quote = '"';
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === '\\') out += `\\${ch}`;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`;
    else if (cp < 0x7f) out += ch;
    else if (NON_PRINTABLE.test(ch)) {
      if (cp <= 0xff) out += `\\x${hex(cp, 2)}`;
      else if (cp <= 0xffff) out += `\\u${hex(cp, 4)}`;
      else out += `\\U${hex(cp, 8)}`;
    } else out += ch;
  }
  return out + quote;
}

export function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return strRepr(v);
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof PyPath) return `PosixPath(${strRepr(v.text)})`;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (typeof v === 'function') return `<class '${v.pyName ?? v.name}'>`;
  return String(v);
}

export function pyStr(v) {
  if (typeof v === 'string') return v;
  if (v instanceof PyPath) return v.text;
  return pyRepr(v);
}

// `fmt % mapping` for the conversions argparse help/usage text may contain.
function pyFormatMapping(fmt, mapping) {
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch !== '%') {
      out += ch;
      i += 1;
      continue;
    }
    i += 1;
    if (i >= fmt.length) throw new PyValueError('incomplete format');
    if (fmt[i] === '%') {
      out += '%';
      i += 1;
      continue;
    }
    if (fmt[i] !== '(') throw new PyTypeError('format requires a mapping');
    const close = fmt.indexOf(')', i);
    if (close < 0) throw new PyValueError('incomplete format key');
    const key = fmt.slice(i + 1, close);
    i = close + 1;
    const conv = fmt[i];
    i += 1;
    if (!Object.prototype.hasOwnProperty.call(mapping, key)) throw new PyKeyError(key);
    const value = mapping[key];
    if (conv === 's') out += pyStr(value);
    else if (conv === 'r') out += pyRepr(value);
    else if (conv === 'd') {
      if (typeof value === 'boolean') out += value ? '1' : '0';
      else if (typeof value === 'number' || typeof value === 'bigint') out += String(Math.trunc(Number(value)));
      else throw new PyTypeError(`%d format: a real number is required, not ${typeof value}`);
    } else throw new PyValueError(`unsupported format character ${pyRepr(conv ?? '')}`);
  }
  return out;
}

// Tuple formatting: template with N `%s` against an array of exactly N items.
function pyFormatTuple(template, items) {
  const count = template.split('%s').length - 1;
  if (count !== items.length) {
    throw new PyTypeError(count > items.length ? 'not enough arguments for format string' : 'not all arguments converted during string formatting');
  }
  let n = 0;
  return template.replace(/%s/g, () => pyStr(items[n++]));
}

// int(str): CPython's rules for base 10 (the grammar lives in pynum.decimalInt, shared with PAX/HTTP number parsing):
// leading/trailing whitespace is stripped (ASCII space \t\n\v\f\r and non-ASCII Unicode whitespace, NOT U+001C..U+001F),
// one optional sign, Unicode decimal digits (category Nd) map to their value, single underscores may separate digits,
// and more than 4300 digits is a ValueError. Returns a Number when the value is a safe integer, otherwise a BigInt (see
// "Caller rules" in pyjson.mjs: ints are Number-or-BigInt everywhere).
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
export function pyInt(text) {
  const parsed = decimalInt(text);
  if (parsed.error === 'invalid') {
    throw new PyValueError(`invalid literal for int() with base 10: ${pyRepr(text)}`);
  }
  if (parsed.error === 'limit') {
    throw new PyValueError(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion: value has ${parsed.count} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  const value = parsed.negative ? -BigInt(parsed.digits) : BigInt(parsed.digits);
  return value >= -MAX_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value;
}
pyInt.pyName = 'int';

const identity = (s) => s;
identity.pyName = 'str';
const pathType = (s) => new PyPath(s);
pathType.pyName = 'Path';
// Built-in `type=` callables. Any function (string) => value works too; throw PyValueError/PyTypeError/
// ArgumentTypeError for invalid input and set `.pyName` to the Python __name__ used in the error message.
export const types = { str: identity, int: pyInt, Path: pathType };

// os.path.basename
const posixBasename = (s) => s.slice(s.lastIndexOf('/') + 1);

// shutil.get_terminal_size().columns
export function getTerminalColumns(env = process.env) {
  let columns;
  try {
    const raw = env.COLUMNS;
    if (raw === undefined) throw new PyValueError('unset');
    columns = Number(pyInt(raw));
  } catch {
    columns = 0;
  }
  if (columns <= 0) {
    let size = 0;
    try {
      if (process.stdout.isTTY && typeof process.stdout.getWindowSize === 'function') {
        size = process.stdout.getWindowSize()[0] || 0;
      }
    } catch {
      size = 0;
    }
    columns = size || 80;
  }
  return columns;
}

// ------------------------------- textwrap -------------------------------
const TW_WS = '[\\t\\n\\x0b\\x0c\\r ]';
const TW_NWS = '[^\\t\\n\\x0b\\x0c\\r ]';
const TW_WORD = '[\\p{L}\\p{N}_]';
const TW_WORD_PUNCT = '[\\p{L}\\p{N}_!"\'&.,?]';
const TW_LETTER = '(?:(?!\\p{Nd})[\\p{L}\\p{N}_])';
const WORDSEP_SRC =
  `(${TW_WS}+` +
  `|(?<=${TW_WORD_PUNCT})-{2,}(?=${TW_WORD})` +
  `|${TW_NWS}+?(?:` +
  `-(?:(?<=${TW_LETTER}{2}-)|(?<=${TW_LETTER}-${TW_LETTER}-))(?=${TW_LETTER}-?${TW_LETTER})` +
  `|(?=${TW_WS}|$)` +
  `|(?<=${TW_WORD_PUNCT})(?=-{2,}${TW_WORD})` +
  '))';
const WORDSEP_RE = new RegExp(WORDSEP_SRC, 'gu');

function twSplit(text) {
  const chunks = [];
  WORDSEP_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = WORDSEP_RE.exec(text)) !== null) {
    if (m[0] === '') {
      WORDSEP_RE.lastIndex += 1;
      continue;
    }
    if (m.index > last) chunks.push(text.slice(last, m.index));
    chunks.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) chunks.push(text.slice(last));
  return chunks.filter((c) => c);
}

function twHandleLongWord(reversedChunks, curLine, curLen, width) {
  const spaceLeft = width < 1 ? 1 : width - curLen;
  // break_long_words=True, break_on_hyphens=True
  let end = spaceLeft;
  const chunk = cpArray(reversedChunks[reversedChunks.length - 1]);
  if (chunk.length > spaceLeft) {
    const hyphen = chunk.slice(0, spaceLeft).lastIndexOf('-');
    if (hyphen > 0 && chunk.slice(0, hyphen).some((c) => c !== '-')) end = hyphen + 1;
  }
  curLine.push(chunk.slice(0, end).join(''));
  reversedChunks[reversedChunks.length - 1] = chunk.slice(end).join('');
}

function twWrapChunks(chunks, width, initialIndent, subsequentIndent) {
  const lines = [];
  if (width <= 0) throw new PyValueError(`invalid width ${width} (must be > 0)`);
  chunks.reverse();
  while (chunks.length) {
    let curLine = [];
    let curLen = 0;
    const indent = lines.length ? subsequentIndent : initialIndent;
    const w = width - cpLen(indent);
    if (pyStrip(chunks[chunks.length - 1]) === '' && lines.length) chunks.pop();
    while (chunks.length) {
      const l = cpLen(chunks[chunks.length - 1]);
      if (curLen + l <= w) {
        curLine.push(chunks.pop());
        curLen += l;
      } else break;
    }
    if (chunks.length && cpLen(chunks[chunks.length - 1]) > w) {
      twHandleLongWord(chunks, curLine, curLen, w);
      curLen = curLine.reduce((n, c) => n + cpLen(c), 0);
    }
    if (curLine.length && pyStrip(curLine[curLine.length - 1]) === '') {
      curLen -= cpLen(curLine[curLine.length - 1]);
      curLine.pop();
    }
    if (curLine.length) lines.push(indent + curLine.join(''));
  }
  return lines;
}

// textwrap.wrap(text, width, initial_indent=..., subsequent_indent=...) with CPython defaults. Tabs/newlines are
// converted to spaces first (replace_whitespace); expand_tabs never matters because HelpFormatter pre-collapses
// whitespace and Raw formatters keep tabs only in lines they never pass here.
export function textwrapWrap(text, width = 70, { initialIndent = '', subsequentIndent = '' } = {}) {
  const munged = expandTabs(text).replace(/[\t\n\x0b\x0c\r]/g, ' ');
  return twWrapChunks(twSplit(munged), width, initialIndent, subsequentIndent);
}
// str.expandtabs(8)
function expandTabs(text) {
  if (!text.includes('\t')) return text;
  let col = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const n = 8 - (col % 8);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col = ch === '\n' || ch === '\r' ? 0 : col + 1;
    }
  }
  return out;
}
export const textwrapFill = (text, width = 70, opts = {}) => textwrapWrap(text, width, opts).join('\n');

// ===========================================================================================
// Utility: _get_action_name, errors
// ===========================================================================================
function getActionName(argument) {
  if (argument === null || argument === undefined) return null;
  if (argument.option_strings.length) return argument.option_strings.join('/');
  if (argument.metavar !== null && argument.metavar !== SUPPRESS) {
    const metavar = argument.metavar;
    if (!Array.isArray(metavar)) return metavar;
    if (argument.nargs === ZERO_OR_MORE && metavar.length === 2) return pyFormatTuple('%s[, %s]', metavar);
    if (argument.nargs === ONE_OR_MORE) return pyFormatTuple('%s[, %s]', metavar);
    return metavar.join(', ');
  }
  if (argument.dest !== null && argument.dest !== SUPPRESS) return argument.dest;
  if (argument.choices && choicesList(argument.choices).length) return `{${choicesList(argument.choices).map(pyStr).join(',')}}`;
  return null;
}

export class ArgumentError extends Error {
  constructor(argument, message) {
    super(message);
    this.argument_name = getActionName(argument);
    this.message = message;
  }
  toString() {
    if (this.argument_name === null) return this.message;
    return `argument ${this.argument_name}: ${this.message}`;
  }
}

export class ArgumentTypeError extends Error {}

const choicesList = (choices) => (choices instanceof Map ? [...choices.keys()] : typeof choices === 'string' ? cpArray(choices) : [...choices]);
// Python `==` for the value kinds argparse sees: bool/int (Number or BigInt) compare numerically without rounding
// (True == 1, 1 == 1n); everything else compares with ===.
const isPyNumber = (v) => typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean';
const pyEquals = (a, b) => {
  if (isPyNumber(a) && isPyNumber(b)) {
    // eslint-disable-next-line eqeqeq
    return (typeof a === 'boolean' ? Number(a) : a) == (typeof b === 'boolean' ? Number(b) : b);
  }
  if (a instanceof PyPath && b instanceof PyPath) return a.text === b.text;
  return a === b;
};
const choicesHas = (choices, value) => {
  if (choices instanceof Map) return choices.has(value);
  if (typeof choices === 'string') return typeof value === 'string' && choices.includes(value);
  return [...choices].some((c) => pyEquals(c, value));
};

// ===========================================================================================
// IO (replaceable for in-process use and tests)
// ===========================================================================================
export const io = {
  stdout: (text) => stdout_write(text),
  stderr: (text) => stderr_write(text),
  exit: (status) => process.exit(status),
  // Program name used when ArgumentParser(prog) is not given: basename(sys.argv[0]).
  argv0: () => process.argv[1] ?? '',
  // Arguments used when parse_args() is called without any: sys.argv[1:].
  argv: () => process.argv.slice(2),
};

// ===========================================================================================
// HelpFormatter
// ===========================================================================================
class Section {
  constructor(formatter, parent, heading = null) {
    this.formatter = formatter;
    this.parent = parent;
    this.heading = heading;
    this.items = [];
  }

  format_help() {
    if (this.parent !== null) this.formatter._indent();
    const join = (parts) => this.formatter._join_parts(parts);
    const itemHelp = join(this.items.map(([func, args]) => func(...args)));
    if (this.parent !== null) this.formatter._dedent();
    if (!itemHelp) return '';
    let heading;
    if (this.heading !== SUPPRESS && this.heading !== null) {
      heading = `${spaces(this.formatter._current_indent)}${this.heading}:\n`;
    } else heading = '';
    return join(['\n', heading, itemHelp, '\n']);
  }
}

export class HelpFormatter {
  constructor({ prog, indent_increment = 2, max_help_position = 24, width = null }) {
    if (width === null) {
      width = getTerminalColumns();
      width -= 2;
    }
    this._prog = prog;
    this._indent_increment = indent_increment;
    this._max_help_position = Math.min(max_help_position, Math.max(width - 20, indent_increment * 2));
    this._width = width;
    this._current_indent = 0;
    this._level = 0;
    this._action_max_length = 0;
    this._root_section = new Section(this, null);
    this._current_section = this._root_section;
  }

  _indent() {
    this._current_indent += this._indent_increment;
    this._level += 1;
  }

  _dedent() {
    this._current_indent -= this._indent_increment;
    if (this._current_indent < 0) throw new PyAssertionError('Indent decreased below 0.');
    this._level -= 1;
  }

  _add_item(func, args) {
    this._current_section.items.push([func, args]);
  }

  start_section(heading) {
    this._indent();
    const section = new Section(this, this._current_section, heading);
    this._add_item(section.format_help.bind(section), []);
    this._current_section = section;
  }

  end_section() {
    this._current_section = this._current_section.parent;
    this._dedent();
  }

  add_text(text) {
    if (text !== SUPPRESS && text !== null && text !== undefined) this._add_item(this._format_text.bind(this), [text]);
  }

  add_usage(usage, actions, groups, prefix = null) {
    if (usage !== SUPPRESS) this._add_item(this._format_usage.bind(this), [usage, actions, groups, prefix]);
  }

  add_argument(action) {
    if (action.help !== SUPPRESS) {
      const invocationLengths = [cpLen(this._format_action_invocation(action)) + this._current_indent];
      for (const subaction of this._iter_indented_subactions(action)) {
        invocationLengths.push(cpLen(this._format_action_invocation(subaction)) + this._current_indent);
      }
      const actionLength = Math.max(...invocationLengths);
      this._action_max_length = Math.max(this._action_max_length, actionLength);
      this._add_item(this._format_action.bind(this), [action]);
    }
  }

  add_arguments(actions) {
    for (const action of actions) this.add_argument(action);
  }

  format_help() {
    let help = this._root_section.format_help();
    if (help) {
      help = help.replace(/\n\n\n+/g, '\n\n');
      help = `${help.replace(/^\n+/, '').replace(/\n+$/, '')}\n`;
    }
    return help;
  }

  _join_parts(partStrings) {
    return partStrings.filter((part) => part && part !== SUPPRESS).join('');
  }

  _format_usage(usage, actions, groups, prefix) {
    if (prefix === null || prefix === undefined) prefix = 'usage: ';

    if (usage !== null && usage !== undefined) {
      usage = pyFormatMapping(usage, { prog: this._prog });
    } else if (!actions.length) {
      usage = pyFormatMapping('%(prog)s', { prog: this._prog });
    } else {
      const prog = pyFormatMapping('%(prog)s', { prog: this._prog });
      const optionals = [];
      const positionals = [];
      for (const action of actions) {
        if (action.option_strings.length) optionals.push(action);
        else positionals.push(action);
      }
      const format = (acts, grps) => this._format_actions_usage(acts, grps);
      const actionUsage = format([...optionals, ...positionals], groups);
      usage = [prog, actionUsage].filter((s) => s).join(' ');

      const textWidth = this._width - this._current_indent;
      if (cpLen(prefix) + cpLen(usage) > textWidth) {
        const partRegexp = new RegExp(`\\(.*?\\)+(?=${PY_WS_CLASS}|$)|\\[.*?\\]+(?=${PY_WS_CLASS}|$)|${PY_NONWS_CLASS}+`.replaceAll('.*?', '[^\\n]*?'), 'g');
        const optUsage = format(optionals, groups);
        const posUsage = format(positionals, groups);
        const optParts = optUsage.match(partRegexp) ?? [];
        const posParts = posUsage.match(partRegexp) ?? [];
        if (optParts.join(' ') !== optUsage) throw new PyAssertionError('opt_parts');
        if (posParts.join(' ') !== posUsage) throw new PyAssertionError('pos_parts');

        const getLines = (parts, indent, linePrefix = null) => {
          const lines = [];
          let line = [];
          const indentLength = cpLen(indent);
          let lineLen = linePrefix !== null ? cpLen(linePrefix) - 1 : indentLength - 1;
          for (const part of parts) {
            if (lineLen + 1 + cpLen(part) > textWidth && line.length) {
              lines.push(indent + line.join(' '));
              line = [];
              lineLen = indentLength - 1;
            }
            line.push(part);
            lineLen += cpLen(part) + 1;
          }
          if (line.length) lines.push(indent + line.join(' '));
          if (linePrefix !== null) lines[0] = cpSlice(lines[0], indentLength);
          return lines;
        };

        let lines;
        if (cpLen(prefix) + cpLen(prog) <= 0.75 * textWidth) {
          const indent = ' '.repeat(cpLen(prefix) + cpLen(prog) + 1);
          if (optParts.length) {
            lines = getLines([prog, ...optParts], indent, prefix);
            lines.push(...getLines(posParts, indent));
          } else if (posParts.length) {
            lines = getLines([prog, ...posParts], indent, prefix);
          } else {
            lines = [prog];
          }
        } else {
          const indent = ' '.repeat(cpLen(prefix));
          const parts = [...optParts, ...posParts];
          lines = getLines(parts, indent);
          if (lines.length > 1) {
            lines = [];
            lines.push(...getLines(optParts, indent));
            lines.push(...getLines(posParts, indent));
          }
          lines = [prog, ...lines];
        }
        usage = lines.join('\n');
      }
    }
    return `${prefix}${usage}\n\n`;
  }

  _format_actions_usage(actions, groups) {
    const groupActions = new Set();
    const inserts = new Map();
    for (const group of groups) {
      if (!group._group_actions.length) throw new PyValueError(`empty group ${group}`);
      const start = actions.indexOf(group._group_actions[0]);
      if (start < 0) continue;
      const groupActionCount = group._group_actions.length;
      const end = start + groupActionCount;
      const slice = actions.slice(start, end);
      if (slice.length === group._group_actions.length && slice.every((a, i) => a === group._group_actions[i])) {
        let suppressedCount = 0;
        for (const action of group._group_actions) {
          groupActions.add(action);
          if (action.help === SUPPRESS) suppressedCount += 1;
        }
        const exposedCount = groupActionCount - suppressedCount;
        if (!exposedCount) continue;
        if (!group.required) {
          inserts.set(start, inserts.has(start) ? `${inserts.get(start)} [` : '[');
          inserts.set(end, inserts.has(end) ? `${inserts.get(end)}]` : ']');
        } else if (exposedCount > 1) {
          inserts.set(start, inserts.has(start) ? `${inserts.get(start)} (` : '(');
          inserts.set(end, inserts.has(end) ? `${inserts.get(end)})` : ')');
        }
        for (let i = start + 1; i < end; i += 1) inserts.set(i, '|');
      }
    }

    const parts = [];
    actions.forEach((action, i) => {
      if (action.help === SUPPRESS) {
        parts.push(null);
        if (inserts.get(i) === '|') inserts.delete(i);
        else if (inserts.get(i + 1) === '|') inserts.delete(i + 1);
      } else if (!action.option_strings.length) {
        const dflt = this._get_default_metavar_for_positional(action);
        let part = this._format_args(action, dflt);
        if (groupActions.has(action)) {
          if (part[0] === '[' && part[part.length - 1] === ']') part = part.slice(1, -1);
        }
        parts.push(part);
      } else {
        const optionString = action.option_strings[0];
        let part;
        if (action.nargs === 0) {
          part = action.format_usage();
        } else {
          const dflt = this._get_default_metavar_for_optional(action);
          const argsString = this._format_args(action, dflt);
          part = `${optionString} ${argsString}`;
        }
        if (!action.required && !groupActions.has(action)) part = `[${part}]`;
        parts.push(part);
      }
    });

    for (const i of [...inserts.keys()].sort((a, b) => b - a)) parts.splice(i, 0, inserts.get(i));

    let text = parts.filter((item) => item !== null).join(' ');
    text = text.replace(/([[(]) /g, '$1');
    text = text.replace(/ ([\])])/g, '$1');
    text = text.replace(/[[(] *[\])]/g, '');
    return pyStrip(text);
  }

  _format_text(text) {
    if (text.includes('%(prog)')) text = pyFormatMapping(text, { prog: this._prog });
    const textWidth = Math.max(this._width - this._current_indent, 11);
    const indent = spaces(this._current_indent);
    return `${this._fill_text(text, textWidth, indent)}\n\n`;
  }

  _format_action(action) {
    const helpPosition = Math.min(this._action_max_length + 2, this._max_help_position);
    const helpWidth = Math.max(this._width - helpPosition, 11);
    const actionWidth = helpPosition - this._current_indent - 2;
    let actionHeader = this._format_action_invocation(action);
    let indentFirst = 0;

    if (!action.help) {
      actionHeader = `${spaces(this._current_indent)}${actionHeader}\n`;
    } else if (cpLen(actionHeader) <= actionWidth) {
      actionHeader = `${spaces(this._current_indent)}${ljust(actionHeader, actionWidth)}  `;
      indentFirst = 0;
    } else {
      actionHeader = `${spaces(this._current_indent)}${actionHeader}\n`;
      indentFirst = helpPosition;
    }

    const parts = [actionHeader];
    if (action.help && pyStrip(action.help)) {
      const helpText = this._expand_help(action);
      if (helpText) {
        const helpLines = this._split_lines(helpText, helpWidth);
        parts.push(`${spaces(indentFirst)}${helpLines[0]}\n`);
        for (const line of helpLines.slice(1)) parts.push(`${spaces(helpPosition)}${line}\n`);
      }
    } else if (!actionHeader.endsWith('\n')) {
      parts.push('\n');
    }

    for (const subaction of this._iter_indented_subactions(action)) parts.push(this._format_action(subaction));
    return this._join_parts(parts);
  }

  _format_action_invocation(action) {
    if (!action.option_strings.length) {
      const dflt = this._get_default_metavar_for_positional(action);
      return this._metavar_formatter(action, dflt)(1).join(' ');
    }
    const parts = [];
    if (action.nargs === 0) {
      parts.push(...action.option_strings);
    } else {
      const dflt = this._get_default_metavar_for_optional(action);
      const argsString = this._format_args(action, dflt);
      for (const optionString of action.option_strings) parts.push(`${optionString} ${argsString}`);
    }
    return parts.join(', ');
  }

  _metavar_formatter(action, defaultMetavar) {
    let result;
    if (action.metavar !== null) result = action.metavar;
    else if (action.choices !== null) result = `{${choicesList(action.choices).map(pyStr).join(',')}}`;
    else result = defaultMetavar;
    return (tupleSize) => (Array.isArray(result) ? result : Array(tupleSize).fill(result));
  }

  _format_args(action, defaultMetavar) {
    const getMetavar = this._metavar_formatter(action, defaultMetavar);
    const { nargs } = action;
    if (nargs === null) return pyFormatTuple('%s', getMetavar(1));
    if (nargs === OPTIONAL) return pyFormatTuple('[%s]', getMetavar(1));
    if (nargs === ZERO_OR_MORE) {
      const metavar = getMetavar(1);
      return metavar.length === 2 ? pyFormatTuple('[%s [%s ...]]', metavar) : pyFormatTuple('[%s ...]', metavar);
    }
    if (nargs === ONE_OR_MORE) return pyFormatTuple('%s [%s ...]', getMetavar(2));
    if (nargs === REMAINDER) return '...';
    if (nargs === PARSER) return pyFormatTuple('%s ...', getMetavar(1));
    if (nargs === SUPPRESS) return '';
    if (!Number.isInteger(nargs)) throw new PyValueError('invalid nargs value');
    return pyFormatTuple(Array(nargs).fill('%s').join(' '), getMetavar(nargs));
  }

  _expand_help(action) {
    const params = {
      option_strings: action.option_strings,
      dest: action.dest,
      nargs: action.nargs,
      const: action.const,
      default: action.default,
      type: action.type,
      choices: action.choices,
      required: action.required,
      help: action.help,
      metavar: action.metavar,
      prog: this._prog,
    };
    for (const name of Object.keys(params)) if (params[name] === SUPPRESS) delete params[name];
    for (const name of Object.keys(params)) {
      if (typeof params[name] === 'function') params[name] = params[name].pyName ?? params[name].name;
    }
    if (params.choices !== null && params.choices !== undefined) params.choices = choicesList(params.choices).map(pyStr).join(', ');
    return pyFormatMapping(this._get_help_string(action), params);
  }

  * _iter_indented_subactions(action) {
    if (typeof action._get_subactions === 'function') {
      this._indent();
      yield* action._get_subactions();
      this._dedent();
    }
  }

  _split_lines(text, width) {
    text = pyStrip(text.replace(/[ \t\n\r\f\v]+/g, ' '));
    return textwrapWrap(text, width);
  }

  _fill_text(text, width, indent) {
    text = pyStrip(text.replace(/[ \t\n\r\f\v]+/g, ' '));
    return textwrapFill(text, width, { initialIndent: indent, subsequentIndent: indent });
  }

  _get_help_string(action) {
    return action.help;
  }

  _get_default_metavar_for_optional(action) {
    return action.dest.toUpperCase();
  }

  _get_default_metavar_for_positional(action) {
    return action.dest;
  }
}

export class RawDescriptionHelpFormatter extends HelpFormatter {
  _fill_text(text, width, indent) {
    return pySplitlines(text, true).map((line) => indent + line).join('');
  }
}

export class RawTextHelpFormatter extends RawDescriptionHelpFormatter {
  _split_lines(text, width) {
    return pySplitlines(text);
  }
}

export class ArgumentDefaultsHelpFormatter extends HelpFormatter {
  _get_help_string(action) {
    let help = action.help ?? '';
    if (!help.includes('%(default)')) {
      if (action.default !== SUPPRESS) {
        if (action.option_strings.length || action.nargs === OPTIONAL || action.nargs === ZERO_OR_MORE) {
          help += ' (default: %(default)s)';
        }
      }
    }
    return help;
  }
}

// ===========================================================================================
// Namespace
// ===========================================================================================
// argparse.Namespace. Attributes are read and written with plain property access, exactly like the Python code:
//   const args = parser.parse_args(argv);  if (args.yes) ...;  args.keep = 3;  'keep' in args;  delete args.keep
// The Map-style methods (has/get/set/delete/entries) are kept too and always win over a destination of the same
// name; for such a (very unlikely) dest (`get`, `set`, `has`, `delete`, `entries`, `vars`, `toObject`) use
// ns.get('get'). Property access reads the same storage as the methods; there is no second copy.
// Unset attributes read as `undefined` (Python raises AttributeError): use `has()`/`in` when presence matters.
// A Namespace is not JSON-serialisable (neither is Python's): pass `ns.vars()` (a Map, like vars(args)) to dumps().
const STORE = Symbol('namespace store');
const NAMESPACE_METHODS = new Set(['has', 'get', 'set', 'delete', 'entries', 'vars', 'toObject', 'constructor']);
export class Namespace {
  constructor(kwargs = {}) {
    const store = new Map(Object.entries(kwargs));
    Object.defineProperty(this, STORE, { value: store, configurable: true });
    return new Proxy(this, {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && !NAMESPACE_METHODS.has(key) && store.has(key)) return store.get(key);
        return Reflect.get(target, key, receiver);
      },
      set: (target, key, value) => {
        if (typeof key !== 'string') return Reflect.set(target, key, value);
        store.set(key, value);
        return true;
      },
      has: (target, key) => (typeof key === 'string' && store.has(key)) || Reflect.has(target, key),
      deleteProperty: (target, key) => {
        if (typeof key === 'string') store.delete(key);
        return true;
      },
      ownKeys: () => [...store.keys()],
      getOwnPropertyDescriptor: (target, key) => (typeof key === 'string' && store.has(key)
        ? { value: store.get(key), writable: true, enumerable: true, configurable: true } : undefined),
    });
  }
  has(name) {
    return this[STORE].has(name);
  }
  get(name, dflt = null) {
    return this[STORE].has(name) ? this[STORE].get(name) : dflt;
  }
  set(name, value) {
    this[STORE].set(name, value);
  }
  delete(name) {
    this[STORE].delete(name);
  }
  // vars(namespace) as [name, value] pairs
  entries() {
    return [...this[STORE].entries()];
  }
  // vars(namespace) as an order-preserving dict (Map), ready for json dumps()
  vars() {
    return new Map(this[STORE]);
  }
  // plain-object snapshot for read-only use
  toObject() {
    return Object.fromEntries(this[STORE]);
  }
}

// ===========================================================================================
// Actions
// ===========================================================================================
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const copyItems = (items) => (items === null || items === undefined ? [] : Array.isArray(items) ? items.slice() : [...items]);

export class Action {
  static allowed = ['option_strings', 'dest', 'nargs', 'const', 'default', 'type', 'choices', 'required', 'help', 'metavar'];

  constructor(kw) {
    this.option_strings = kw.option_strings;
    this.dest = kw.dest;
    this.nargs = kw.nargs ?? null;
    this.const = kw.const ?? null;
    this.default = kw.default ?? null;
    this.type = kw.type ?? null;
    this.choices = kw.choices ?? null;
    this.required = kw.required ?? false;
    this.help = kw.help ?? null;
    this.metavar = kw.metavar ?? null;
  }

  format_usage() {
    return this.option_strings[0];
  }

  call() {
    throw new Error('.__call__() not defined');
  }
}

function checkKwargs(cls, kw) {
  for (const key of Object.keys(kw)) {
    if (kw[key] !== undefined && !cls.allowed.includes(key)) {
      throw new PyTypeError(`${cls.name}.__init__() got an unexpected keyword argument '${key}'`);
    }
  }
}

class StoreAction extends Action {
  constructor(kw) {
    checkKwargs(StoreAction, kw);
    if (kw.nargs === 0) {
      throw new PyValueError('nargs for store actions must be != 0; if you have nothing to store, actions such as store true or store const may be more appropriate');
    }
    if (kw.const !== undefined && kw.const !== null && kw.nargs !== OPTIONAL) throw new PyValueError(`nargs must be ${pyRepr(OPTIONAL)} to supply const`);
    super(kw);
  }
  call(parser, namespace, values) {
    namespace.set(this.dest, values);
  }
}

class StoreConstAction extends Action {
  static allowed = ['option_strings', 'dest', 'const', 'default', 'required', 'help', 'metavar'];
  constructor(kw) {
    checkKwargs(StoreConstAction, kw);
    super({ option_strings: kw.option_strings, dest: kw.dest, nargs: 0, const: kw.const, default: kw.default, required: kw.required, help: kw.help });
  }
  call(parser, namespace) {
    namespace.set(this.dest, this.const);
  }
}

class StoreTrueAction extends StoreConstAction {
  static allowed = ['option_strings', 'dest', 'default', 'required', 'help'];
  constructor(kw) {
    checkKwargs(StoreTrueAction, kw);
    super({ option_strings: kw.option_strings, dest: kw.dest, const: true, default: kw.default === undefined ? false : kw.default, required: kw.required, help: kw.help });
  }
}

class StoreFalseAction extends StoreConstAction {
  static allowed = ['option_strings', 'dest', 'default', 'required', 'help'];
  constructor(kw) {
    checkKwargs(StoreFalseAction, kw);
    super({ option_strings: kw.option_strings, dest: kw.dest, const: false, default: kw.default === undefined ? true : kw.default, required: kw.required, help: kw.help });
  }
}

class AppendAction extends Action {
  constructor(kw) {
    checkKwargs(AppendAction, kw);
    if (kw.nargs === 0) {
      throw new PyValueError('nargs for append actions must be != 0; if arg strings are not supplying the value to append, the append const action may be more appropriate');
    }
    if (kw.const !== undefined && kw.const !== null && kw.nargs !== OPTIONAL) throw new PyValueError(`nargs must be ${pyRepr(OPTIONAL)} to supply const`);
    super(kw);
  }
  call(parser, namespace, values) {
    const items = copyItems(namespace.get(this.dest, null));
    items.push(values);
    namespace.set(this.dest, items);
  }
}

class AppendConstAction extends Action {
  static allowed = ['option_strings', 'dest', 'const', 'default', 'required', 'help', 'metavar'];
  constructor(kw) {
    checkKwargs(AppendConstAction, kw);
    super({ option_strings: kw.option_strings, dest: kw.dest, nargs: 0, const: kw.const, default: kw.default, required: kw.required, help: kw.help, metavar: kw.metavar });
  }
  call(parser, namespace) {
    const items = copyItems(namespace.get(this.dest, null));
    items.push(this.const);
    namespace.set(this.dest, items);
  }
}

class CountAction extends Action {
  static allowed = ['option_strings', 'dest', 'default', 'required', 'help'];
  constructor(kw) {
    checkKwargs(CountAction, kw);
    super({ option_strings: kw.option_strings, dest: kw.dest, nargs: 0, default: kw.default, required: kw.required, help: kw.help });
  }
  call(parser, namespace) {
    let count = namespace.get(this.dest, null);
    if (count === null) count = 0;
    namespace.set(this.dest, count + 1);
  }
}

class HelpAction extends Action {
  static allowed = ['option_strings', 'dest', 'default', 'help'];
  constructor(kw) {
    checkKwargs(HelpAction, kw);
    super({ option_strings: kw.option_strings, dest: kw.dest === undefined ? SUPPRESS : kw.dest, default: kw.default === undefined ? SUPPRESS : kw.default, nargs: 0, help: kw.help });
  }
  call(parser) {
    parser.print_help();
    parser.exit();
  }
}

class VersionAction extends Action {
  static allowed = ['option_strings', 'version', 'dest', 'default', 'help'];
  constructor(kw) {
    checkKwargs(VersionAction, kw);
    super({
      option_strings: kw.option_strings,
      dest: kw.dest === undefined ? SUPPRESS : kw.dest,
      default: kw.default === undefined ? SUPPRESS : kw.default,
      nargs: 0,
      help: kw.help ?? "show program's version number and exit",
    });
    this.version = kw.version ?? null;
  }
  call(parser) {
    let { version } = this;
    if (version === null) version = parser.version;
    const formatter = parser._get_formatter();
    formatter.add_text(version);
    parser._print_message(formatter.format_help(), io.stdout);
    parser.exit();
  }
}

class ExtendAction extends AppendAction {
  call(parser, namespace, values) {
    const items = copyItems(namespace.get(this.dest, null));
    items.push(...values);
    namespace.set(this.dest, items);
  }
}

export class BooleanOptionalAction extends Action {
  static allowed = ['option_strings', 'dest', 'default', 'required', 'help'];
  constructor(kw) {
    checkKwargs(BooleanOptionalAction, kw);
    const optionStrings = [];
    for (let optionString of kw.option_strings) {
      optionStrings.push(optionString);
      if (optionString.startsWith('--')) {
        optionString = `--no-${optionString.slice(2)}`;
        optionStrings.push(optionString);
      }
    }
    super({ option_strings: optionStrings, dest: kw.dest, nargs: 0, default: kw.default, required: kw.required, help: kw.help });
  }
  call(parser, namespace, values, optionString) {
    if (this.option_strings.includes(optionString)) namespace.set(this.dest, !optionString.startsWith('--no-'));
  }
  format_usage() {
    return this.option_strings.join(' | ');
  }
}

class ChoicesPseudoAction extends Action {
  constructor(name, aliases, help) {
    let metavar = name;
    if (aliases.length) metavar += ` (${aliases.join(', ')})`;
    super({ option_strings: [], dest: name, help, metavar });
  }
}

class SubParsersAction extends Action {
  static allowed = ['option_strings', 'prog', 'parser_class', 'dest', 'required', 'help', 'metavar'];
  constructor(kw) {
    checkKwargs(SubParsersAction, kw);
    const nameParserMap = new Map();
    super({
      option_strings: kw.option_strings,
      dest: kw.dest === undefined ? SUPPRESS : kw.dest,
      nargs: PARSER,
      choices: nameParserMap,
      required: kw.required ?? false,
      help: kw.help,
      metavar: kw.metavar,
    });
    this._prog_prefix = kw.prog;
    this._parser_class = kw.parser_class;
    this._name_parser_map = nameParserMap;
    this._choices_actions = [];
  }

  add_parser(name, kwargs = {}) {
    kwargs = { ...kwargs };
    if (kwargs.prog === undefined || kwargs.prog === null) kwargs.prog = `${this._prog_prefix} ${name}`;
    const aliases = kwargs.aliases ?? [];
    delete kwargs.aliases;
    if (this._name_parser_map.has(name)) throw new ArgumentError(this, `conflicting subparser: ${name}`);
    for (const alias of aliases) {
      if (this._name_parser_map.has(alias)) throw new ArgumentError(this, `conflicting subparser alias: ${alias}`);
    }
    if ('help' in kwargs) {
      const { help } = kwargs;
      delete kwargs.help;
      this._choices_actions.push(new ChoicesPseudoAction(name, aliases, help));
    }
    const parser = new this._parser_class(kwargs);
    this._name_parser_map.set(name, parser);
    for (const alias of aliases) this._name_parser_map.set(alias, parser);
    return parser;
  }

  _get_subactions() {
    return this._choices_actions;
  }

  call(parser, namespace, values) {
    const parserName = values[0];
    const argStrings = values.slice(1);
    if (this.dest !== SUPPRESS) namespace.set(this.dest, parserName);
    if (!this._name_parser_map.has(parserName)) {
      const msg = `unknown parser ${pyRepr(parserName)} (choices: ${[...this._name_parser_map.keys()].join(', ')})`;
      throw new ArgumentError(this, msg);
    }
    const sub = this._name_parser_map.get(parserName);
    const [subnamespace, rest] = sub.parse_known_args(argStrings, null);
    for (const [key, value] of subnamespace.entries()) namespace.set(key, value);
    if (rest.length) {
      if (!namespace.has(UNRECOGNIZED_ARGS_ATTR)) namespace.set(UNRECOGNIZED_ARGS_ATTR, []);
      namespace.get(UNRECOGNIZED_ARGS_ATTR).push(...rest);
    }
  }
}

// ===========================================================================================
// Containers
// ===========================================================================================
// CPython: _re.compile(r'^-\d+$|^-\d*\.\d+$').match(); \d is Unicode Nd and `$` also matches before one trailing newline.
const NEGATIVE_NUMBER = /^-\p{Nd}+(?=\n?$)|^-\p{Nd}*\.\p{Nd}+(?=\n?$)/u;

class ActionsContainer {
  constructor({ description, prefix_chars, argument_default, conflict_handler }) {
    this.description = description;
    this.argument_default = argument_default;
    this.prefix_chars = prefix_chars;
    this.conflict_handler = conflict_handler;
    this._registries = {};
    this.register('action', null, StoreAction);
    this.register('action', 'store', StoreAction);
    this.register('action', 'store_const', StoreConstAction);
    this.register('action', 'store_true', StoreTrueAction);
    this.register('action', 'store_false', StoreFalseAction);
    this.register('action', 'append', AppendAction);
    this.register('action', 'append_const', AppendConstAction);
    this.register('action', 'count', CountAction);
    this.register('action', 'help', HelpAction);
    this.register('action', 'version', VersionAction);
    this.register('action', 'parsers', SubParsersAction);
    this.register('action', 'extend', ExtendAction);
    this._get_handler();
    this._actions = [];
    this._option_string_actions = new Map();
    this._action_groups = [];
    this._mutually_exclusive_groups = [];
    this._defaults = {};
    this._has_negative_number_optionals = [];
  }

  register(registryName, value, object) {
    if (!this._registries[registryName]) this._registries[registryName] = new Map();
    this._registries[registryName].set(value, object);
  }

  _registry_get(registryName, value, dflt = null) {
    const registry = this._registries[registryName];
    return registry.has(value) ? registry.get(value) : dflt;
  }

  set_defaults(kwargs) {
    Object.assign(this._defaults, kwargs);
    for (const action of this._actions) {
      if (Object.prototype.hasOwnProperty.call(kwargs, action.dest)) action.default = kwargs[action.dest];
    }
  }

  get_default(dest) {
    for (const action of this._actions) {
      if (action.dest === dest && action.default !== null) return action.default;
    }
    return Object.prototype.hasOwnProperty.call(this._defaults, dest) ? this._defaults[dest] : null;
  }

  // add_argument(name_or_flags..., {kwargs})
  add_argument(...args) {
    let kwargs = {};
    if (args.length && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null) kwargs = { ...args.pop() };
    const chars = this.prefix_chars;
    if (!args.length || (args.length === 1 && !chars.includes(args[0][0]))) {
      if (args.length && 'dest' in kwargs) throw new PyValueError('dest supplied twice for positional argument');
      kwargs = this._get_positional_kwargs(...args, kwargs);
    } else {
      kwargs = this._get_optional_kwargs(args, kwargs);
    }

    if (!hasOwn(kwargs, 'default')) {
      const { dest } = kwargs;
      if (Object.prototype.hasOwnProperty.call(this._defaults, dest)) kwargs.default = this._defaults[dest];
      else if (this.argument_default !== null && this.argument_default !== undefined) kwargs.default = this.argument_default;
    }

    const actionClass = this._pop_action_class(kwargs);
    if (typeof actionClass !== 'function') throw new PyValueError(`unknown action "${actionClass}"`);
    const action = new actionClass(kwargs);

    const typeFunc = this._registry_get('type', action.type, action.type);
    if (typeof typeFunc !== 'function') throw new PyValueError(`${pyRepr(typeFunc)} is not callable`);

    if (typeof this._get_formatter === 'function') {
      try {
        this._get_formatter()._format_args(action, null);
      } catch (error) {
        if (error instanceof PyTypeError) throw new PyValueError('length of metavar tuple does not match nargs');
        throw error;
      }
    }
    return this._add_action(action);
  }

  add_argument_group(kwargs = {}) {
    const group = new ArgumentGroup(this, kwargs);
    this._action_groups.push(group);
    return group;
  }

  add_mutually_exclusive_group(kwargs = {}) {
    const group = new MutuallyExclusiveGroup(this, kwargs);
    this._mutually_exclusive_groups.push(group);
    return group;
  }

  _add_action(action) {
    this._check_conflict(action);
    this._actions.push(action);
    action.container = this;
    for (const optionString of action.option_strings) this._option_string_actions.set(optionString, action);
    for (const optionString of action.option_strings) {
      if (NEGATIVE_NUMBER.test(optionString)) {
        if (!this._has_negative_number_optionals.length) this._has_negative_number_optionals.push(true);
      }
    }
    return action;
  }

  _remove_action(action) {
    this._actions.splice(this._actions.indexOf(action), 1);
  }

  _add_container_actions(container) {
    const titleGroupMap = new Map();
    for (const group of this._action_groups) {
      if (titleGroupMap.has(group.title)) throw new PyValueError(`cannot merge actions - two groups are named ${pyRepr(group.title)}`);
      titleGroupMap.set(group.title, group);
    }
    const groupMap = new Map();
    for (const group of container._action_groups) {
      if (!titleGroupMap.has(group.title)) {
        titleGroupMap.set(group.title, this.add_argument_group({ title: group.title, description: group.description, conflict_handler: group.conflict_handler }));
      }
      for (const action of group._group_actions) groupMap.set(action, titleGroupMap.get(group.title));
    }
    for (const group of container._mutually_exclusive_groups) {
      const cont = group._container === container ? this : titleGroupMap.get(group._container.title);
      const mutexGroup = cont.add_mutually_exclusive_group({ required: group.required });
      for (const action of group._group_actions) groupMap.set(action, mutexGroup);
    }
    for (const action of container._actions) (groupMap.get(action) ?? this)._add_action(action);
  }

  _get_positional_kwargs(dest, kwargs = {}) {
    if ('required' in kwargs) throw new PyTypeError("'required' is an invalid argument for positionals");
    const nargs = kwargs.nargs ?? null;
    if (![OPTIONAL, ZERO_OR_MORE, REMAINDER, SUPPRESS, 0].includes(nargs)) kwargs = { ...kwargs, required: true };
    return { ...kwargs, dest, option_strings: [] };
  }

  _get_optional_kwargs(args, kwargs) {
    const optionStrings = [];
    const longOptionStrings = [];
    for (const optionString of args) {
      if (!this.prefix_chars.includes(optionString[0])) {
        throw new PyValueError(`invalid option string ${pyRepr(optionString)}: must start with a character ${pyRepr(this.prefix_chars)}`);
      }
      optionStrings.push(optionString);
      if (cpLen(optionString) > 1 && this.prefix_chars.includes(cpArray(optionString)[1])) longOptionStrings.push(optionString);
    }
    kwargs = { ...kwargs };
    let dest = kwargs.dest ?? null;
    delete kwargs.dest;
    if (dest === null) {
      const destOptionString = longOptionStrings.length ? longOptionStrings[0] : optionStrings[0];
      dest = [...destOptionString].reduce(
        (acc, ch) => (acc.stripping && this.prefix_chars.includes(ch) ? acc : { stripping: false, text: acc.text + ch }),
        { stripping: true, text: '' },
      ).text;
      if (!dest) throw new PyValueError(`dest= is required for options like ${pyRepr(optionStrings[optionStrings.length - 1])}`);
      dest = dest.replaceAll('-', '_');
    }
    return { ...kwargs, dest, option_strings: optionStrings };
  }

  _pop_action_class(kwargs, dflt = null) {
    const action = 'action' in kwargs && kwargs.action !== undefined ? kwargs.action : dflt;
    delete kwargs.action;
    return this._registry_get('action', action, action);
  }

  _get_handler() {
    if (this.conflict_handler === 'error') return this._handle_conflict_error;
    if (this.conflict_handler === 'resolve') return this._handle_conflict_resolve;
    throw new PyValueError(`invalid conflict_resolution value: ${pyRepr(this.conflict_handler)}`);
  }

  _check_conflict(action) {
    const conflOptionals = [];
    for (const optionString of action.option_strings) {
      if (this._option_string_actions.has(optionString)) conflOptionals.push([optionString, this._option_string_actions.get(optionString)]);
    }
    if (conflOptionals.length) this._get_handler().call(this, action, conflOptionals);
  }

  _handle_conflict_error(action, conflictingActions) {
    const message = conflictingActions.length === 1 ? 'conflicting option string: %s' : 'conflicting option strings: %s';
    const conflictString = conflictingActions.map(([optionString]) => optionString).join(', ');
    throw new ArgumentError(action, message.replace('%s', conflictString));
  }

  _handle_conflict_resolve(action, conflictingActions) {
    for (const [optionString, conflicting] of conflictingActions) {
      conflicting.option_strings.splice(conflicting.option_strings.indexOf(optionString), 1);
      this._option_string_actions.delete(optionString);
      if (!conflicting.option_strings.length) conflicting.container._remove_action(conflicting);
    }
  }
}

class ArgumentGroup extends ActionsContainer {
  constructor(container, { title = null, description = null, ...kwargs } = {}) {
    kwargs = { ...kwargs };
    if (kwargs.conflict_handler === undefined) kwargs.conflict_handler = container.conflict_handler;
    if (kwargs.prefix_chars === undefined) kwargs.prefix_chars = container.prefix_chars;
    if (kwargs.argument_default === undefined) kwargs.argument_default = container.argument_default;
    super({ description, ...kwargs });
    this.title = title;
    this._group_actions = [];
    this._registries = container._registries;
    this._actions = container._actions;
    this._option_string_actions = container._option_string_actions;
    this._defaults = container._defaults;
    this._has_negative_number_optionals = container._has_negative_number_optionals;
    this._mutually_exclusive_groups = container._mutually_exclusive_groups;
  }

  _add_action(action) {
    action = super._add_action(action);
    this._group_actions.push(action);
    return action;
  }

  _remove_action(action) {
    super._remove_action(action);
    this._group_actions.splice(this._group_actions.indexOf(action), 1);
  }
}

class MutuallyExclusiveGroup extends ArgumentGroup {
  constructor(container, { required = false } = {}) {
    super(container);
    this.required = required;
    this._container = container;
  }

  _add_action(action) {
    if (action.required) throw new PyValueError('mutually exclusive arguments must be optional');
    action = this._container._add_action(action);
    this._group_actions.push(action);
    return action;
  }

  _remove_action(action) {
    this._container._remove_action(action);
    this._group_actions.splice(this._group_actions.indexOf(action), 1);
  }
}

// ===========================================================================================
// ArgumentParser
// ===========================================================================================
export class ArgumentParser extends ActionsContainer {
  // new ArgumentParser({prog, usage, description, epilog, parents, formatter_class, prefix_chars,
  //   fromfile_prefix_chars, argument_default, conflict_handler, add_help, allow_abbrev, exit_on_error})
  // Method names follow Python (add_argument, add_subparsers, parse_args, ...); keyword arguments are objects.
  constructor({
    prog = null,
    usage = null,
    description = null,
    epilog = null,
    parents = [],
    formatter_class: formatterClass = HelpFormatter,
    prefix_chars: prefixChars = '-',
    fromfile_prefix_chars: fromfilePrefixChars = null,
    argument_default: argumentDefault = null,
    conflict_handler: conflictHandler = 'error',
    add_help: addHelp = true,
    allow_abbrev: allowAbbrev = true,
    exit_on_error: exitOnError = true,
  } = {}) {
    super({ description, prefix_chars: prefixChars, argument_default: argumentDefault, conflict_handler: conflictHandler });
    if (prog === null || prog === undefined) prog = posixBasename(io.argv0());
    this.prog = prog;
    this.usage = usage;
    this.epilog = epilog;
    this.formatter_class = formatterClass;
    this.fromfile_prefix_chars = fromfilePrefixChars;
    this.add_help = addHelp;
    this.allow_abbrev = allowAbbrev;
    this.exit_on_error = exitOnError;

    this._positionals = this.add_argument_group({ title: 'positional arguments' });
    this._optionals = this.add_argument_group({ title: 'options' });
    this._subparsers = null;

    this.register('type', null, identity);

    const defaultPrefix = prefixChars.includes('-') ? '-' : prefixChars[0];
    if (this.add_help) {
      this.add_argument(`${defaultPrefix}h`, defaultPrefix.repeat(2) + 'help', {
        action: 'help',
        default: SUPPRESS,
        help: 'show this help message and exit',
      });
    }

    for (const parent of parents) {
      this._add_container_actions(parent);
      if (parent._defaults) Object.assign(this._defaults, parent._defaults);
    }
  }

  add_subparsers(kwargs = {}) {
    kwargs = { ...kwargs };
    if (this._subparsers !== null) throw new ArgumentError(null, 'cannot have multiple subparser arguments');
    if (kwargs.parser_class === undefined) kwargs.parser_class = this.constructor;
    if ('title' in kwargs || 'description' in kwargs) {
      const title = 'title' in kwargs ? kwargs.title : 'subcommands';
      const description = 'description' in kwargs ? kwargs.description : null;
      delete kwargs.title;
      delete kwargs.description;
      this._subparsers = this.add_argument_group({ title, description });
    } else {
      this._subparsers = this._positionals;
    }
    if (kwargs.prog === undefined || kwargs.prog === null) {
      const formatter = this._get_formatter();
      const positionals = this._get_positional_actions();
      formatter.add_usage(this.usage, positionals, this._mutually_exclusive_groups, '');
      kwargs.prog = pyStrip(formatter.format_help());
    }
    const parsersClass = this._pop_action_class(kwargs, 'parsers');
    const action = new parsersClass({ option_strings: [], ...kwargs });
    this._subparsers._add_action(action);
    return action;
  }

  _add_action(action) {
    if (action.option_strings.length) this._optionals._add_action(action);
    else this._positionals._add_action(action);
    return action;
  }

  _get_optional_actions() {
    return this._actions.filter((action) => action.option_strings.length);
  }

  _get_positional_actions() {
    return this._actions.filter((action) => !action.option_strings.length);
  }

  parse_args(args = null, namespace = null) {
    const [parsed, argv] = this.parse_known_args(args, namespace);
    if (argv.length) {
      const msg = `unrecognized arguments: ${argv.join(' ')}`;
      if (this.exit_on_error) this.error(msg);
      else throw new ArgumentError(null, msg);
    }
    return parsed;
  }

  parse_known_args(args = null, namespace = null) {
    return this._parse_known_args2(args, namespace, false);
  }

  _parse_known_args2(args, namespace, intermixed) {
    args = args === null || args === undefined ? io.argv().slice() : [...args];
    if (namespace === null || namespace === undefined) namespace = new Namespace();

    for (const action of this._actions) {
      if (action.dest !== SUPPRESS) {
        if (!namespace.has(action.dest)) {
          if (action.default !== SUPPRESS) namespace.set(action.dest, action.default);
        }
      }
    }
    for (const dest of Object.keys(this._defaults)) {
      if (!namespace.has(dest)) namespace.set(dest, this._defaults[dest]);
    }

    if (this.exit_on_error) {
      try {
        [namespace, args] = this._parse_known_args(args, namespace, intermixed);
      } catch (error) {
        if (error instanceof ArgumentError) this.error(error.toString());
        else throw error;
      }
    } else {
      [namespace, args] = this._parse_known_args(args, namespace, intermixed);
    }

    if (namespace.has(UNRECOGNIZED_ARGS_ATTR)) {
      args.push(...namespace.get(UNRECOGNIZED_ARGS_ATTR));
      namespace.delete(UNRECOGNIZED_ARGS_ATTR);
    }
    return [namespace, args];
  }

  _parse_known_args(argStrings, namespace, intermixed) {
    if (this.fromfile_prefix_chars !== null) argStrings = this._read_args_from_files(argStrings);

    const actionConflicts = new Map();
    for (const mutexGroup of this._mutually_exclusive_groups) {
      const groupActions = mutexGroup._group_actions;
      groupActions.forEach((mutexAction, i) => {
        if (!actionConflicts.has(mutexAction)) actionConflicts.set(mutexAction, []);
        const conflicts = actionConflicts.get(mutexAction);
        conflicts.push(...groupActions.slice(0, i));
        conflicts.push(...groupActions.slice(i + 1));
      });
    }

    const optionStringIndices = new Map();
    const patternParts = [];
    for (let i = 0; i < argStrings.length; i += 1) {
      const argString = argStrings[i];
      if (argString === '--') {
        patternParts.push('-');
        for (i += 1; i < argStrings.length; i += 1) patternParts.push('A');
      } else {
        const optionTuples = this._parse_optional(argString);
        let pattern;
        if (optionTuples === null) pattern = 'A';
        else {
          optionStringIndices.set(i, optionTuples);
          pattern = 'O';
        }
        patternParts.push(pattern);
      }
    }
    let argStringsPattern = patternParts.join('');

    const seenActions = new Set();
    const seenNonDefaultActions = new Set();

    const takeAction = (action, argumentStrings, optionString = null) => {
      seenActions.add(action);
      const argumentValues = this._get_values(action, argumentStrings);
      if (action.option_strings.length || argumentStrings.length) {
        seenNonDefaultActions.add(action);
        for (const conflictAction of actionConflicts.get(action) ?? []) {
          if (seenNonDefaultActions.has(conflictAction)) {
            throw new ArgumentError(action, `not allowed with argument ${getActionName(conflictAction)}`);
          }
        }
      }
      if (argumentValues !== SUPPRESS) action.call(this, namespace, argumentValues, optionString);
    };

    const extras = [];
    let extrasPattern = [];

    const consumeOptional = (startIndex) => {
      const optionTuples = optionStringIndices.get(startIndex);
      if (optionTuples.length > 1) {
        const options = optionTuples.map(([, optionString]) => optionString).join(', ');
        throw new ArgumentError(null, `ambiguous option: ${argStrings[startIndex]} could match ${options}`);
      }
      let [action, optionString, sep, explicitArg] = optionTuples[0];
      const matchArgument = this._match_argument.bind(this);
      const actionTuples = [];
      let stop;
      for (;;) {
        if (action === null) {
          extras.push(argStrings[startIndex]);
          extrasPattern.push('O');
          return startIndex + 1;
        }
        if (explicitArg !== null) {
          const argCount = matchArgument(action, 'A');
          const chars = this.prefix_chars;
          if (argCount === 0 && !chars.includes(cpArray(optionString)[1]) && explicitArg !== '') {
            if (sep || chars.includes(cpHead(explicitArg))) {
              throw new ArgumentError(action, `ignored explicit argument ${pyRepr(explicitArg)}`);
            }
            actionTuples.push([action, [], optionString]);
            const char = cpHead(optionString);
            optionString = char + cpHead(explicitArg);
            const optionalsMap = this._option_string_actions;
            if (optionalsMap.has(optionString)) {
              action = optionalsMap.get(optionString);
              explicitArg = cpTail(explicitArg);
              if (!explicitArg) {
                sep = null;
                explicitArg = null;
              } else if (explicitArg[0] === '=') {
                sep = '=';
                explicitArg = explicitArg.slice(1);
              } else {
                sep = '';
              }
            } else {
              extras.push(char + explicitArg);
              extrasPattern.push('O');
              stop = startIndex + 1;
              break;
            }
          } else if (argCount === 1) {
            stop = startIndex + 1;
            actionTuples.push([action, [explicitArg], optionString]);
            break;
          } else {
            throw new ArgumentError(action, `ignored explicit argument ${pyRepr(explicitArg)}`);
          }
        } else {
          const start = startIndex + 1;
          const selectedPatterns = argStringsPattern.slice(start);
          const argCount = matchArgument(action, selectedPatterns);
          stop = start + argCount;
          actionTuples.push([action, argStrings.slice(start, stop), optionString]);
          break;
        }
      }
      if (!actionTuples.length) throw new PyAssertionError('action_tuples');
      for (const [act, args, optString] of actionTuples) takeAction(act, args, optString);
      return stop;
    };

    const positionals = this._get_positional_actions();

    const consumePositionals = (startIndex) => {
      const selectedPattern = argStringsPattern.slice(startIndex);
      const argCounts = this._match_arguments_partial(positionals, selectedPattern);
      for (let k = 0; k < Math.min(positionals.length, argCounts.length); k += 1) {
        const action = positionals[k];
        const argCount = argCounts[k];
        const args = argStrings.slice(startIndex, startIndex + argCount);
        if (action.nargs === PARSER) {
          if (argStringsPattern[startIndex] === '-') {
            if (args[0] !== '--') throw new PyAssertionError("args[0] == '--'");
            args.splice(args.indexOf('--'), 1);
          }
        } else if (action.nargs !== REMAINDER) {
          const idx = argStringsPattern.slice(0, startIndex + argCount).indexOf('-', startIndex);
          if (idx >= 0) args.splice(args.indexOf('--'), 1);
        }
        startIndex += argCount;
        takeAction(action, args);
      }
      positionals.splice(0, argCounts.length);
      return startIndex;
    };

    let startIndex = 0;
    const maxOptionStringIndex = optionStringIndices.size ? Math.max(...optionStringIndices.keys()) : -1;
    while (startIndex <= maxOptionStringIndex) {
      const nextOptionStringIndex = Math.min(...[...optionStringIndices.keys()].filter((index) => index >= startIndex));
      if (!intermixed && startIndex !== nextOptionStringIndex) {
        const positionalsEndIndex = consumePositionals(startIndex);
        if (positionalsEndIndex > startIndex) {
          startIndex = positionalsEndIndex;
          continue;
        } else {
          startIndex = positionalsEndIndex;
        }
      }
      if (!optionStringIndices.has(startIndex)) {
        extras.push(...argStrings.slice(startIndex, nextOptionStringIndex));
        extrasPattern.push(...argStringsPattern.slice(startIndex, nextOptionStringIndex));
        startIndex = nextOptionStringIndex;
      }
      startIndex = consumeOptional(startIndex);
    }

    let resultExtras = extras;
    if (!intermixed) {
      const stopIndex = consumePositionals(startIndex);
      resultExtras.push(...argStrings.slice(stopIndex));
    } else {
      resultExtras.push(...argStrings.slice(startIndex));
      extrasPattern.push(...argStringsPattern.slice(startIndex));
      extrasPattern = extrasPattern.join('');
      if (extrasPattern.length !== resultExtras.length) throw new PyAssertionError('extras_pattern');
      argStrings = resultExtras.filter((s, i) => extrasPattern[i] !== 'O');
      argStringsPattern = extrasPattern.replaceAll('O', '');
      let stopIndex = consumePositionals(0);
      const marked = resultExtras.slice();
      for (let i = 0; i < extrasPattern.length; i += 1) {
        if (!stopIndex) break;
        if (extrasPattern[i] !== 'O') {
          stopIndex -= 1;
          marked[i] = null;
        }
      }
      resultExtras = marked.filter((s) => s !== null);
    }

    const requiredActions = [];
    for (const action of this._actions) {
      if (!seenActions.has(action)) {
        if (action.required) requiredActions.push(getActionName(action));
        else if (action.default !== null && typeof action.default === 'string' && namespace.has(action.dest) && action.default === namespace.get(action.dest)) {
          namespace.set(action.dest, this._get_value(action, action.default));
        }
      }
    }
    if (requiredActions.length) throw new ArgumentError(null, `the following arguments are required: ${requiredActions.join(', ')}`);

    for (const group of this._mutually_exclusive_groups) {
      if (group.required) {
        if (!group._group_actions.some((action) => seenNonDefaultActions.has(action))) {
          const names = group._group_actions.filter((action) => action.help !== SUPPRESS).map(getActionName);
          throw new ArgumentError(null, `one of the arguments ${names.join(' ')} is required`);
        }
      }
    }
    return [namespace, resultExtras];
  }

  _read_args_from_files(argStrings) {
    const newArgStrings = [];
    for (const argString of argStrings) {
      if (!argString || !this.fromfile_prefix_chars.includes(cpHead(argString))) {
        newArgStrings.push(argString);
      } else {
        try {
          const content = fs.readFileSync(cpTail(argString), 'utf8');
          let fileArgs = [];
          for (const argLine of pySplitlines(content)) fileArgs.push(...this.convert_arg_line_to_args(argLine));
          fileArgs = this._read_args_from_files(fileArgs);
          newArgStrings.push(...fileArgs);
        } catch (error) {
          if (error.code) throw new ArgumentError(null, `[Errno ${error.errno}] ${error.message}`);
          throw error;
        }
      }
    }
    return newArgStrings;
  }

  convert_arg_line_to_args(argLine) {
    return [argLine];
  }

  _match_argument(action, argStringsPattern) {
    const nargsPattern = this._get_nargs_pattern(action);
    const match = new RegExp(`^${nargsPattern}`, 's').exec(argStringsPattern);
    if (match === null) {
      const nargsErrors = { [null]: 'expected one argument', [OPTIONAL]: 'expected at most one argument', [ONE_OR_MORE]: 'expected at least one argument' };
      let msg = action.nargs === null ? nargsErrors.null : nargsErrors[action.nargs];
      if (msg === undefined) msg = action.nargs === 1 ? `expected ${action.nargs} argument` : `expected ${action.nargs} arguments`;
      throw new ArgumentError(action, msg);
    }
    return match[1].length;
  }

  _match_arguments_partial(actions, argStringsPattern) {
    for (let i = actions.length; i > 0; i -= 1) {
      const actionsSlice = actions.slice(0, i);
      const pattern = actionsSlice.map((action) => this._get_nargs_pattern(action)).join('');
      const match = new RegExp(`^${pattern}`, 's').exec(argStringsPattern);
      if (match !== null) {
        const result = match.slice(1).map((string) => string.length);
        const end = match[0].length;
        if (end < argStringsPattern.length && argStringsPattern[end] === 'O') {
          while (result.length && !result[result.length - 1]) result.pop();
        }
        return result;
      }
    }
    return [];
  }

  _parse_optional(argString) {
    if (!argString) return null;
    if (!this.prefix_chars.includes(cpHead(argString))) return null;
    if (this._option_string_actions.has(argString)) return [[this._option_string_actions.get(argString), argString, null, null]];
    if (cpLen(argString) === 1) return null;
    const [optionString, sep, explicitArg] = pyPartition(argString, '=');
    if (sep && this._option_string_actions.has(optionString)) {
      return [[this._option_string_actions.get(optionString), optionString, sep, explicitArg]];
    }
    const optionTuples = this._get_option_tuples(argString);
    if (optionTuples.length) return optionTuples;
    if (NEGATIVE_NUMBER.test(argString)) {
      if (!this._has_negative_number_optionals.length) return null;
    }
    if (argString.includes(' ')) return null;
    return [[null, argString, null, null]];
  }

  _get_option_tuples(optionString) {
    const result = [];
    const chars = this.prefix_chars;
    const cps = cpArray(optionString);
    if (chars.includes(cps[0]) && chars.includes(cps[1])) {
      if (this.allow_abbrev) {
        let [optionPrefix, sep, explicitArg] = pyPartition(optionString, '=');
        if (!sep) {
          sep = null;
          explicitArg = null;
        }
        for (const [candidate, action] of this._option_string_actions) {
          if (candidate.startsWith(optionPrefix)) result.push([action, candidate, sep, explicitArg]);
        }
      }
    } else if (chars.includes(cps[0]) && !chars.includes(cps[1])) {
      let [optionPrefix, sep, explicitArg] = pyPartition(optionString, '=');
      if (!sep) {
        sep = null;
        explicitArg = null;
      }
      const shortOptionPrefix = cps.slice(0, 2).join('');
      const shortExplicitArg = cps.slice(2).join('');
      for (const [candidate, action] of this._option_string_actions) {
        if (candidate === shortOptionPrefix) result.push([action, candidate, '', shortExplicitArg]);
        else if (this.allow_abbrev && candidate.startsWith(optionPrefix)) result.push([action, candidate, sep, explicitArg]);
      }
    } else {
      throw new ArgumentError(null, `unexpected option string: ${optionString}`);
    }
    return result;
  }

  _get_nargs_pattern(action) {
    const { nargs } = action;
    const option = action.option_strings.length > 0;
    let nargsPattern;
    if (nargs === null) nargsPattern = option ? '([A])' : '(-*A-*)';
    else if (nargs === OPTIONAL) nargsPattern = option ? '(A?)' : '(-*A?-*)';
    else if (nargs === ZERO_OR_MORE) nargsPattern = option ? '(A*)' : '(-*[A-]*)';
    else if (nargs === ONE_OR_MORE) nargsPattern = option ? '(A+)' : '(-*A[A-]*)';
    else if (nargs === REMAINDER) nargsPattern = option ? '([AO]*)' : '(.*)';
    else if (nargs === PARSER) nargsPattern = option ? '(A[AO]*)' : '(-*A[-AO]*)';
    else if (nargs === SUPPRESS) nargsPattern = option ? '()' : '(-*)';
    else nargsPattern = option ? `([AO]{${nargs}})` : `((?:-*A){${nargs}}-*)`;
    return nargsPattern;
  }

  parse_intermixed_args(args = null, namespace = null) {
    const [parsed, argv] = this.parse_known_intermixed_args(args, namespace);
    if (argv.length) {
      const msg = `unrecognized arguments: ${argv.join(' ')}`;
      if (this.exit_on_error) this.error(msg);
      else throw new ArgumentError(null, msg);
    }
    return parsed;
  }

  parse_known_intermixed_args(args = null, namespace = null) {
    const a = this._get_positional_actions().filter((action) => action.nargs === PARSER || action.nargs === REMAINDER);
    if (a.length) throw new PyTypeError(`parse_intermixed_args: positional arg with nargs=${a[0].nargs}`);
    return this._parse_known_args2(args, namespace, true);
  }

  _get_values(action, argStrings) {
    let value;
    if (!argStrings.length && action.nargs === OPTIONAL) {
      value = action.option_strings.length ? action.const : action.default;
      if (typeof value === 'string' && value !== SUPPRESS) {
        value = this._get_value(action, value);
        this._check_value(action, value);
      }
    } else if (!argStrings.length && action.nargs === ZERO_OR_MORE && !action.option_strings.length) {
      if (action.default !== null) {
        value = action.default;
        this._check_value(action, value);
      } else {
        value = argStrings;
      }
    } else if (argStrings.length === 1 && (action.nargs === null || action.nargs === OPTIONAL)) {
      value = this._get_value(action, argStrings[0]);
      this._check_value(action, value);
    } else if (action.nargs === REMAINDER) {
      value = argStrings.map((v) => this._get_value(action, v));
    } else if (action.nargs === PARSER) {
      value = argStrings.map((v) => this._get_value(action, v));
      this._check_value(action, value[0]);
    } else if (action.nargs === SUPPRESS) {
      value = SUPPRESS;
    } else {
      value = argStrings.map((v) => this._get_value(action, v));
      for (const v of value) this._check_value(action, v);
    }
    return value;
  }

  _get_value(action, argString) {
    const typeFunc = this._registry_get('type', action.type, action.type);
    if (typeof typeFunc !== 'function') throw new ArgumentError(action, `${pyRepr(typeFunc)} is not callable`);
    try {
      return typeFunc(argString);
    } catch (error) {
      if (error instanceof ArgumentTypeError) throw new ArgumentError(action, error.message);
      if (error instanceof PyTypeError || error instanceof PyValueError) {
        const name = action.type !== null && typeof action.type === 'function' ? action.type.pyName ?? action.type.name : pyRepr(action.type);
        throw new ArgumentError(action, `invalid ${name} value: ${pyRepr(argString)}`);
      }
      throw error;
    }
  }

  _check_value(action, value) {
    const { choices } = action;
    if (choices !== null) {
      if (!choicesHas(choices, value)) {
        const msg = `invalid choice: ${pyRepr(pyStr(value))} (choose from ${choicesList(choices).map(pyStr).join(', ')})`;
        throw new ArgumentError(action, msg);
      }
    }
  }

  format_usage() {
    const formatter = this._get_formatter();
    formatter.add_usage(this.usage, this._actions, this._mutually_exclusive_groups);
    return formatter.format_help();
  }

  format_help() {
    const formatter = this._get_formatter();
    formatter.add_usage(this.usage, this._actions, this._mutually_exclusive_groups);
    formatter.add_text(this.description);
    for (const actionGroup of this._action_groups) {
      formatter.start_section(actionGroup.title);
      formatter.add_text(actionGroup.description);
      formatter.add_arguments(actionGroup._group_actions);
      formatter.end_section();
    }
    formatter.add_text(this.epilog);
    return formatter.format_help();
  }

  _get_formatter() {
    return new this.formatter_class({ prog: this.prog });
  }

  print_usage(file = null) {
    this._print_message(this.format_usage(), file ?? io.stdout);
  }

  print_help(file = null) {
    this._print_message(this.format_help(), file ?? io.stdout);
  }

  _print_message(message, file = null) {
    if (message) {
      file = file ?? io.stderr;
      try {
        file(message);
      } catch (error) {
        if (!error.code) throw error;
      }
    }
  }

  exit(status = 0, message = null) {
    if (message) this._print_message(message, io.stderr);
    io.exit(status);
    // io.exit must not return; mirror sys.exit() when a replacement does.
    throw new PySystemExit(status);
  }

  error(message) {
    this.print_usage(io.stderr);
    this.exit(2, `${this.prog}: error: ${message}\n`);
  }
}

// Convenience: Python's `%`-formatting of help text, exported for callers that build text the same way.
