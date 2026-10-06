// Report whether the selected app and CUA runtime are a pair LCU's own tests covered.
// Port of lcu/tested.py.
//
// App versions are date stamps and the CUA runtime is 0.0.x, so neither version
// signals compatibility. `tested-versions.json` lists the exact pairs the checked-in
// verification records prove. An untested pair produces a warning and nothing else:
// LCU never refuses an app because its version is not listed.
//
// Data model: the record is parsed with compat/pyjson (dict -> Map, int -> BigInt) so Python's isinstance
// checks keep their meaning; the entries load_entries returns are converted to plain objects.
// Keyword-only Python parameters (platform, architecture, app_version, runtime) are one options object.
import { readFileSync, writeSync } from 'node:fs';

import { equal, JSONDecodeError, loads, UnicodeDecodeError } from './compat/pyjson.mjs';
import { io } from './compat/argparse.mjs';
import { pathStr } from './compat/pathlib.mjs';
import { fromNodeError, pyStr } from './compat/pyerr.mjs';
import { decode } from './compat/utf8.mjs';
import { ValueError } from './compat/pyjson.mjs';
import { paths } from './runtime.mjs';

export const RECORD = 'tested-versions.json';

/** Test injection points (Python patched lcu.runtime.paths). */
export const internals = {
  paths: (root, descriptor) => paths(root, descriptor),
};
// Toolkits whose window-targeted input a tested app version handles itself, so LCU's Linux input
// translation (see docs/STANDALONE-ADAPTATIONS.md) is not applied to them for that exact pair.
export const NATIVE_INPUT_TOOLKITS = ['gtk4', 'qt-scroll'];
const _FIELDS = ['platform', 'architecture', 'app_version', 'runtime', 'lcu_version'];
const _SHA256 = /^[0-9a-f]{64}$/;

class KeyError extends Error {
  constructor(key) {
    super(`'${key}'`);
    this.name = 'KeyError';
  }
}

// dict.get(key, default) on either a parsed Map or a plain object.
function get(dict, key, fallback = null) {
  if (dict instanceof Map) return dict.has(key) ? dict.get(key) : fallback;
  return dict !== null && typeof dict === 'object' && Object.hasOwn(dict, key) ? dict[key] : fallback;
}
// dict[key]
function need(dict, key) {
  if (dict instanceof Map ? !dict.has(key) : !(dict !== null && typeof dict === 'object' && Object.hasOwn(dict, key))) {
    throw new KeyError(key);
  }
  return get(dict, key);
}
// data.get('format') == 1 (Python: 1 == 1.0 == True)
const isOne = (value) => equal(value, 1);

/** Return [entries, problem]. A missing or malformed record is a problem, not an error. */
export function load_entries(root) {
  const path = pathStr(root, RECORD);
  let data;
  try {
    data = loads(decode(readFileSync(path)));
  } catch (exc) {
    if (exc?.code === 'ENOENT') return [null, `the tested-versions record is missing (${path})`];
    if (typeof exc?.code === 'string' && /^E[A-Z0-9]+$/.test(exc.code) || exc instanceof UnicodeDecodeError ||
        exc instanceof JSONDecodeError) {
      return [null, `the tested-versions record is unreadable (${path}: ${
        exc instanceof UnicodeDecodeError || exc instanceof JSONDecodeError ? exc.message : pyStr(exc, { filename: path })})`];
    }
    throw exc;
  }
  const entries = data instanceof Map && isOne(data.get('format')) ? data.get('entries') : null;
  if (!Array.isArray(entries)) {
    return [null, `the tested-versions record has an unsupported format (${path})`];
  }
  for (const entry of entries) {
    if (!(entry instanceof Map) ||
        _FIELDS.some((field) => typeof entry.get(field) !== 'string' || !entry.get(field)) ||
        (entry.has('app_sha256') && !(typeof entry.get('app_sha256') === 'string' &&
                                      _SHA256.test(entry.get('app_sha256')))) ||
        (entry.has('native_input') && !(Array.isArray(entry.get('native_input')) &&
                                        entry.get('native_input').every((item) => NATIVE_INPUT_TOOLKITS.includes(item))))) {
      return [null, `the tested-versions record has an invalid entry (${path})`];
    }
  }
  // Entries stay pyjson Maps: `evidence` is arbitrary JSON whose key order must survive (review port-runtime #12).
  return [entries, null];
}

/**
 * Compare one observed app/runtime pair with the record.
 *
 * status is "tested" (exact pair listed), "untested" (record present, pair not
 * listed) or "unknown" (no usable record). `tested` is true, false or null to
 * match. Only an exact platform, architecture, app version and runtime match counts.
 */
export function assess(root, { platform, architecture, app_version, runtime }) {
  const result = {
    status: 'unknown', tested: null, platform, architecture,
    app_version, runtime, tested_with_lcu: null,
    app_sha256: null, evidence: null, tested_pairs: [], warning: null,
  };
  const [entries, problem] = load_entries(root);
  if (entries === null) {
    result.warning = `LCU cannot tell whether ChatGPT ${app_version} with CUA ${runtime} is a tested pair: ` +
      `${problem}. LCU will still use it.`;
    return result;
  }
  const same_target = entries.filter((entry) => entry.get('platform') === platform &&
    entry.get('architecture') === architecture);
  result.tested_pairs = same_target.map((entry) => ({
    app_version: entry.get('app_version'), runtime: entry.get('runtime'), lcu_version: entry.get('lcu_version'),
  }));
  const match = same_target.find((entry) => entry.get('app_version') === app_version && entry.get('runtime') === runtime);
  if (match) {
    Object.assign(result, {
      status: 'tested', tested: true, tested_with_lcu: match.get('lcu_version'),
      app_sha256: get(match, 'app_sha256'), evidence: get(match, 'evidence'),
    });
    return result;
  }
  const listed = result.tested_pairs
    .map((pair) => `ChatGPT ${pair.app_version} with CUA ${pair.runtime}`).join('; ');
  Object.assign(result, { status: 'untested', tested: false });
  result.warning = `ChatGPT ${app_version} with CUA ${runtime} is not a pair LCU has tested on ${platform} ` +
    `${architecture}. LCU will still use it, but behavior has not been verified. ` +
    (listed ? `Tested: ${listed}.` : 'No pair is recorded for this platform and architecture.');
  return result;
}

/** Toolkits the exact tested pair handles natively; empty for any untested or unknown pair. */
export function native_input(root, { platform, architecture, app_version, runtime }) {
  const [entries] = load_entries(root);
  for (const entry of entries ?? []) {
    if (entry.get('platform') === platform && entry.get('architecture') === architecture &&
        entry.get('app_version') === app_version && entry.get('runtime') === runtime) {
      return [...(get(entry, 'native_input', []))];
    }
  }
  return [];
}

/**
 * Read the selected app's platform, architecture, version and runtime from a release.
 *
 * The version and runtime come from the installed app itself when it can be read, so an
 * app updated in place after installation is judged by what is installed now.
 */
export function observe(root, descriptor = null, metadata = null) {
  root = pathStr(root);
  if (descriptor === null) {
    const path = pathStr(root, 'installation.json');
    let data;
    try {
      data = readFileSync(path);
    } catch (exc) {
      throw fromNodeError(exc, { filename: path }) ?? exc;
    }
    descriptor = loads(decode(data));
  }
  if (metadata === null) {
    metadata = internals.paths(root, descriptor)[3];
  }
  return {
    platform: get(descriptor, 'platform', 'linux'), architecture: get(descriptor, 'architecture'),
    app_version: need(metadata, 'version'), runtime: need(metadata, 'runtime'),
  };
}

/**
 * Describe an app that differs from the one recorded at install, or return null.
 *
 * The Linux app is used in place, so a package upgrade changes it under running agents.
 */
export function changed_since_install(descriptor, metadata) {
  const recorded = [get(descriptor, 'package_version'), get(descriptor, 'runtime')];
  const observed = [get(metadata, 'version'), get(metadata, 'runtime')];
  if (!recorded.every((value) => typeof value === 'string' && value) || (recorded[0] === observed[0] && recorded[1] === observed[1])) {
    return null;
  }
  return `The app on disk (ChatGPT ${observed[0]}, CUA ${observed[1]}) differs from the one recorded when LCU ` +
    `was installed (ChatGPT ${recorded[0]}, CUA ${recorded[1]}). Agents that started before the change ` +
    'may be running a mix of old and new files: stop them, restart them, and rerun the LCU installer ' +
    'to update the record.';
}

export function assess_release(root, descriptor = null, metadata = null) {
  const observed = observe(root, descriptor, metadata);
  return assess(root, observed);
}

/** Plain-text lines for setup, install and doctor output; the last is a warning when untested. */
export function status_lines(result) {
  if (result.status === 'tested') {
    return [`Tested pair: yes (ChatGPT ${result.app_version} with CUA ${result.runtime}; ` +
            `tested with LCU ${result.tested_with_lcu}).`];
  }
  return [`Tested pair: ${result.status === 'untested' ? 'no' : 'unknown'}.`,
    `Warning: ${result.warning}`];
}

const isNamed = (exc, names) => {
  for (let cls = exc?.constructor; cls && cls !== Object; cls = Object.getPrototypeOf(cls)) {
    if (names.includes(cls.name)) return true;
  }
  return names.includes(exc?.name);
};

/** Print the tested-pair status for a release; never raises and never blocks. `file`: {write(text)} or null. */
export function report(root, { descriptor = null, metadata = null, file = null } = {}) {
  let lines;
  try {
    lines = status_lines(assess_release(root, descriptor, metadata));
  } catch (exc) {
    const caught = exc instanceof ValueError || isNamed(exc, ['ValueError', 'KeyError', 'TypeError', 'PyValueError',
      'JSONDecodeError', 'UnicodeDecodeError', 'PyOSError', 'OSError']) ||
      (typeof exc?.code === 'string' && /^E[A-Z0-9]+$/.test(exc.code)) || exc instanceof TypeError;
    if (!caught) throw exc;
    lines = [`Tested pair: unknown (the selected app could not be read: ${pyStr(exc)}).`];
  }
  const text = lines.join('\n') + '\n';
  // print(..., file=file or sys.stdout); stdout goes through compat/argparse io like every other print.
  if (file) file.write(text);
  else io.stdout(text);
}
