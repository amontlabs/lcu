// The HTTP behaviour of lcu/update.py and lcu/update_apply.py on Node built-ins (net, tls, crypto, child_process).
//
// What is reproduced (Python 3.12 urllib.request.urlopen / build_opener):
//  * request bytes: request line, `Accept-Encoding: identity`, `Host`, `User-Agent: lcu-update`, `Connection: close`
//    in that order, HTTP/1.1, no other headers;
//  * redirect policy: urlopen follows 301/302/303/307/308 (max 10 redirects, max 4 visits of one URL, Python's loop
//    error text); the latest-tag lookup uses a no-redirect opener and reads `Location` from the 3xx HTTPError;
//  * timeouts are per socket operation (connect / each recv), like Python's socket timeout;
//  * proxies from the environment as urllib's getproxies_environment/proxy_bypass_environment (https via CONNECT
//    tunnel, http via absolute-form request line, Basic Proxy-Authorization from the proxy URL);
//  * truncated Content-Length bodies end silently (CPython http.client does not raise), truncated chunked bodies
//    raise IncompleteRead;
//  * error texts: str(URLError) "<urlopen error ...>", str(HTTPError) "HTTP Error 404: Not Found", socket errors as
//    "[Errno N] strerror", TLS verification failures as "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ...";
//  * the curl fallback on certificate failures, with Python's exact curl argv.
//
// Changes 2026-10-05 (compat-archive-http review F04-F06, F10, F16):
//  * URL validation like urllib/http.client: Request unwrapping and percent-decoded host, HTTPConnection host and
//    port checks, putrequest's control-character check and ASCII encoding of the request line. InvalidURL and
//    UnicodeEncodeError are raised before any connection or byte is sent (CRLF in a URL cannot inject a header);
//  * trust anchors: SSL_CERT_FILE and SSL_CERT_DIR (hashed-name certificate files) as OpenSSL reads them;
//  * macOS system proxies (`/usr/sbin/scutil --proxy`, parsed like CPython's _scproxy) when the proxy environment
//    is empty, with CPython's proxy_bypass_macosx_sysconf rules;
//  * ValueError is the single class of compat/pyjson.mjs (PyValueError remains an alias of it).
//
// Changes 2026-10-05 (update review F04-F06, F09, F10, F19-F27, F31, F34, F35, F41):
//  * the response layer is a port of http.client: status line (`str.split(None, 2)`, int() status, UnknownProtocol),
//    100-continue skipping, raw header lines (100-line limit counting continuation lines and the blank line), the
//    email.parser header model (values keep trailing white space and folded lines; leading blanks dropped; parsing stops
//    at the first non-header line), Content-Length and chunk sizes with Python's int() grammar (signs, spaces, underscores,
//    0x, negative sizes), _get_chunk_left/_read_chunked/_safe_read exactly (two bytes after a chunk, IncompleteRead counts);
//  * downloads write every byte they hash (short writes are completed), close the response on every path, can report
//    progress through a callback, and refuse a redirect from https to a non-https URL (documented hardening, urllib
//    follows it); curl is killed with SIGKILL on timeout like subprocess.run;
//  * Windows registry proxies (`reg.exe query`, urllib's getproxies_registry/_proxy_bypass_winreg_override) next to the
//    macOS adapter; proxy URL schemes follow ProxyHandler (https:// = TLS to the proxy, other non-http schemes are
//    "unknown url type" for plain-http targets, https targets always tunnel);
//  * NODE_TLS_REJECT_UNAUTHORIZED is hidden during tls.connect (explicit rejectUnauthorized always wins; this only keeps
//    Node's own warning off LCU's verified requests) and restored afterwards.
// Not supported (documented, tested): file:, data: and ftp: URLs (urllib reads them; update only uses fixed https URLs):
// "unknown url type: <scheme>". Registry bypass does not resolve host names (the registry rules are glob matches).
//
// Security properties (never weakened): certificate and host name verification are always on (rejectUnauthorized is
// forced to true on every TLS connection, so an inherited NODE_TLS_REJECT_UNAUTHORIZED=0 has no effect and no option
// or environment variable disables verification); the curl fallback runs `curl -q ...` so that no ~/.curlrc (which
// could contain `insecure`, a proxy or another CA) is read. `-q` is an intentional hardening: Python's argv had no
// `-q` (otherwise the argv is identical to update.curl's).
//
// Documented differences from Python/CPython 3.12 (not parity claims):
//  * Trust store: Node uses its bundled roots (plus the OS store when Node exposes it via tls.getCACertificates('system'))
//    where Python/OpenSSL use the OpenSSL default paths. With SSL_CERT_FILE set only that file is trusted (OpenSSL
//    would also keep its compiled-in default directory); SSL_CERT_DIR adds the certificates of "<subject hash>.<n>"
//    files in its directories (the hash is recomputed with compat/openssl_hash.mjs; n is any number, as in OpenSSL 3).
//    Unreadable paths contribute nothing, like OpenSSL. A machine where Python
//    failed verification (python.org macOS builds) will usually verify fine here, so the curl fallback fires less
//    often; when it does, the argv is identical (plus -q).
//  * Proxies: Windows registry proxies (urllib's getproxies_registry) are not read; on Linux urllib has no system
//    source either. The macOS settings come from `scutil --proxy` (same SystemConfiguration data as _scproxy), and
//    fnmatch exception patterns follow fnmatch.translate. An `https://` proxy URL is contacted in plain text, as
//    urllib does for https targets.
//  * The "(_ssl.c:NNNN)" source line in TLS verification messages is fixed to 1000. CPython 3.12.10 builds print
//    1010 (other builds 1000-1020); everything else in the message matches, and tests normalise this line only. TLS
//    error texts are therefore NOT byte-identical to a given Python build; rejection decisions are.
//  * Non-ASCII host names are sent as given; out-of-range ports are reported by Node (a plain OSError text) where
//    CPython raises OverflowError/gaierror.
//  * The curl-missing message says "LCU cannot verify HTTPS certificates ..." (Python's text named Python; the Node build
//    no longer uses Python's TLS stack: a documented, deliberate rewording, see docs/releases/UNRELEASED-node-runtime.md);
//    the text lives in the exported CURL_MISSING_MESSAGE constant.
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from './spawn.mjs';
import { constants as osConstants } from 'node:os';
import { PyOSError, pyRepr, toPyOSError, ValueError } from './errors.mjs';
import * as pyerr from './pyerr.mjs';
import { UnicodeEncodeError as PyUnicodeEncodeError } from './pyjson.mjs';
import { writeAll } from './pypath.mjs';
import { pyInt, pyStrip, pySplit } from './pynum.mjs';
import { decode as utf8Decode } from './utf8.mjs';
import { subjectHash } from './openssl_hash.mjs';
import { sha256File } from './hash.mjs';

export const REPO = 'amontlabs/lcu';
export const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
export const RELEASE_URL = `https://github.com/${REPO}/releases/tag/`;
export const NOTES_URL = (tag, version) => `https://raw.githubusercontent.com/${REPO}/${tag}/docs/releases/${version}.md`;
export const DOWNLOAD = `https://github.com/${REPO}/releases/download`;
export const USER_AGENT = 'lcu-update';
export const UPDATE_TIMEOUT = 5; // update.TIMEOUT (seconds)
export const DOWNLOAD_TIMEOUT = 60; // update_apply.TIMEOUT (seconds)
export const SEVERITIES = ['security', 'breaking'];
export const CURL_MISSING_MESSAGE = 'LCU cannot verify HTTPS certificates and curl is not installed.';
const SSL_C_LINE = 1000;

// ---------------------------------------------------------------- errors
export class URLError extends Error {
  constructor(reason) {
    const text = typeof reason === 'string' ? reason : String(reason?.message ?? reason);
    super(`<urlopen error ${text}>`);
    this.name = 'URLError';
    this.reason = reason;
    this.isOSError = true;
  }
}
export class HTTPError extends URLError {
  constructor(url, code, msg, headers) {
    super(msg);
    this.message = `HTTP Error ${code}: ${msg}`;
    this.name = 'HTTPError';
    this.url = url; this.code = code; this.msg = msg; this.headers = headers;
  }
}
export class SSLCertVerificationError extends Error {
  constructor(detail) {
    super(`[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ${detail} (_ssl.c:${SSL_C_LINE})`);
    this.name = 'SSLCertVerificationError'; this.isOSError = true;
  }
}
export class PyTimeoutError extends Error {
  constructor(message = 'timed out') { super(message); this.name = 'TimeoutError'; this.isOSError = true; }
}
export class GaiError extends Error {
  constructor(code) {
    const mac = process.platform === 'darwin';
    const table = code === 'EAI_AGAIN'
      ? [mac ? 8 : -3, mac ? 'nodename nor servname provided, or not known' : 'Temporary failure in name resolution']
      : [mac ? 8 : -2, mac ? 'nodename nor servname provided, or not known' : 'Name or service not known'];
    super(`[Errno ${table[0]}] ${table[1]}`);
    this.name = 'gaierror'; this.isOSError = true;
  }
}
export class IncompleteRead extends Error {
  constructor(count, expected) {
    super(`IncompleteRead(${count} bytes read${expected == null ? '' : `, ${expected} more expected`})`);
    this.name = 'IncompleteRead'; this.isOSError = false; // http.client.HTTPException: not an OSError
  }
}
export class HTTPException extends Error { constructor(m, name = 'HTTPException') { super(m); this.name = name; this.isOSError = false; } }
export class RemoteDisconnected extends Error {
  constructor() { super('Remote end closed connection without response'); this.name = 'RemoteDisconnected'; this.isOSError = true; }
}
/** http.client.InvalidURL (an HTTPException: not an OSError, not a ValueError, so update/apply do not catch it). */
export class InvalidURL extends HTTPException { constructor(m) { super(m, 'InvalidURL'); } }
/** Python ValueError: the single shared class (compat/pyjson.mjs), kept under this module's historical name. */
export const PyValueError = ValueError;
/** UnicodeEncodeError from `str.encode('ascii')`: the shared class of compat/pyjson.mjs, built from a rendered message. */
export class UnicodeEncodeError extends PyUnicodeEncodeError {
  constructor(message) { super(null, message); }
}
/** Python OSError with a plain message (e.g. the curl fallback's stderr text). */
export class PlainOSError extends Error { constructor(m) { super(m); this.name = 'OSError'; this.isOSError = true; } }
/** subprocess.TimeoutExpired */
export class TimeoutExpired extends Error {
  constructor(cmd, timeout) {
    super(`Command '${pyListRepr(cmd)}' timed out after ${timeout} seconds`);
    this.name = 'TimeoutExpired'; this.isSubprocessError = true;
  }
}

export const pyListRepr = (list) => `[${list.map(pyRepr).join(', ')}]`;

/** `str(exc) or type(exc).__name__`, as update.check stores it. */
export const describeError = (err) => (err && err.message) || err?.name || 'Error';
/** `except (OSError, ValueError, subprocess.SubprocessError)` as in update.check / update_apply.apply. */
export const caughtByUpdate = (err) => Boolean(err && (err.isOSError || err.isValueError || err.isSubprocessError
  || err instanceof ValueError || err instanceof pyerr.PyOSError));

/** True when Python would treat a URLError as a certificate-verification failure (update.cert_failure). */
export function certFailure(err) {
  const reason = err instanceof URLError && !(err instanceof HTTPError) ? err.reason : err;
  return reason instanceof SSLCertVerificationError;
}

const CERT_MESSAGES = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in certificate chain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to get local issuer certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unable to get local issuer certificate',
  UNABLE_TO_GET_ISSUER_CERT: 'unable to get issuer certificate',
  CERT_HAS_EXPIRED: 'certificate has expired',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  CERT_REVOKED: 'certificate revoked',
  CERT_UNTRUSTED: 'certificate not trusted',
  INVALID_CA: 'invalid CA certificate',
  CERT_SIGNATURE_FAILURE: 'certificate signature failure',
};

/** Map a Node socket/TLS error to the Python exception that urllib/http.client would raise. */
export function mapNodeError(err, host) {
  if (err?.isOSError !== undefined || err instanceof pyerr.PyOSError || err instanceof HTTPException || err instanceof ValueError) {
    return err;
  }
  const code = err?.code;
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    const ip = net.isIP(host);
    return new SSLCertVerificationError(`${ip ? 'IP address' : 'Hostname'} mismatch, certificate is not valid for '${host}'.`);
  }
  if (code in CERT_MESSAGES) return new SSLCertVerificationError(CERT_MESSAGES[code]);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return new GaiError(code);
  if (code === 'ETIMEDOUT' && !err.syscall) return new PyTimeoutError();
  if (typeof code === 'string' && code in osConstants.errno) return new PyOSError(code);
  const out = new PlainOSError(err?.message ?? String(err));
  return out;
}

// ---------------------------------------------------------------- proxies
/** urllib.request.getproxies_environment */
export function getEnvProxies(env = process.env) {
  const proxies = {};
  for (const [name0, value] of Object.entries(env)) {
    const name = name0.toLowerCase();
    if (value && name.endsWith('_proxy')) proxies[name.slice(0, -6)] = value;
  }
  if ('REQUEST_METHOD' in env) delete proxies.http;
  for (const [name0, value] of Object.entries(env)) {
    if (name0.endsWith('_proxy')) {
      const name = name0.toLowerCase();
      if (value) proxies[name.slice(0, -6)] = value; else delete proxies[name.slice(0, -6)];
    }
  }
  return proxies;
}

// macOS system proxy settings: urllib reads them through _scproxy (SCDynamicStoreCopyProxies). The same dictionary is
// printed by `scutil --proxy`, run here by absolute path with a fixed environment (no inherited PATH, locale or
// DYLD_* variables).
const SCUTIL = '/usr/sbin/scutil';
const SCUTIL_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };

/**
 * Parse `scutil --proxy` text into {proxies, excludeSimple, exceptions}: _scproxy._get_proxies() builds
 * 'http://host:port' for every enabled protocol, _get_proxy_settings() returns ExcludeSimpleHostnames and the
 * ExceptionsList.
 */
export function parseScutilProxy(text) {
  const scalars = new Map();
  const exceptions = [];
  let depth = 0, current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '}') { depth = Math.max(0, depth - 1); if (depth < 2) current = null; continue; }
    if (line.endsWith('{')) {
      depth += 1;
      if (depth === 2) current = line.replace(/\s*:.*$/, '');
      continue;
    }
    const m = /^(\S+) : (.*)$/.exec(line);
    if (!m) continue;
    if (depth === 1) scalars.set(m[1], m[2]);
    else if (depth === 2 && current === 'ExceptionsList') exceptions.push(m[2]);
  }
  const proxies = {};
  for (const [protocol, label] of [['http', 'HTTP'], ['https', 'HTTPS'], ['ftp', 'FTP'], ['gopher', 'Gopher']]) {
    const enabled = pyInt(scalars.get(`${label}Enable`) ?? '');
    if (enabled === null || enabled === 0n || !scalars.has(`${label}Proxy`)) continue;
    const port = pyInt(scalars.get(`${label}Port`) ?? '');
    proxies[protocol] = port === null ? `http://${scalars.get(`${label}Proxy`)}` : `http://${scalars.get(`${label}Proxy`)}:${port}`;
  }
  const simple = pyInt(scalars.get('ExcludeSimpleHostnames') ?? '');
  return { proxies, excludeSimple: simple !== null && simple !== 0n, exceptions };
}

let systemProxyCache;
/** The system proxy settings of this machine ({proxies, excludeSimple, exceptions}), or null (not macOS/unavailable). */
export function macosSystemProxy() {
  if (process.platform !== 'darwin') return null;
  if (systemProxyCache === undefined) {
    const result = spawnSync(SCUTIL, ['--proxy'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: SCUTIL_ENV,
    });
    systemProxyCache = result.error || result.status !== 0 ? null : parseScutilProxy(result.stdout);
  }
  return systemProxyCache;
}
/** Forget the memoised system settings (tests). */

/**
 * urllib.request.getproxies(): the proxy environment, and only when that is empty (a mapping holding just `no` is not
 * empty) the macOS system configuration. `systemProxy` is the settings source (default: scutil on macOS).
 */
export function getProxies(env = process.env, { systemProxy = defaultSystemProxy } = {}) {
  const proxies = getEnvProxies(env);
  if (Object.keys(proxies).length) return proxies;
  return { ...(systemProxy()?.proxies ?? {}) };
}

function splitPort(host) {
  const m = /^(.*):([0-9]*)$/s.exec(host);
  if (m) { const [, h, p] = m; if (p) return [h, p]; }
  return [host, null];
}

/** urllib.request.proxy_bypass_environment */
export function proxyBypassEnvironment(host, proxies) {
  const noProxy = proxies.no;
  if (noProxy === undefined) return false;
  if (noProxy === '*') return true;
  host = host.toLowerCase();
  const [hostonly] = splitPort(host);
  for (let name of noProxy.split(',')) {
    name = name.trim();
    if (!name) continue;
    name = name.replace(/^\.+/, '').toLowerCase();
    if (hostonly === name || host === name) return true;
    name = '.' + name;
    if (hostonly.endsWith(name) || host.endsWith(name)) return true;
  }
  return false;
}

/** ipaddress.IPv4Address(text) as an integer, or null (four decimal octets, no leading zeros). */
function ipv4Number(text) {
  const m = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

const regexEscape = (text) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** fnmatch.translate (3.12) as a JavaScript regular expression source (flags `su`). */
export function fnmatchTranslate(pattern) {
  const pat = Array.from(pattern);
  const res = [];
  const STAR = Symbol('star');
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i++];
    if (c === '*') {
      if (res.length === 0 || res[res.length - 1] !== STAR) res.push(STAR); // compress consecutive `*`
    } else if (c === '?') res.push('.');
    else if (c === '[') {
      let j = i;
      if (j < n && pat[j] === '!') j++;
      if (j < n && pat[j] === ']') j++;
      while (j < n && pat[j] !== ']') j++;
      if (j >= n) { res.push('\\['); continue; }
      let stuff = pat.slice(i, j).join('');
      if (!stuff.includes('-')) stuff = stuff.replaceAll('\\', '\\\\');
      else {
        const chunks = [];
        let k = pat[i] === '!' ? i + 2 : i + 1;
        for (;;) {
          k = pat.indexOf('-', k);
          if (k < 0 || k >= j) break;
          chunks.push(pat.slice(i, k).join(''));
          i = k + 1;
          k += 3;
        }
        const chunk = pat.slice(i, j).join('');
        if (chunk) chunks.push(chunk); else chunks[chunks.length - 1] += '-';
        // Remove empty ranges -- invalid in a regular expression.
        for (let m = chunks.length - 1; m > 0; m--) {
          const previous = Array.from(chunks[m - 1]), next = Array.from(chunks[m]);
          if (previous[previous.length - 1] > next[0]) {
            chunks[m - 1] = previous.slice(0, -1).join('') + next.slice(1).join('');
            chunks.splice(m, 1);
          }
        }
        stuff = chunks.map((part) => part.replaceAll('\\', '\\\\').replaceAll('-', '\\-')).join('-');
      }
      i = j + 1;
      if (!stuff) res.push('(?!)'); // empty range: never match
      else if (stuff === '!') res.push('.'); // negated empty range: match any character
      else {
        if (stuff[0] === '!') stuff = '^' + stuff.slice(1);
        else if (stuff[0] === '^' || stuff[0] === '[') stuff = '\\' + stuff;
        res.push(`[${stuff.replaceAll(']', '\\]')}]`);
      }
    } else res.push(regexEscape(c));
  }
  return `^(?:${res.map((part) => (part === STAR ? '.*' : part)).join('')})$`;
}

/** fnmatch.fnmatchcase(name, pattern) */
export function fnmatch(name, pattern) {
  return new RegExp(fnmatchTranslate(pattern), 'su').test(name);
}

/** urllib.request.proxy_bypass_macosx_sysconf(host) with the settings from the system configuration. */
export function proxyBypassMacosx(host, settings) {
  if (!settings) return false;
  const [hostonly] = splitPort(host);
  if (!host.includes('.') && settings.excludeSimple) return true; // simple host names
  const hostIP = ipv4Number(hostonly);
  for (const value of settings.exceptions ?? []) {
    if (!value) continue;
    const m = /^(\d+(?:\.\d+)*)(\/\d+)?/.exec(value);
    if (m !== null && hostIP !== null) {
      let parts = m[1].split('.').map((p) => BigInt(p));
      if (parts.length !== 4) parts = [...parts, 0n, 0n, 0n, 0n].slice(0, 4);
      const base = (parts[0] << 24n) | (parts[1] << 16n) | (parts[2] << 8n) | parts[3];
      let mask = m[2] === undefined ? 8 * (m[1].split('.').length) : Number(m[2].slice(1));
      if (mask < 0 || mask > 32) continue; // system libraries ignore invalid prefix lengths
      mask = BigInt(32 - mask);
      if ((BigInt(hostIP) >> mask) === (base >> mask)) return true;
    } else if (fnmatch(host, value)) return true;
  }
  return false;
}

// ---- Windows registry proxies (urllib's getproxies_registry / proxy_bypass_registry, nt branch)
const REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** `reg.exe query` output: Map name -> {type, data} (REG_DWORD data as "0x1"). */
export function parseRegQuery(text) {
  const values = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_[A-Z_]+)(?:\s+(.*))?$/.exec(line);
    if (m) values.set(m[1], { type: m[2], data: (m[3] ?? '').replace(/\s+$/, '') });
  }
  return values;
}

/** Python truthiness of a registry value as winreg.QueryValueEx returns it (DWORD -> int, others -> str). */
function registryTruthy(value) {
  if (value.type === 'REG_DWORD') { const n = pyInt(value.data, 16); return n !== null && n !== 0n; }
  return value.data !== '';
}

/** urllib.request.getproxies_registry over already-read values. A missing value is an OSError (nothing configured). */
export function getProxiesRegistry(values) {
  const proxies = {};
  const enable = values.get('ProxyEnable');
  if (!enable || !registryTruthy(enable)) return proxies;
  const server = values.get('ProxyServer');
  if (!server) return proxies;
  let proxyServer = server.data;
  if (!proxyServer.includes('=') && !proxyServer.includes(';')) { // one setting for all protocols
    proxyServer = `http=${proxyServer};https=${proxyServer};ftp=${proxyServer}`;
  }
  for (const entry of proxyServer.split(';')) {
    const eq = entry.indexOf('=');
    if (eq < 0) return proxies; // ValueError while unpacking: what was built so far stays
    const protocol = entry.slice(0, eq);
    let address = entry.slice(eq + 1);
    if (!/^(?:[^/:]+):\/\//.test(address)) { // add a type:// prefix to a bare address
      if (['http', 'https', 'ftp'].includes(protocol)) address = 'http://' + address; // Windows' default proxy type is HTTP
      else if (protocol === 'socks') address = 'socks://' + address;
    }
    proxies[protocol] = address;
  }
  if (proxies.socks) { // use a SOCKS proxy for HTTP(S) too; Windows' default SOCKS type is SOCKS4
    const address = proxies.socks.replace(/^socks:\/\//, 'socks4://');
    proxies.http = proxies.http || address;
    proxies.https = proxies.https || address;
  }
  return proxies;
}

/** urllib.request._proxy_bypass_winreg_override(host, override); `normcase` lower-cases both sides like ntpath. */
export function proxyBypassWinreg(host, override, { normcase = process.platform === 'win32' } = {}) {
  const [hostonly] = splitPort(host);
  const fold = (text) => (normcase ? text.toLowerCase().replaceAll('/', '\\') : text);
  for (let test of override.split(';')) {
    test = pyStrip(test);
    if (test === '<local>') { // all intranet addresses
      if (!hostonly.includes('.')) return true;
    } else if (fnmatch(fold(hostonly), fold(test))) return true;
  }
  return false;
}

/**
 * The registry proxy settings as the system source ({kind: 'windows', proxies, enabled, override}); null off Windows
 * or when reg.exe fails. reg.exe is run by absolute path with a fixed environment. Fixture-tested only (no live
 * Windows claim). Hosts are not resolved: urllib's registry bypass does not resolve names either.
 */
let windowsProxyCache;
export function windowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  if (windowsProxyCache === undefined) {
    const root = /^[A-Za-z]:\\Windows$/i.test(process.env.SystemRoot ?? '') ? process.env.SystemRoot : 'C:\\Windows';
    const result = spawnSync(`${root}\\System32\\reg.exe`, ['query', REGISTRY_KEY], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { SystemRoot: root, PATH: `${root}\\System32` },
    });
    windowsProxyCache = result.error || result.status !== 0 ? null : registrySettings(parseRegQuery(result.stdout));
  }
  return windowsProxyCache;
}

/** The system source object for the values of the registry key. */
export function registrySettings(values) {
  const enable = values.get('ProxyEnable');
  const override = values.get('ProxyOverride');
  return {
    kind: 'windows', proxies: getProxiesRegistry(values),
    enabled: Boolean(enable) && registryTruthy(enable), override: override ? override.data : null,
  };
}

/** The proxy configuration of this machine's system store (macOS scutil, Windows registry), or null. */
export function defaultSystemProxy() {
  if (process.platform === 'darwin') return macosSystemProxy();
  if (process.platform === 'win32') return windowsSystemProxy();
  return null;
}

/** urllib.request.proxy_bypass(host): the environment's no_proxy when a proxy environment exists, else the system's. */
export function proxyBypass(host, env = process.env, { systemProxy = defaultSystemProxy } = {}) {
  const proxies = getEnvProxies(env);
  if (Object.keys(proxies).length) return proxyBypassEnvironment(host, proxies);
  const settings = systemProxy();
  if (settings?.kind === 'windows') { // proxy_bypass_registry
    if (!settings.enabled || !settings.override) return false;
    return proxyBypassWinreg(host, settings.override);
  }
  return proxyBypassMacosx(host, settings);
}

/** urllib.request._parse_proxy: {scheme (lower-case or null), user, password, hostport}. */
function parseProxy(proxy) {
  const m = /^([^/:]+):(.*)$/s.exec(proxy);
  let scheme = m ? m[1].toLowerCase() : null;
  const rest = m ? m[2] : proxy;
  let authority;
  if (!m || !rest.startsWith('/')) { scheme = null; authority = proxy; } else {
    if (!rest.startsWith('//')) throw new PyValueError(`proxy URL with no authority: ${pyRepr(proxy)}`);
    const at = rest.indexOf('@');
    const end = at !== -1 ? rest.indexOf('/', at) : rest.indexOf('/', 2);
    authority = rest.slice(2, end === -1 ? undefined : end);
  }
  const at = authority.lastIndexOf('@');
  const userinfo = at !== -1 ? authority.slice(0, at) : null;
  const hostport = at !== -1 ? authority.slice(at + 1) : authority;
  let user = null, password = null;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(':');
    if (colon !== -1) { user = userinfo.slice(0, colon); password = userinfo.slice(colon + 1); } else user = userinfo;
  }
  return { scheme, user, password, hostport };
}

/**
 * urllib ProxyHandler.proxy_open: the proxy to use for a request of `scheme` to `host`, or null.
 * `type` is the proxy URL's scheme (null for a bare authority).
 */
export function selectProxy(scheme, host, env = process.env, options = {}) {
  const proxies = getProxies(env, options);
  const proxy = proxies[scheme];
  if (!proxy) return null;
  const { scheme: type, user, password, hostport } = parseProxy(proxy);
  if (host && proxyBypass(host, env, options)) return null;
  const out = { hostport, authorization: null, type };
  if (user && password) {
    out.authorization = 'Basic ' + Buffer.from(`${unquote(user)}:${unquote(password)}`).toString('base64');
  }
  return out;
}

// ---------------------------------------------------------------- urllib.parse
const SCHEME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.';
const USES_RELATIVE = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'imap', 'wais', 'file', 'https', 'shttp', 'mms',
  'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp', 'svn', 'svn+ssh', 'ws', 'wss']);
const USES_NETLOC = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https',
  'shttp', 'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh',
  'ws', 'wss', 'itms-services']);
const USES_PARAMS = new Set(['', 'ftp', 'hdl', 'prospero', 'http', 'imap', 'https', 'shttp', 'rtsp', 'rtsps', 'rtspu',
  'sip', 'sips', 'mms', 'sftp', 'tel']);

/** urllib.parse.unquote: percent-escapes decoded as UTF-8 with errors='replace'. */
export function unquote(text) {
  if (!text.includes('%')) return text;
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    Buffer.from(run.replace(/%/g, ''), 'hex')));
}

/** urllib.parse.quote(text, encoding='iso-8859-1', safe=string.punctuation) */
export function quoteLatin1(text) {
  const safe = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (/[A-Za-z0-9_.\-~]/.test(ch) || safe.includes(ch)) out += ch;
    else if (cp > 255) throw new UnicodeEncodeError(`'latin-1' codec can't encode character '${escapeChar(cp)}' in position 0: ordinal not in range(256)`);
    else out += '%' + cp.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function checkBracketedHost(hostname) {
  if (hostname.startsWith('v')) {
    if (!/^v[a-fA-F0-9]+\..+$/s.test(hostname)) throw new ValueError('IPvFuture address is invalid');
  } else if (net.isIPv4(hostname)) {
    throw new ValueError('An IPv4 address cannot be in brackets');
  } else if (!net.isIPv6(hostname)) {
    throw new ValueError(`${pyRepr(hostname)} does not appear to be an IPv4 or IPv6 address`);
  }
}

function checkBracketedNetloc(netloc) {
  const hostnameAndPort = netloc.slice(netloc.lastIndexOf('@') + 1);
  const open = hostnameAndPort.indexOf('[');
  let hostname;
  if (open !== -1) {
    if (open > 0) throw new ValueError('Invalid IPv6 URL'); // no data is allowed before a bracket
    const bracketed = hostnameAndPort.slice(open + 1);
    const close = bracketed.indexOf(']');
    hostname = close === -1 ? bracketed : bracketed.slice(0, close);
    const port = close === -1 ? '' : bracketed.slice(close + 1);
    if (port && !port.startsWith(':')) throw new ValueError('Invalid IPv6 URL');
  } else hostname = hostnameAndPort.split(':', 1)[0];
  checkBracketedHost(hostname);
}

function checkNetloc(netloc) {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const n = netloc.replace(/[@:#?]/g, '');
  const netloc2 = n.normalize('NFKC');
  if (n === netloc2) return;
  for (const c of '/?#@:') {
    if (netloc2.includes(c)) throw new ValueError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

/** urllib.parse.urlsplit: {scheme, netloc, path, query, fragment}. */
export function urlsplit(url, scheme = '') {
  url = url.replace(/^[\x00-\x20]+/, ''); // only lstrip the URL
  scheme = scheme.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
  url = url.replace(/[\t\r\n]/g, '');
  scheme = scheme.replace(/[\t\r\n]/g, '');
  let netloc = '', query = '', fragment = '';
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(url[0]) && Array.from(url.slice(0, i)).every((c) => SCHEME_CHARS.includes(c))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') { const at = url.indexOf(c, 2); if (at >= 0) delim = Math.min(delim, at); }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    const open = netloc.includes('['), close = netloc.includes(']');
    if ((open && !close) || (close && !open)) throw new ValueError('Invalid IPv6 URL');
    if (open && close) checkBracketedNetloc(netloc);
  }
  let at = url.indexOf('#');
  if (at !== -1) { fragment = url.slice(at + 1); url = url.slice(0, at); }
  at = url.indexOf('?');
  if (at !== -1) { query = url.slice(at + 1); url = url.slice(0, at); }
  checkNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}

/** urllib.parse.urlparse: urlsplit plus the `;params` split. */
export function urlparse(url, scheme = '') {
  const s = urlsplit(url, scheme);
  let params = '';
  if (USES_PARAMS.has(s.scheme) && s.path.includes(';')) {
    let i;
    if (s.path.includes('/')) {
      i = s.path.indexOf(';', s.path.lastIndexOf('/'));
      if (i < 0) return { ...s, params };
    } else i = s.path.indexOf(';');
    params = s.path.slice(i + 1);
    return { ...s, path: s.path.slice(0, i), params };
  }
  return { ...s, params };
}

function urlunsplit({ scheme, netloc, path, query, fragment }) {
  let url = path;
  if (netloc) {
    if (url && url[0] !== '/') url = '/' + url;
    url = '//' + netloc + url;
  } else if (url.startsWith('//')) url = '//' + url;
  else if (scheme && USES_NETLOC.has(scheme) && (!url || url[0] === '/')) url = '//' + url;
  if (scheme) url = scheme + ':' + url;
  if (query) url += '?' + query;
  if (fragment) url += '#' + fragment;
  return url;
}

/** urllib.parse.urlunparse */
export function urlunparse(parts) {
  const path = parts.params ? `${parts.path};${parts.params}` : parts.path;
  return urlunsplit({ ...parts, path });
}

/** urllib.parse.urljoin (3.12) */
export function urljoin(base, url) {
  if (!base) return url;
  if (!url) return base;
  const b = urlparse(base, '');
  const u = urlparse(url, b.scheme);
  let { scheme, netloc, path, params, query } = u;
  if (scheme !== b.scheme || !USES_RELATIVE.has(scheme)) return url;
  if (USES_NETLOC.has(scheme)) {
    if (netloc) return urlunparse({ scheme, netloc, path, params, query, fragment: u.fragment });
    netloc = b.netloc;
  }
  if (!path && !params) {
    path = b.path; params = b.params;
    if (!query) query = b.query;
    return urlunparse({ scheme, netloc, path, params, query, fragment: u.fragment });
  }
  const baseParts = b.path.split('/');
  if (baseParts[baseParts.length - 1] !== '') baseParts.pop(); // the last item is not a directory
  let segments;
  if (path[0] === '/') segments = path.split('/');
  else {
    segments = [...baseParts, ...path.split('/')];
    // filter out elements that would cause redundant slashes on re-joining the resolved path
    segments = [segments[0], ...segments.slice(1, -1).filter(Boolean), ...(segments.length > 1 ? [segments[segments.length - 1]] : [])];
  }
  const resolved = [];
  for (const seg of segments) {
    if (seg === '..') resolved.pop();
    else if (seg === '.') continue;
    else resolved.push(seg);
  }
  if (segments[segments.length - 1] === '.' || segments[segments.length - 1] === '..') resolved.push('');
  return urlunparse({ scheme, netloc, path: resolved.join('/') || '/', params, query, fragment: u.fragment });
}

/** HTTPRedirectHandler.http_error_302 (3.12.10): the URL of the next request for a Location value, or an HTTPError text. */
export function redirectUrl(currentUrl, location) {
  const parts = urlparse(location);
  if (!['http', 'https', 'ftp', ''].includes(parts.scheme)) return { notAllowed: true };
  if (!parts.path && parts.netloc) parts.path = '/';
  return { url: urljoin(currentUrl, quoteLatin1(urlunparse(parts))) };
}

// ---------------------------------------------------------------- URL helpers
/** urllib.parse.unwrap */
function unwrap(url) {
  url = pyStrip(String(url));
  if (url.startsWith('<') && url.endsWith('>')) url = pyStrip(url.slice(1, -1));
  if (url.startsWith('URL:')) url = pyStrip(url.slice(4));
  return url;
}

/**
 * Request._parse: scheme, host (with port) and selector as urllib derives them. `full` is the URL without its
 * fragment (the fragment is kept in `fragment`; a proxied plain-http request line carries it, as in Python).
 */
export function parseUrl(url) {
  let full = unwrap(url);
  let fragment = null;
  const hash = full.lastIndexOf('#'); // _splittag: rpartition('#')
  if (hash !== -1) { fragment = full.slice(hash + 1); full = full.slice(0, hash); }
  const m = /^([^/:]+):(.*)$/s.exec(full);
  if (!m) throw new PyValueError(`unknown url type: ${pyRepr(fragment ? `${full}#${fragment}` : full)}`);
  const type = m[1].toLowerCase();
  const rest = m[2];
  const h = /^\/\/([^/#?]*)(.*)$/s.exec(rest);
  let host = null, selector = rest;
  if (h) {
    [, host, selector] = h;
    if (selector && selector[0] !== '/') selector = '/' + selector;
    if (host) host = unquote(host);
  }
  // Request.__init__ computes origin_req_host with urlparse(full_url): malformed bracketed hosts are a ValueError here.
  urlparse(fragment ? `${full}#${fragment}` : full);
  return { type, host, selector, full, fragment };
}

/** HTTPConnection._get_hostport(host, None): [host, port], InvalidURL for a nonnumeric port. */
export function getHostport(hostText, defaultPort) {
  let host = hostText, port = defaultPort;
  const i = host.lastIndexOf(':'), j = host.lastIndexOf(']');
  if (i > j) {
    const text = host.slice(i + 1);
    const n = pyInt(text);
    if (n !== null) port = Number(n);
    else if (text !== '') throw new InvalidURL(`nonnumeric port: '${text}'`);
    host = host.slice(0, i);
  }
  if (host && host[0] === '[' && host[host.length - 1] === ']') host = host.slice(1, -1);
  return [host, port];
}

const DISALLOWED_URL_CHARS = /[\x00-\x20\x7f]/;
export function validateNoControl(text) {
  const match = DISALLOWED_URL_CHARS.exec(text);
  if (match) throw new InvalidURL(`URL can't contain control characters. ${pyRepr(text)} (found at least ${pyRepr(match[0])})`);
}

const escapeChar = (cp) => (cp < 0x100 ? `\\x${cp.toString(16).padStart(2, '0')}`
  : cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\U${cp.toString(16).padStart(8, '0')}`);

/** request.encode('ascii'): UnicodeEncodeError text of CPython for the first run of non-ASCII characters. */
function encodeAscii(text) {
  const chars = Array.from(text);
  const start = chars.findIndex((c) => c.codePointAt(0) > 127);
  if (start < 0) return;
  let end = start + 1;
  while (end < chars.length && chars[end].codePointAt(0) > 127) end++;
  throw new UnicodeEncodeError(end - start === 1
    ? `'ascii' codec can't encode character '${escapeChar(chars[start].codePointAt(0))}' in position ${start}: ordinal not in range(128)`
    : `'ascii' codec can't encode characters in position ${start}-${end - 1}: ordinal not in range(128)`);
}

/** HTTPConnection.putrequest's request-line checks (before anything is sent). */
export function validateRequestLine(method, selector) {
  const url = selector || '/';
  validateNoControl(url);
  encodeAscii(`${method} ${url} HTTP/1.1`);
}

// ---------------------------------------------------------------- CA handling
/** The PEM certificates of a file, or [] when it is unreadable. */
function pemFile(file) {
  try { return fs.readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []; } catch { return []; }
}

/**
 * OpenSSL 3's by-subject-hash directory lookup (measured against CPython 3.12.10 / OpenSSL 3.0.16): a file named
 * `<subject hash>.<digits>` or `<subject hash>.r<digits>` is read and its certificates count when their own subject
 * hash is that name's hash. Any number is accepted (no `.0` start, no gaps); other names are ignored.
 */
function hashedDirectoryCertificates(dir) {
  let names;
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^([0-9a-f]{8})\.r?[0-9]+$/.exec(name);
    if (!m) continue;
    for (const pem of pemFile(path.join(dir, name))) {
      try { if (subjectHash(pem) === m[1]) out.push(pem); } catch { /* not a certificate Node can read */ }
    }
  }
  return out;
}

/**
 * Trust anchors the way OpenSSL's default verify paths read them: SSL_CERT_FILE (a bundle) replaces the default
 * bundle, SSL_CERT_DIR adds the certificates of "<subject hash>.<n>" files in each listed directory. Without SSL_CERT_FILE
 * the default roots are Node's bundled roots plus the OS store when Node exposes it. Verification stays mandatory.
 */
export function caList(env = process.env) {
  const file = env.SSL_CERT_FILE;
  let list;
  if (file) {
    try { list = [fs.readFileSync(file, 'utf8')]; } catch { list = []; } // unreadable: nothing, like OpenSSL
  } else {
    list = [...tls.rootCertificates];
    try {
      if (typeof tls.getCACertificates === 'function') list.push(...tls.getCACertificates('system'));
    } catch { /* no system store exposed */ }
  }
  const dirs = env.SSL_CERT_DIR;
  if (dirs) {
    for (const dir of dirs.split(path.delimiter)) {
      if (dir) list.push(...hashedDirectoryCertificates(dir));
    }
  }
  return list;
}

// ---------------------------------------------------------------- connection and response reading
class Reader {
  constructor(socket, timeoutMs) {
    this.socket = socket; this.queue = []; this.size = 0; this.ended = false; this.error = null; this.wake = null;
    socket.on('data', (chunk) => { this.queue.push(chunk); this.size += chunk.length; if (this.size > (4 << 20)) socket.pause(); this.signal(); });
    socket.on('end', () => { this.ended = true; this.signal(); });
    socket.on('close', () => { this.ended = true; this.signal(); });
    socket.on('error', (err) => { this.error = this.error ?? err; this.signal(); });
    if (timeoutMs) {
      socket.setTimeout(timeoutMs, () => { this.error = this.error ?? new PyTimeoutError(socket instanceof tls.TLSSocket ? 'The read operation timed out' : undefined); this.signal(); socket.destroy(); });
    }
  }
  signal() { const w = this.wake; this.wake = null; if (w) w(); }
  async fill() {
    if (this.queue.length) return true;
    if (this.error) throw this.error;
    if (this.ended) return false;
    await new Promise((resolve) => { this.wake = resolve; });
    if (this.queue.length) return true;
    if (this.error) throw this.error;
    return !this.ended ? this.fill() : false;
  }
  take(max) {
    if (!this.queue.length) return Buffer.alloc(0);
    let first = this.queue[0];
    if (first.length > max) {
      this.queue[0] = first.subarray(max); first = first.subarray(0, max);
    } else this.queue.shift();
    this.size -= first.length;
    if (this.size < (1 << 20) && this.socket.isPaused()) this.socket.resume();
    return first;
  }
  unshift(buf) { if (buf.length) { this.queue.unshift(buf); this.size += buf.length; } }
  /** Everything up to the end of the stream (BufferedReader.read()). */
  async readAll() { return this.read(Infinity); }
  /** Read up to n bytes, waiting until n are available or EOF (BufferedReader.read(n)). */
  async read(n) {
    const parts = []; let got = 0;
    while (got < n) {
      if (!(await this.fill())) break;
      const part = this.take(n - got);
      parts.push(part); got += part.length;
    }
    return Buffer.concat(parts);
  }
  async readLine(limit = 65537) {
    const parts = []; let len = 0;
    for (;;) {
      if (!(await this.fill())) return Buffer.concat(parts);
      const chunk = this.take(limit - len);
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) {
        this.unshift(chunk.subarray(nl + 1));
        parts.push(chunk.subarray(0, nl + 1));
        return Buffer.concat(parts);
      }
      parts.push(chunk); len += chunk.length;
      if (len >= limit) return Buffer.concat(parts);
    }
  }
  destroy() { this.socket.destroy(); }
}

// ---------------------------------------------------------------- http.client: headers, status line, body framing
export class Headers {
  constructor(pairs) { this.pairs = pairs; }
  /** email.message.Message.get: the first header of that name, case-insensitively; the value exactly as parsed. */
  get(name) {
    const lower = name.toLowerCase();
    const hit = this.pairs.find(([k]) => k.toLowerCase() === lower);
    return hit ? hit[1] : null;
  }
  getAll(name) { const lower = name.toLowerCase(); return this.pairs.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v); }
}

const MAX_LINE = 65536; // http.client._MAXLINE
const MAX_HEADERS = 100; // http.client._MAXHEADERS

/** http.client.LineTooLong */
const lineTooLong = (what) => new HTTPException(`got more than ${MAX_LINE} bytes when reading ${what}`, 'LineTooLong');

/** http.client._read_headers: raw lines (the blank line included) with CPython's limits. */
async function readHeaderLines(reader) {
  const lines = [];
  for (;;) {
    const line = await reader.readLine(MAX_LINE + 1);
    if (line.length > MAX_LINE) throw lineTooLong('header line');
    lines.push(line);
    if (lines.length > MAX_HEADERS) throw new HTTPException(`got more than ${MAX_HEADERS} headers`);
    const text = line.toString('latin1');
    if (text === '\r\n' || text === '\n' || text === '') break;
  }
  return lines;
}

// email.feedparser.headerRE and NLCRE: a header line, a continuation (space/tab) or an envelope "From " line.
const EMAIL_HEADER_LINE = /^(From |[\x21-\x39\x3b-\x7e]*:|[\t ])/;

/** The lines of text with their terminators (\r\n, \r or \n), like BufferedSubFile. */
const emailLines = (text) => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g) ?? [];

/**
 * http.client.parse_headers: email.parser.Parser().parsestr over the raw header lines with the compat32 policy.
 * Values keep trailing white space and folded continuation lines (with their own line ends); only the final
 * "\r\n" characters are removed and leading blanks after the colon dropped. Returns a Headers.
 */
export function parseHeaderLines(lines) {
  const headers = [];
  for (const line of emailLines(lines.map((l) => l.toString('latin1')).join(''))) {
    if (!EMAIL_HEADER_LINE.test(line)) break; // the blank separator, or a line that starts the "body"
    headers.push(line);
  }
  const pairs = [];
  let lastHeader = '';
  let lastValue = [];
  const flush = () => {
    const first = lastValue[0];
    const colon = first.indexOf(':');
    const value = first.slice(colon + 1).replace(/^[ \t]+/, '') + lastValue.slice(1).join('');
    pairs.push([first.slice(0, colon), value.replace(/[\r\n]+$/, '')]);
  };
  headers.forEach((line) => {
    if (line[0] === ' ' || line[0] === '\t') { // continuation
      if (lastHeader) lastValue.push(line);
      return;
    }
    if (lastHeader) { flush(); lastHeader = ''; lastValue = []; }
    if (line.startsWith('From ')) return; // an envelope header: dropped wherever it is
    const colon = line.indexOf(':');
    if (colon === 0) return; // "Missing header name": ignored
    lastHeader = line.slice(0, colon);
    lastValue = [line];
  });
  if (lastHeader) flush();
  return new Headers(pairs);
}

/** http.client.HTTPResponse._read_status: [version, status, reason]. */
async function readStatus(reader) {
  const raw = await reader.readLine(MAX_LINE + 1);
  const line = raw.toString('latin1');
  if (raw.length > MAX_LINE) throw lineTooLong('status line');
  if (!line) throw new RemoteDisconnected();
  let version, status, reason;
  const three = pySplit(line, 2);
  if (three.length === 3) [version, status, reason] = three;
  else {
    const two = pySplit(line, 1);
    if (two.length === 2) { [version, status] = two; reason = ''; } else version = '';
  }
  if (!version.startsWith('HTTP/')) {
    reader.destroy();
    throw new HTTPException(line, 'BadStatusLine');
  }
  const code = pyInt(status ?? '');
  if (code === null || code < 100n || code > 999n) throw new HTTPException(line, 'BadStatusLine');
  return [version, Number(code), reason ?? ''];
}

/** http.client.HTTPResponse.begin: status, the 100-continue loop, headers. */
async function readHead(reader, method, url) {
  let version, status, reason;
  for (;;) {
    [version, status, reason] = await readStatus(reader);
    if (status !== 100) break;
    await readHeaderLines(reader); // skip the headers of the 100 response
  }
  if (!(version === 'HTTP/1.0' || version === 'HTTP/0.9' || version.startsWith('HTTP/1.'))) {
    throw new HTTPException(version, 'UnknownProtocol');
  }
  const headers = parseHeaderLines(await readHeaderLines(reader));
  return { version: version === 'HTTP/1.0' || version === 'HTTP/0.9' ? 10 : 11, status, reason: pyStrip(reason), headers, url, method };
}

const NO_BYTES = Buffer.alloc(0);

/** The state and read paths of http.client.HTTPResponse that urllib uses (read(amt) of a plain or chunked body). */
export class Response {
  constructor(reader, { status, reason, headers, url, method, version }) {
    this.reader = reader; this.status = status; this.reason = reason; this.headers = headers; this.url = url; this.method = method;
    const te = headers.get('transfer-encoding');
    this.chunked = Boolean(te) && te.toLowerCase() === 'chunked';
    this.chunkLeft = null;
    let length = null;
    const header = headers.get('content-length');
    if (header && !this.chunked) { // int(length): ValueError and negative values mean "unknown"
      const n = pyInt(header);
      if (n !== null && n >= 0n) length = Number(n);
    }
    if (status === 204 || status === 304 || (status >= 100 && status < 200) || method === 'HEAD') length = 0;
    this.length = length;
    this.done = false; // fp is None
    this.willClose = true; this.version = version;
  }

  /** HTTPResponse.read(amt) */
  async read(amt) {
    if (this.done) return NO_BYTES;
    if (this.method === 'HEAD') { this.finish(); return NO_BYTES; }
    if (this.chunked) return this.readChunked(amt);
    if (amt !== undefined && amt !== null && amt >= 0) {
      if (this.length !== null && amt > this.length) amt = this.length; // clip the read to the end of the response
      const s = await this.reader.read(amt);
      if (s.length === 0 && amt) this.finish(); // a short Content-Length body simply ends (CPython does not raise)
      else if (this.length !== null) {
        this.length -= s.length;
        if (!this.length) this.finish();
      }
      return s;
    }
    // unbounded read
    let s;
    if (this.length === null) s = await this.reader.readAll();
    else {
      try { s = await this.safeRead(this.length); } catch (err) { this.finish(); throw err; }
      this.length = 0;
    }
    this.finish();
    return s;
  }

  /** HTTPResponse._safe_read: IncompleteRead when the data is short (fp.read(-1) reads to the end, other negatives raise). */
  async safeRead(amt) {
    if (amt < -1) throw new PyValueError('read length must be non-negative or -1');
    const data = await this.reader.read(amt === -1 ? Infinity : amt);
    if (data.length < amt) throw new IncompleteRead(data.length, amt - data.length);
    return data;
  }

  /** HTTPResponse._read_next_chunk_size: the size, or null (ValueError after closing the connection). */
  async readNextChunkSize() {
    const raw = await this.reader.readLine(MAX_LINE + 1);
    if (raw.length > MAX_LINE) throw lineTooLong('chunk size');
    let line = raw;
    const semicolon = line.indexOf(0x3b);
    if (semicolon >= 0) line = line.subarray(0, semicolon); // strip chunk extensions
    const size = pyInt(line.toString('latin1'), 16);
    if (size === null) { this.finish(); return null; }
    return Number(size);
  }

  /** HTTPResponse._read_and_discard_trailer */
  async readAndDiscardTrailer() {
    for (;;) {
      const raw = await this.reader.readLine(MAX_LINE + 1);
      if (raw.length > MAX_LINE) throw lineTooLong('trailer line');
      if (raw.length === 0) break; // a few sites EOF without sending the trailer
      const text = raw.toString('latin1');
      if (text === '\r\n' || text === '\n') break;
    }
  }

  /** HTTPResponse._get_chunk_left: the bytes left in the current chunk, null after the last chunk. */
  async getChunkLeft() {
    let chunkLeft = this.chunkLeft;
    if (!chunkLeft) { // 0 or None
      if (chunkLeft !== null) await this.safeRead(2); // toss the CRLF at the end of the chunk
      chunkLeft = await this.readNextChunkSize();
      if (chunkLeft === null) throw new IncompleteRead(0);
      if (chunkLeft === 0) {
        await this.readAndDiscardTrailer();
        this.finish(); // everything read
        chunkLeft = null;
      }
      this.chunkLeft = chunkLeft;
    }
    return chunkLeft;
  }

  /** HTTPResponse._read_chunked(amt) */
  async readChunked(amt) {
    if (amt !== undefined && amt !== null && amt < 0) amt = undefined;
    if (amt === null) amt = undefined;
    const value = [];
    let got = 0;
    try {
      for (let chunkLeft; (chunkLeft = await this.getChunkLeft()) !== null;) {
        if (amt !== undefined && amt <= chunkLeft) {
          const data = await this.safeRead(amt);
          value.push(data); got += data.length;
          this.chunkLeft = chunkLeft - amt;
          break;
        }
        const data = await this.safeRead(chunkLeft);
        value.push(data); got += data.length;
        if (amt !== undefined) amt -= chunkLeft;
        this.chunkLeft = 0;
      }
      return Buffer.concat(value);
    } catch (err) {
      if (err instanceof IncompleteRead) throw new IncompleteRead(got); // the partial data of the failing piece is dropped
      throw err;
    }
  }

  finish() { this.done = true; this.reader.destroy(); }
  close() { this.done = true; this.reader.destroy(); }
}

function connectTcp(host, port, timeoutMs, live) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    live?.add(socket);
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; socket.setTimeout(0); fn(v); } };
    if (timeoutMs) socket.setTimeout(timeoutMs, () => { socket.destroy(); done(reject, new PyTimeoutError()); });
    socket.once('connect', () => done(resolve, socket));
    socket.once('error', (err) => done(reject, err));
  });
}

function withoutTlsEnvironment(fn) {
  const name = 'NODE_TLS_REJECT_UNAUTHORIZED';
  const had = Object.hasOwn(process.env, name);
  const value = process.env[name];
  delete process.env[name];
  try { return fn(); } finally { if (had) process.env[name] = value; }
}

function tlsUpgrade(socket, host, timeoutMs, env, ca, live) {
  return new Promise((resolve, reject) => {
    // tls.connect() reads NODE_TLS_REJECT_UNAUTHORIZED itself and prints a warning when it is "0", although the
    // explicit rejectUnauthorized below always wins. The variable (restored by the launch shim) is hidden for the
    // duration of the call so LCU's own, still verified, requests stay silent.
    const secure = withoutTlsEnvironment(() => tls.connect({
      socket, servername: net.isIP(host) ? undefined : host, ca: ca ?? caList(env), rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'], host,
    }));
    live?.add(secure);
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; secure.setTimeout(0); fn(v); } };
    if (timeoutMs) secure.setTimeout(timeoutMs, () => { secure.destroy(); done(reject, new PyTimeoutError('_ssl.c:1000: The handshake operation timed out')); });
    secure.once('secureConnect', () => done(resolve, secure));
    secure.once('error', (err) => done(reject, err));
  });
}

const sendAll = (socket, data) => new Promise((resolve, reject) => socket.write(data, (err) => (err ? reject(err) : resolve())));

/**
 * One request/response exchange without redirect handling.
 * Errors raised before the response head is read are URLError (urllib wraps OSError from h.request()).
 */
async function exchange(parsed, { method, headers, timeoutMs, env, ca, systemProxy, live }) {
  const secure = parsed.type === 'https';
  const defaultPort = secure ? 443 : 80;
  const proxy = selectProxy(parsed.type, parsed.host, env, systemProxy ? { systemProxy } : {});
  // A plain-http target reaches the proxy through the handler of the proxy URL's scheme: https:// means TLS to the
  // proxy (default port 443), any other non-http scheme is "unknown url type". An https target always tunnels.
  let proxyTls = false;
  if (proxy && !secure) {
    const type = proxy.type ?? 'http';
    if (type === 'https') proxyTls = true;
    else if (type !== 'http') throw new URLError(`unknown url type: ${type}`);
  }
  // urllib builds HTTPConnection(host) (port and host checks), http.client.set_tunnel (tunnel port check) and
  // putrequest (request-line checks) before anything is connected or sent; these errors are not URLErrors.
  const [connectHost, connectPort] = getHostport(proxy ? proxy.hostport : parsed.host, secure || proxyTls ? 443 : 80);
  validateNoControl(connectHost);
  const [targetHost, targetPort] = proxy && secure ? getHostport(parsed.host, defaultPort) : [connectHost, connectPort];
  const fullUrl = parsed.fragment ? `${parsed.full}#${parsed.fragment}` : parsed.full;
  let socket, selector = proxy && !secure ? fullUrl : parsed.selector || '/';
  validateRequestLine(method, selector);
  try {
    if (proxy) {
      socket = await connectTcp(connectHost, connectPort, timeoutMs, live);
      if (proxyTls) socket = await tlsUpgrade(socket, connectHost, timeoutMs, env, ca, live);
      if (secure) {
        const hostText = `${targetHost.includes(':') ? `[${targetHost}]` : targetHost}:${targetPort}`;
        // http.client._tunnel writes the tunnel headers (Proxy-Authorization) before Host.
        let connect = `CONNECT ${hostText} HTTP/1.1\r\n`;
        if (proxy.authorization) connect += `Proxy-Authorization: ${proxy.authorization}\r\n`;
        await sendAll(socket, connect + `Host: ${hostText}\r\n\r\n`);
        const tunnelReader = new Reader(socket, timeoutMs);
        const head = await readTunnel(tunnelReader);
        if (head.status !== 200) {
          socket.destroy();
          throw new PlainOSError(`Tunnel connection failed: ${head.status} ${head.reason}`);
        }
        socket.removeAllListeners('data'); socket.removeAllListeners('end'); socket.removeAllListeners('close'); socket.removeAllListeners('error');
        socket.setTimeout(0);
        const leftover = Buffer.concat(tunnelReader.queue);
        if (leftover.length) socket.unshift(leftover);
        socket = await tlsUpgrade(socket, targetHost, timeoutMs, env, ca, live);
      }
    } else {
      socket = await connectTcp(targetHost, targetPort, timeoutMs, live);
      if (secure) socket = await tlsUpgrade(socket, targetHost, timeoutMs, env, ca, live);
    }
    // Header order matches http.client: Accept-Encoding (putrequest) first, then Host, then the request headers.
    let text = `${method} ${selector} HTTP/1.1\r\nAccept-Encoding: identity\r\nHost: ${parsed.host}\r\n`;
    for (const [k, v] of Object.entries(headers)) text += `${titleCase(k)}: ${v}\r\n`;
    if (proxy && !secure && proxy.authorization) text += `Proxy-Authorization: ${proxy.authorization}\r\n`;
    text += 'Connection: close\r\n\r\n';
    await sendAll(socket, text);
  } catch (err) {
    if (socket) socket.destroy();
    throw new URLError(mapNodeError(err, parsed.host && getHostport(parsed.host, 0)[0]));
  }
  const reader = new Reader(socket, timeoutMs);
  try {
    const head = await readHead(reader, method, parsed.full);
    return new Response(reader, head);
  } catch (err) {
    reader.destroy();
    throw mapNodeError(err, targetHost);
  }
}

async function readTunnel(reader) {
  try {
    const status = (await reader.readLine()).toString('latin1');
    const m = /^HTTP\/\S+\s+(\d+)\s*(.*?)\r?\n?$/.exec(status);
    for (;;) {
      const h = (await reader.readLine()).toString('latin1');
      if (h === '\r\n' || h === '\n' || h === '') break;
    }
    if (!m) return { status: 0, reason: status.trim() };
    return { status: Number(m[1]), reason: m[2] };
  } catch (err) { throw mapNodeError(err); }
}

const titleCase = (name) => name.toLowerCase().replace(/(^|[^a-zA-Z0-9])([a-z])/g, (_, a, b) => a + b.toUpperCase());

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const INF_MSG = 'The HTTP server returned a redirect error that would lead to an infinite loop.\n'
  + 'The last 30x error message was:\n';

/**
 * urllib.request.urlopen / build_opener(_NoRedirect).open.
 * Returns a Response for 2xx; throws HTTPError for other statuses (a 3xx when followRedirects is false).
 */
export async function urlopen(url, { method = 'GET', headers = { 'User-Agent': USER_AGENT }, timeout = DOWNLOAD_TIMEOUT,
  followRedirects = true, env = process.env, ca, systemProxy, refuseDowngrade = false, signal } = {}) {
  // `signal` (AbortSignal): aborting destroys every socket of this request at once (connecting, tunnelling, TLS, or
  // streaming the body) and the call, or the pending read of the returned Response, rejects with signal.reason.
  throwIfAborted(signal);
  const live = new Set();
  const onAbort = () => { for (const socket of live) socket.destroy(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  try {
    const response = await urlopenFollowing(url, { method, headers, timeout, followRedirects, env, ca, systemProxy, refuseDowngrade, live });
    if (signal) {
      const close = response.close.bind(response);
      response.close = () => { cleanup(); close(); };
    }
    return response;
  } catch (err) {
    cleanup();
    throwIfAborted(signal);
    throw err;
  }
}

/** The reason an aborted request fails with (the signal's own reason, an AbortError by default). */
export const abortReason = (signal) => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
export function throwIfAborted(signal) { if (signal?.aborted) throw abortReason(signal); }

async function urlopenFollowing(url, { method, headers, timeout, followRedirects, env, ca, systemProxy, refuseDowngrade, live }) {
  let parsed = parseUrl(url);
  if (parsed.type !== 'http' && parsed.type !== 'https') throw new URLError(`unknown url type: ${parsed.type}`);
  const visited = new Map();
  let currentUrl = parsed.full;
  for (;;) {
    if (parsed.host === null || parsed.host === '') throw new URLError('no host given'); // do_request_, every hop
    const response = await exchange(parsed, { method, headers, timeoutMs: timeout * 1000, env, ca, systemProxy, live });
    const code = response.status;
    if (code >= 200 && code < 300) return response;
    response.close();
    if (!REDIRECT_CODES.has(code)) throw new HTTPError(currentUrl, code, response.reason, response.headers);
    const location = response.headers.get('location') ?? response.headers.get('uri');
    if (location === null) throw new HTTPError(currentUrl, code, response.reason, response.headers);
    // HTTPRedirectHandler.http_error_302 parses, checks and re-quotes the Location before redirect_request() may
    // decline it (the no-redirect opener of latest_tag), so its ValueErrors and the scheme check apply either way.
    const target = redirectUrl(currentUrl, location);
    if (target.notAllowed) {
      throw new HTTPError(location, code, `${response.reason} - Redirection to url '${location}' is not allowed`, response.headers);
    }
    const next = target.url;
    // Only GET/HEAD are redirected (redirect_request returns None otherwise).
    if (!followRedirects || !['GET', 'HEAD'].includes(method)) {
      throw new HTTPError(currentUrl, code, response.reason, response.headers);
    }
    const nextParsed = parseUrl(next); // Request(newurl): its ValueErrors precede the loop detection
    if ((visited.get(next) ?? 0) >= 4 || visited.size >= 10) {
      throw new HTTPError(currentUrl, code, INF_MSG + response.reason, response.headers);
    }
    visited.set(next, (visited.get(next) ?? 0) + 1);
    if (nextParsed.type !== 'http' && nextParsed.type !== 'https') throw new URLError(`unknown url type: ${nextParsed.type}`);
    // Security hardening (not in urllib): a release download must not leave HTTPS. The checksum fetched over the same
    // redirect capability is not an authenticity boundary on a plaintext hop (curl's fallback has --proto =https).
    if (refuseDowngrade && parsed.type === 'https' && nextParsed.type !== 'https') {
      throw new URLError(`redirect from https to ${nextParsed.type} refused: ${next}`);
    }
    currentUrl = next;
    parsed = nextParsed;
  }
}

// ---------------------------------------------------------------- curl fallback
/** shutil.which for an executable name, searching PATH of `env`. */
export function which(name, env = process.env) {
  const dirs = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir || '.', name);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The argv update.curl builds, with `-q` first (security hardening, not in Python's argv): curl then reads no
 * ~/.curlrc, so a curl configuration file cannot disable certificate verification, add a proxy or change the CA.
 */
export const curlArgv = (command, args, timeout = UPDATE_TIMEOUT) => [command, '-q', '-fsS', '--proto', '=https', '--max-time', String(timeout), ...args];

/** update.curl: run the system curl, return stdout bytes; OSError(stderr or "curl exited N") on failure. */
export function curl(args, { timeout = UPDATE_TIMEOUT, env = process.env } = {}) {
  const command = which('curl', env);
  if (command === null) throw new PlainOSError(CURL_MISSING_MESSAGE);
  const argv = curlArgv(command, args, timeout);
  const result = spawnSync(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], timeout: (timeout + 5) * 1000, killSignal: 'SIGKILL', env, maxBuffer: 1 << 30 });
  if (result.error && result.error.code === 'ETIMEDOUT') throw new TimeoutExpired(argv, timeout + 5);
  if (result.error) throw new PlainOSError(result.error.message);
  if (result.status !== 0) {
    const text = result.stderr.toString('utf8').trim();
    throw new PlainOSError(text || `curl exited ${result.status}`);
  }
  return result.stdout;
}

// ---------------------------------------------------------------- update.py operations
/** update.latest_tag */
export async function latestTag({ latestUrl = LATEST_URL, env = process.env, timeout = UPDATE_TIMEOUT, ca, systemProxy, signal } = {}) {
  let location;
  try {
    const response = await urlopen(latestUrl, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, timeout, followRedirects: false, env, ca, systemProxy, signal });
    try { location = response.headers.get('location'); } finally { response.close(); }
  } catch (err) {
    throwIfAborted(signal);
    if (err instanceof HTTPError) {
      location = REDIRECT_CODES.has(err.code) ? err.headers.get('location') : null;
      if (location === null) throw err;
    } else if (err instanceof URLError) {
      if (!certFailure(err)) throw err;
      // bytes.decode() is strict (UnicodeDecodeError, a ValueError); str.strip() strips Unicode white space
      location = pyStrip(utf8Decode(curl(['-I', '-o', os_devnull(), '-w', '%{redirect_url}', latestUrl], { env })));
    } else throw err;
  }
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(location ?? '');
  if (!match) throw new PyValueError('Unexpected response while looking for the latest LCU release.');
  return match[1];
}

const os_devnull = () => (process.platform === 'win32' ? 'nul' : '/dev/null');

/** `template % (a, b)` for printf templates made of %s and %% (update.NOTES_URL); never a replacement pattern. */
function percentFormat(template, ...args) {
  let used = 0;
  const out = template.replace(/%(.|$)/gs, (m, c) => {
    if (c === '%') return '%';
    if (c === 's') {
      if (used >= args.length) throw new TypeError('not enough arguments for format string');
      return args[used++];
    }
    throw new PyValueError(c === '' ? 'incomplete format' : `unsupported format character ${pyRepr(c)} (0x${c.codePointAt(0).toString(16)}) at index 0`);
  });
  if (used < args.length) throw new TypeError('not all arguments converted during string formatting');
  return out;
}

// re.search(r'^[ \t]*<!--\s*lcu-severity:\s*(\w+)\s*-->[ \t]*$', text, re.MULTILINE) with Python's classes: \s is
// Unicode white space (including U+001C-U+001F and U+0085, not U+FEFF), \w Unicode letters/digits/underscore, and `$`
// matches only before "\n" (a "\r" ahead of it is not white space for [ \t]).
const PY_WHITESPACE = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const SEVERITY_MARKER = new RegExp(
  `(?:^|(?<=\\n))[ \\t]*<!--${PY_WHITESPACE}*lcu-severity:${PY_WHITESPACE}*([\\p{L}\\p{N}_]+)${PY_WHITESPACE}*-->[ \\t]*(?=\\n|$)`, 'u');

/** update.severity_of */
export async function severityOf(tag, version, { notesTemplate, env = process.env, timeout = UPDATE_TIMEOUT, ca, systemProxy, signal } = {}) {
  // notesTemplate: a printf-style template with two %s (tag, version), like update.NOTES_URL.
  const url = notesTemplate ? percentFormat(notesTemplate, tag, version) : NOTES_URL(tag, version);
  let text;
  try {
    try {
      const response = await urlopen(url, { headers: { 'User-Agent': USER_AGENT }, timeout, followRedirects: false, env, ca, systemProxy, signal });
      try { text = (await response.read(262144)).toString('utf8'); throwIfAborted(signal); } finally { response.close(); }
    } catch (err) {
      throwIfAborted(signal);
      if (!(err instanceof URLError) || !certFailure(err)) throw err;
      text = curl([url], { env }).toString('utf8');
    }
  } catch (err) {
    throwIfAborted(signal);
    if (caughtByUpdate(err)) return 'normal';
    throw err;
  }
  const match = SEVERITY_MARKER.exec(text);
  return match && SEVERITIES.includes(match[1]) ? match[1] : 'normal';
}

/** update.parse_version: a tuple of ints (Number, BigInt beyond 2^53) or null. */
export function parseVersion(text) {
  const s = pyStrip(String(text));
  if (!s) return null;
  const parts = [];
  for (const part of s.replace(/^v+/, '').split('.')) {
    const n = pyInt(part);
    if (n === null) return null;
    parts.push(Number.isSafeInteger(Number(n)) ? Number(n) : n);
  }
  return parts;
}

/** update.fetch_latest */
export async function fetchLatest(options = {}) {
  const tag = await latestTag(options);
  const version = tag[0] === 'v' ? tag.slice(1) : tag;
  if (parseVersion(version) === null) throw new PyValueError(`Unrecognized release tag: ${tag}`);
  return { version, tag, release_url: RELEASE_URL + tag, severity: await severityOf(tag, version, options) };
}

// ---------------------------------------------------------------- update_apply._fetch
function intOrThrow(text) {
  const n = pyInt(text);
  if (n === null) throw new PyValueError(`invalid literal for int() with base 10: ${pyRepr(text)}`);
  return Number(n);
}

export { sha256File };

/**
 * update_apply._fetch(url) without a destination: at most the first 64 KiB of the body, curl fallback on
 * certificate failures. Returns a Buffer. The response is closed on every path (`with urlopen(...)`).
 */
export async function fetchBytes(url, { env = process.env, ca, timeout = DOWNLOAD_TIMEOUT, systemProxy, signal } = {}) {
  try {
    const response = await urlopen(url, { headers: { 'User-Agent': USER_AGENT }, timeout, env, ca, systemProxy, refuseDowngrade: true, signal });
    try { const data = await response.read(1 << 16); throwIfAborted(signal); return data; } finally { response.close(); }
  } catch (err) {
    throwIfAborted(signal);
    if (!(err instanceof URLError) || !certFailure(err)) throw err;
  }
  return curl(['-L', url], { env }).subarray(0, 1 << 16);
}

/**
 * update_apply._fetch(url, destination): stream the body to `destination` (overwritten) and return the lowercase
 * sha256 hex digest. Progress goes to `progress(text)` (default: `stderr.write`) as "\rDownloading N%" only when
 * `stderr.isTTY` and Content-Length is known; the final line break is "\r\n" when `platform` is win32 (Python's
 * Windows stderr translates "\n"). Every byte hashed is written (short writes are completed).
 */
export async function fetchToFile(url, destination, { env = process.env, ca, stderr = process.stderr, progress = null,
  platform = process.platform, timeout = DOWNLOAD_TIMEOUT, systemProxy, signal } = {}) {
  try {
    return await fetchUrllib(url, destination, { env, ca, stderr, progress, platform, timeout, systemProxy, signal });
  } catch (err) {
    throwIfAborted(signal);
    if (!(err instanceof URLError) || !certFailure(err)) throw err;
  }
  curl(['-L', '-o', String(destination), url], { timeout: timeout * 30, env });
  return sha256File(destination);
}

async function fetchUrllib(url, destination, { env, ca, stderr, progress, platform, timeout, systemProxy, signal }) {
  const response = await urlopen(url, { headers: { 'User-Agent': USER_AGENT }, timeout, env, ca, systemProxy, refuseDowngrade: true, signal });
  const emit = progress ?? ((text) => stderr.write(text));
  try { // `with urlopen(request) as response:`: the response is closed whatever fails below
    const hash = crypto.createHash('sha256');
    const header = response.headers.get('content-length');
    const total = header ? intOrThrow(header) : 0;
    let done = 0;
    let fd;
    try { fd = fs.openSync(destination, 'w'); } catch (err) { throw toPyOSError(err, String(destination)); }
    try {
      for (;;) {
        const chunk = await response.read(1 << 20);
        throwIfAborted(signal); // a destroyed socket reads as end of stream
        if (chunk.length === 0) break;
        hash.update(chunk);
        writeAll(fd, chunk);
        done += chunk.length;
        if (total && stderr.isTTY) emit(`\rDownloading ${Math.floor((done * 100) / total)}%`);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && stderr.isTTY) emit(platform === 'win32' ? '\r\n' : '\n');
    return hash.digest('hex');
  } finally {
    response.close();
  }
}
