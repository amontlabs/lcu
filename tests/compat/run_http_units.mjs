// Calls exported functions of lcu/compat/http.mjs (and the helper modules) for test_http.py: node run_http_units.mjs <spec.json>
// spec: [{id, fn, args}] -> {id: {ok: true, value} | {ok: false, name, message}}.
import fs from 'node:fs';
import * as http from '../../lcu/compat/http.mjs';
import { subjectHash } from '../../lcu/compat/openssl_hash.mjs';

const registryMap = (values) => new Map(Object.entries(values).map(([name, value]) => [name,
  typeof value === 'number' ? { type: 'REG_DWORD', data: `0x${value.toString(16)}` } : { type: 'REG_SZ', data: String(value) }]));

const fns = {
  getEnvProxies: (env) => http.getEnvProxies(env),
  proxyBypassMacosx: (host, settings) => http.proxyBypassMacosx(host, settings),
  proxyBypassEnvironment: (host, env) => http.proxyBypassEnvironment(host, http.getEnvProxies(env)),
  fnmatch: (name, pattern) => http.fnmatch(name, pattern),
  parseUrl: (url) => {
    const p = http.parseUrl(url);
    return { type: p.type, host: p.host, selector: p.selector, full: p.full, fragment: p.fragment };
  },
  urljoin: (base, url) => http.urljoin(base, url),
  urlparse: (url, scheme = '') => {
    const p = http.urlparse(url, scheme);
    return [p.scheme, p.netloc, p.path, p.params, p.query, p.fragment];
  },
  unquote: (text) => http.unquote(text),
  getHostport: (host, port) => http.getHostport(host, port),
  validateRequestLine: (method, selector) => { http.validateRequestLine(method, selector); return null; },
  validateNoControl: (host) => { http.validateNoControl(host); return null; },
  parseScutilProxy: (text) => http.parseScutilProxy(text),
  macosSystemProxy: () => http.macosSystemProxy(),
  subjectHash: (pem) => subjectHash(pem),
  curlArgv: (command, args, timeout) => http.curlArgv(command, args, timeout),
  caList: (env) => http.caList(env).length,
  registryProxies: (values) => http.getProxiesRegistry(registryMap(values)),
  proxyBypassWinreg: (host, override, normcase) => http.proxyBypassWinreg(host, override, { normcase }),
  parseRegQuery: (text) => Object.fromEntries(http.parseRegQuery(text)),
  registrySettings: (text) => http.registrySettings(http.parseRegQuery(text)),
};

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const { id, fn, args } of spec) {
  try {
    out[id] = { ok: true, value: fns[fn](...args) };
  } catch (err) {
    out[id] = { ok: false, name: err.name, message: String(err.message) };
  }
}
process.stdout.write(JSON.stringify(out));
