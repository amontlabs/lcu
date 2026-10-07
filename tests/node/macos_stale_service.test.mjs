// Port of tests/test_macos_stale_service.py (upstream #26: detect and recover from a Computer Use service that
// outlived an update of its app bundle). Every case of the Python file is here, under the same name and in the same
// order. Differences from Python are listed in .port/notes/macos_stale_service.md; in short:
//   * the recovery is asynchronous, so injected steps are async functions and `with PeerLock()` is enter()/exit();
//   * mock.patch of os.kill becomes a temporary replacement of process.kill that records and never signals;
//   * "the default of parameter X is Y" cases compare the exported defaults (recovery_defaults) or the source text.
// SAFETY (.port/BRIEF.md): nothing here signals a process that was not spawned by the test itself (and then only
// after process_guard.verify); the recovery runs only against fakes; no real Sky service is inspected or signalled.
import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PySystemExit } from '../../lcu/compat/argparse.mjs';
import { ValueError, dumps, pyfloat, toPlain } from '../../lcu/compat/pyjson.mjs';
import { TimeoutExpired } from '../../lcu/compat/subprocess.mjs';
import { _testing as systool } from '../../lcu/compat/systool.mjs';
import {
  CODESIGN, LSOF, PS, PeerLock, SIGNAL_BUDGET_SECONDS, SIGNATURE_MISMATCH_MARKERS, SKY_SERVICE_NAME, SingleFlight,
  _process_exists, bounded_run, bundle_change_times, diagnose_sky_services, executable_path, internals, known_service_executables,
  list_sky_services, lock_holders, parse_process_start, parse_process_table, peer_lock, recover_response,
  recover_stale_service, recovery_defaults, requester_waiting, stale_internals, start_original_host, stop_original_host,
  verify_service_signature,
} from '../../lcu/macos_host.mjs';
import { own, verify as verifyOwned } from './process_guard.mjs';

// The test host (the process this file starts below) runs in its own session and may only be signalled after
// process_guard.verify re-checks its identity.
internals.spawn_options = { detached: true };
internals.after_spawn = own;
internals.before_signal = (handle) => assert.ok(verifyOwned(handle), 'refusing to signal an unverified process');

const skip = process.platform === 'win32' ? 'macOS private host' : false;
const MACOS_HOST = fileURLToPath(new URL('../../lcu/macos_host.mjs', import.meta.url));

const BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app';
const EXECUTABLE = `${BUNDLE}/Contents/MacOS/${SKY_SERVICE_NAME}`;
const PLIST = `${BUNDLE}/Contents/Info.plist`;
const SEAL = `${BUNDLE}/Contents/_CodeSignature/CodeResources`;

const epoch = (text) => parse_process_start(text.trim().split(/\s+/));

/** A fake `run`: records [args, options] in `.calls` and answers with the given process table. */
function ps(...lines) {
  let returncode = 0;
  if (lines.length && typeof lines[lines.length - 1] === 'object') ({ returncode } = lines.pop());
  const run = async (args, options) => {
    run.calls.push([args, options]);
    return { returncode, stdout: `${lines.join('\n')}\n`, stderr: '' };
  };
  run.calls = [];
  return run;
}

/** A fake `run` with a fixed answer (unittest.mock.Mock(return_value=...)). */
function answering(returncode = 0, stdout = '', stderr = '') {
  const run = async (args, options) => {
    run.calls.push([args, options]);
    return { returncode, stdout, stderr };
  };
  run.calls = [];
  return run;
}

/** A fake `run` that fails (Mock(side_effect=...)). */
function failing(error) {
  const run = async (args, options) => {
    run.calls.push([args, options]);
    throw error;
  };
  run.calls = [];
  return run;
}

const osError = (message) => Object.assign(new Error(message), { code: 'ENOENT', isOSError: true });

function stat_with(times) {
  return (path) => {
    const key = String(path);
    if (!Object.hasOwn(times, key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
    return { st_ctime: typeof times[key] === 'string' ? epoch(times[key]) : times[key] };
  };
}

const stale_pids = (diagnosis) => diagnosis.services.filter((service) => service.stale).map((service) => service.pid).sort((a, b) => a - b);

function replaced_at(executable, stat) {
  const times = bundle_change_times(executable, stat);
  return times === null ? null : Math.min(...times);
}

/** Every file the diagnosis reads, with one change time. */
function whole_bundle(executable, when) {
  const contents = executable.split('/').slice(0, -2).join('/');
  return { [executable]: when, [`${contents}/Info.plist`]: when, [`${contents}/_CodeSignature/CodeResources`]: when };
}

/** Run `fn` with process.kill replaced by a recorder that never signals anything. */
async function withRecordedKill(fn) {
  const real = process.kill;
  const calls = [];
  process.kill = (...args) => { calls.push(args); return true; };
  try {
    await fn(calls);
  } finally {
    process.kill = real;
  }
}

const throwsAsync = async (fn, matcher) => assert.rejects(async () => fn(), matcher);

describe('ProcessTableTests', { skip }, () => {
  test('test_parses_pid_start_and_a_path_with_spaces', () => {
    const [services, unparsed] = parse_process_table([
      '    1 501 Tue Oct  6 08:00:00 2026     /sbin/launchd',
      `45404 501 Wed Oct  7 00:34:53 2026     ${EXECUTABLE}`,
      '  999 501 Wed Oct  7 01:00:00 2026     /usr/bin/ssh',
    ].join('\n'));
    assert.equal(unparsed, 0);
    assert.deepEqual(services, [{ pid: 45404, uid: 501, path: EXECUTABLE, started: epoch('Wed Oct 7 00:34:53 2026') }]);
  });

  test('test_unicode_separators_in_a_path_cannot_forge_rows_or_fields', () => {
    const fake = `999 501 Mon Jan  1 00:00:00 2026 ${EXECUTABLE}`;
    for (const separator of ['\u2028', '\u2029', '\x85', '\x0b', '\x0c', '\x1c', '\r']) {
      const real = `4242 501 Wed Oct  7 00:34:53 2026 /tmp/x${separator}${fake}`;
      const [services, unparsed] = parse_process_table(real);
      assert.deepEqual(services, [], JSON.stringify(separator));
      assert.equal(unparsed, 1, JSON.stringify(separator));
    }
    // A crafted name with a Unicode space inside the start time is not a row either.
    let [services, unparsed] = parse_process_table(`4242 501 Wed Oct\u2002 7 00:34:53 2026 ${EXECUTABLE}`);
    assert.deepEqual([services, unparsed], [[], 1]);
    [services] = parse_process_table(`4242 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}\r`);
    assert.deepEqual(services.map((item) => item.pid), [4242], 'a trailing CR from the terminal is just trimmed');
  });

  test('test_trailing_control_or_separator_characters_are_refused_not_stripped', () => {
    for (const character of ['\x0b', '\x0c', '\x1c', '\x1f', '\x85', '\u2028', '\u2029', '\x00']) {
      const [services, unparsed] = parse_process_table(`4242 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}${character}`);
      assert.deepEqual([services, unparsed], [[], 1], JSON.stringify(character));
    }
    const [services] = parse_process_table(`4242 501 Wed Oct  7 00:34:53 2026 ${EXECUTABLE}  `);
    assert.deepEqual(services.map((item) => item.path), [EXECUTABLE], 'trailing spaces are padding');
  });

  test('test_keeps_non_ascii_path_characters', () => {
    const path = `/Users/José/ChatGPT.app/Contents/MacOS/${SKY_SERVICE_NAME}`;
    const [services] = parse_process_table(`7 501 Wed Oct  7 00:34:53 2026 ${path}`);
    assert.equal(services[0].path, path);
  });

  test('test_counts_unparseable_service_lines_instead_of_guessing', () => {
    const [services, unparsed] = parse_process_table([
      `oops Wed Oct  7 00:34:53 2026 ${EXECUTABLE}`,
      `45404 501 Wed Smarch  7 00:34:53 2026 ${EXECUTABLE}`,
      `45405 501 Wed Oct  7 25:34:53 2026 ${EXECUTABLE}`,
      `45406 501 Wed Oct  7 00:34:53 2026 relative/${SKY_SERVICE_NAME}`,
      `45407 501 Wed Oct  7 00:34:53 2026 /x/${SKY_SERVICE_NAME}Helper`,
      `45408 ${SKY_SERVICE_NAME}`,
      `45409 x Wed Oct  7 00:34:53 2026 ${EXECUTABLE}`,
      'garbage with no service name',
    ].join('\n'));
    assert.deepEqual(services, []);
    assert.equal(unparsed, 7);
  });
});

describe('BundleTimeTests', { skip }, () => {
  test('test_uses_the_oldest_change_among_executable_plist_and_seal', () => {
    const stat = stat_with({ [EXECUTABLE]: 300.0, [PLIST]: 250.0, [SEAL]: 280.0 });
    assert.equal(replaced_at(EXECUTABLE, stat), 250.0);
  });

  test('test_one_file_with_a_metadata_change_does_not_read_as_a_replacement', async () => {
    // chmod or an extended attribute on the executable alone: the plist and seal keep their old ctime.
    const stat = stat_with({ [EXECUTABLE]: 900.0, [PLIST]: 100.0, [SEAL]: 100.0 });
    assert.equal(replaced_at(EXECUTABLE, stat), 100.0);
    const run = ps(`45404 501 Thu Jan  1 00:10:00 1970 ${EXECUTABLE}`);
    assert.deepEqual(stale_pids(await diagnose_sky_services({ run, stat })), []);
  });

  test('test_a_missing_or_unreadable_file_makes_the_time_unknown_not_a_guess', async () => {
    for (const present of [{ [EXECUTABLE]: 900.0 }, { [EXECUTABLE]: 900.0, [PLIST]: 900.0 },
      { [EXECUTABLE]: 900.0, [SEAL]: 900.0 }, { [PLIST]: 250.0, [SEAL]: 250.0 }]) {
      assert.equal(replaced_at(EXECUTABLE, stat_with(present)), null, JSON.stringify(present));
    }
    const run = ps(`45404 501 Thu Jan  1 00:10:00 1970 ${EXECUTABLE}`);
    const diagnosis = await diagnose_sky_services({ run, stat: stat_with({ [EXECUTABLE]: 900.0 }) });
    assert.deepEqual(stale_pids(diagnosis), []);
    assert.equal(diagnosis.services[0].bundle_times, null);
    assert.equal(replaced_at(`/${SKY_SERVICE_NAME}`, stat_with({ [`/${SKY_SERVICE_NAME}`]: 5.0 })), null);
  });
});

describe('StartTimeTests', { skip }, () => {
  test('test_start_time_is_read_as_utc_whatever_the_local_zone', () => {
    const previous = process.env.TZ;
    try {
      // 02:30 happens twice on 2026-10-25 in Paris; a UTC reading has no ambiguity.
      for (const zone of ['Europe/Paris', 'America/New_York', 'UTC']) {
        process.env.TZ = zone;
        assert.equal(parse_process_start('Sun Oct 25 02:30:00 2026'.split(' ')), 1792895400.0);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test('test_one_pid_can_be_read_with_ps_p_and_a_vanished_one_is_just_absent', async () => {
    const run = ps(`4242 501 Tue Oct  6 11:00:00 2026 ${EXECUTABLE}`);
    const [services, unparsed] = await list_sky_services({ run, pid: 4242 });
    assert.deepEqual(run.calls[0][0], ['/bin/ps', '-ww', '-p', '4242', '-o', 'pid=,uid=,lstart=,comm=']);
    assert.deepEqual([services.map((service) => service.pid), unparsed], [[4242], 0]);
    const gone = answering(1, '', '');
    assert.deepEqual(await list_sky_services({ run: gone, pid: 4242 }), [[], 0]);
    // a full listing never fails quietly
    await throwsAsync(() => diagnose_sky_services({ run: gone, stat: stat_with({}) }), ValueError);
    await throwsAsync(() => list_sky_services({ run: answering(2, '', ''), pid: 4242 }), ValueError);
  });

  test('test_ps_is_asked_for_utc_times', async () => {
    const run = ps();
    await diagnose_sky_services({ run, stat: stat_with({}) });
    assert.equal(run.calls[0][1].env.TZ, 'UTC');
  });

  test('test_ps_is_never_given_a_column_limit_that_would_cut_paths', async () => {
    // A caller's COLUMNS makes `ps` cut the last column, hiding the service name from the listing.
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '80';
    try {
      for (const call of [(run) => diagnose_sky_services({ run, stat: stat_with({}) }), (run) => list_sky_services({ run, pid: 4242 })]) {
        const run = ps();
        await call(run);
        assert.ok(!('COLUMNS' in run.calls[0][1].env));
      }
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });
});

describe('DiagnoseTests', { skip }, () => {
  test('test_flags_a_service_started_before_its_bundle_was_replaced', async () => {
    const run = ps(`45404 501 Tue Oct  6 11:00:00 2026   ${EXECUTABLE}`);
    const stat = stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'));
    const diagnosis = await diagnose_sky_services({ run, stat });
    assert.deepEqual(stale_pids(diagnosis), [45404]);
    assert.equal(diagnosis.services[0].stale, true);
    assert.ok(!('message' in diagnosis));
    assert.deepEqual(run.calls[0][0], ['/bin/ps', '-ww', '-axo', 'pid=,uid=,lstart=,comm=']);
    const { env } = run.calls[0][1];
    assert.deepEqual([env.LC_TIME, env.LC_CTYPE, env.TZ], ['C', 'UTF-8', 'UTC']);
    assert.ok(!('LC_ALL' in env));
  });

  test('test_a_service_started_after_the_replacement_is_fresh', async () => {
    const run = ps(`45404 501 Wed Oct  7 00:34:53 2026   ${EXECUTABLE}`);
    const stat = stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'));
    const diagnosis = await diagnose_sky_services({ run, stat });
    assert.deepEqual(stale_pids(diagnosis), []);
    assert.ok(!('message' in diagnosis));
    assert.equal(diagnosis.services[0].stale, false);
  });

  test('test_a_change_within_the_start_time_resolution_is_not_stale', async () => {
    const start = epoch('Wed Oct 7 00:34:53 2026');
    const run = ps(`45404 501 Wed Oct  7 00:34:53 2026   ${EXECUTABLE}`);
    for (const [replaced, stale] of [[start + 1.9, false], [start + 2.5, true]]) {
      const diagnosis = await diagnose_sky_services({ run, stat: stat_with(whole_bundle(EXECUTABLE, replaced)) });
      assert.equal(JSON.stringify(stale_pids(diagnosis)) === '[45404]', stale, String(replaced));
    }
  });

  test('test_no_service_running', async () => {
    const diagnosis = await diagnose_sky_services({ run: ps('    1 501 Tue Oct  6 08:00:00 2026 /sbin/launchd'), stat: stat_with({}) });
    assert.deepEqual(diagnosis, { services: [], unparsed: 0 });
  });

  test('test_missing_bundle_is_reported_but_not_flagged', async () => {
    const diagnosis = await diagnose_sky_services({ run: ps(`45404 501 Tue Oct  6 11:00:00 2026 ${EXECUTABLE}`), stat: stat_with({}) });
    assert.deepEqual(stale_pids(diagnosis), []);
    assert.equal(diagnosis.services[0].bundle_times, null);
  });

  test('test_unparseable_output_flags_nothing', async () => {
    const diagnosis = await diagnose_sky_services({
      run: ps(`??? ${EXECUTABLE}`, 'not a process table'),
      stat: stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026')) });
    assert.deepEqual([diagnosis.services, diagnosis.unparsed], [[], 1]);
  });

  test('test_only_the_older_of_two_services_is_flagged', async () => {
    const other = `/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/${SKY_SERVICE_NAME}`;
    const run = ps(`45404 501 Wed Oct  7 00:34:53 2026 ${other}`, `  200 501 Tue Oct  6 11:00:00 2026 ${EXECUTABLE}`);
    const stat = stat_with({ ...whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026'), ...whole_bundle(other, 'Wed Oct 7 00:34:50 2026') });
    const diagnosis = await diagnose_sky_services({ run, stat });
    assert.deepEqual(stale_pids(diagnosis), [200]);
    assert.deepEqual(diagnosis.services.map((service) => service.pid), [45404, 200]);
  });

  test('test_ps_failure_is_an_error_not_a_guess', async () => {
    await throwsAsync(() => diagnose_sky_services({ run: ps({ returncode: 1 }), stat: stat_with({}) }), ValueError);
  });

  test('test_real_file_times_compare_with_process_start', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lcu-stale-'));
    try {
      const executable = join(base, 'Codex Computer Use.app/Contents/MacOS', SKY_SERVICE_NAME);
      mkdirSync(join(executable, '..'), { recursive: true });
      writeFileSync(executable, 'service');
      const contents = join(executable, '../..');
      writeFileSync(join(contents, 'Info.plist'), 'plist');
      mkdirSync(join(contents, '_CodeSignature'));
      writeFileSync(join(contents, '_CodeSignature', 'CodeResources'), 'seal');
      const changed = statSync(executable).ctimeMs / 1000;
      // time.strftime('%a %b %e %H:%M:%S %Y', time.gmtime(t))
      const strftime = (seconds) => {
        const date = new Date(Math.floor(seconds) * 1000);
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const two = (n) => String(n).padStart(2, '0');
        return `${names[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} `
          + `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
      };
      const older = strftime(changed - 600);
      const newer = strftime(changed + 600);
      assert.deepEqual(stale_pids(await diagnose_sky_services({ run: ps(`10 501 ${older} ${executable}`) })), [10]);
      assert.deepEqual(stale_pids(await diagnose_sky_services({ run: ps(`10 501 ${newer} ${executable}`) })), []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('test_the_diagnosis_only_lists_processes_and_never_signals_one', async () => {
    const run = ps(`45404 501 Tue Oct  6 11:00:00 2026 ${EXECUTABLE}`);
    await withRecordedKill(async (kills) => {
      await diagnose_sky_services({ run, stat: stat_with(whole_bundle(EXECUTABLE, 'Wed Oct 7 00:21:00 2026')) });
      assert.deepEqual(kills, []);
    });
    assert.equal(run.calls.length, 1);
  });
});

const HOME_BUNDLE = '/Users/x/.codex/computer-use/Codex Computer Use.app';
const HOME_EXECUTABLE = `${HOME_BUNDLE}/Contents/MacOS/${SKY_SERVICE_NAME}`;
const LOCK = '/Users/x/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock.lock';
const EXECUTABLES = new Set([EXECUTABLE, HOME_EXECUTABLE]);
const STALE_START = 'Tue Oct  6 11:00:00 2026';
const REPLACED = 'Wed Oct 7 00:21:00 2026';
const SIGTERM = 15;
const SIGKILL = 9;

class NoPeerLock {
  constructor() { this.acquired = true; this.previous = null; }
  async enter() { return this; }
  exit() { return false; }
  record() { return true; }
}

/** A process table, file times, lock holders, codesign and a kill that only records. */
class FakeWorld {
  constructor({ pid = 4242, uid = 501, path = EXECUTABLE, start = STALE_START, holders = null, verdict = 'invalid', exits_after = 1 } = {}) {
    this.pid = pid;
    this.uid = uid;
    this.path = path;
    this.start = start;
    this.holder_set = holders === null ? new Set([pid]) : holders;
    this.verdict = verdict;
    this.exits_after = exits_after;
    this.kills = [];
    this.polls = 0;
    this.clock = 0.0;
    this.logs = [];
    this.verified = [];
    this.kernel = path;
    this.events = [];
    this.order = [];
    this.lock_paths = [];
    this.selections = [];
    this.table = [FakeWorld.line(pid, uid, start, path)];
    this.after_check = null;
    this.on_holders = null;
    this.on_times = null;
    this.stat = stat_with(whole_bundle(path, REPLACED));
  }

  static line(pid, uid, start, path) {
    return `${pid} ${uid} ${start} ${path}`;
  }

  line(pid, uid, start, path) {
    return FakeWorld.line(pid, uid, start, path);
  }

  async diagnose() {
    this.order.push('ps');
    this.selections.push(null);
    return diagnose_sky_services({ run: ps(...this.table), stat: this.stat });
  }

  async read_process({ pid }) {
    this.order.push('ps-pid');
    this.selections.push(pid);
    return list_sky_services({ run: ps(...this.table.filter((line) => line.trim().split(/\s+/)[0] === String(pid))), pid });
  }

  change_times(path) {
    this.order.push('times');
    if (this.on_times) this.on_times();
    return bundle_change_times(path, this.stat);
  }

  async verify(pid) {
    this.order.push('verify');
    this.verified.push(pid);
    if (this.after_check) this.after_check();
    if (this.verdict instanceof Error) throw this.verdict;
    return this.verdict;
  }

  holders(lock_path) {
    this.order.push(`holders${this.lock_paths.length + 1}`);
    this.lock_paths.push(lock_path);
    if (this.on_holders) this.on_holders(this.lock_paths.length);
    return new Set(this.holder_set);
  }

  kernel_path() {
    this.order.push('kernel');
    return this.kernel;
  }

  kill(pid, sig) {
    this.order.push('kill');
    this.events.push('kill');
    this.kills.push([pid, sig]);
  }

  exists() {
    this.events.push('poll');
    this.polls += 1;
    return this.polls <= this.exits_after;
  }

  sleep(seconds) {
    this.clock += seconds;
  }

  monotonic() {
    return this.clock;
  }

  run(overrides = {}) {
    const options = {
      lock_path: LOCK, executables: EXECUTABLES, uid: 501, diagnose: () => this.diagnose(),
      read_process: (arguments_) => this.read_process(arguments_), change_times: (path) => this.change_times(path),
      verify: (pid) => this.verify(pid), holders: (lock_path) => this.holders(lock_path),
      kernel_path: (pid) => this.kernel_path(pid), kill: (pid, sig) => this.kill(pid, sig),
      exists: (pid) => this.exists(pid), realpath: (path) => path, sleep: (seconds) => this.sleep(seconds),
      monotonic: () => this.monotonic(), waiting: () => true, exclusive: () => new NoPeerLock(),
      log: (line) => this.logs.push(line),
    };
    return recover_stale_service({ ...options, ...overrides });
  }
}

/** A recording peer lock (the class Peer of RecoveryTests). */
class Peer {
  constructor(acquired = true, previous = null, events = null) {
    this.acquired = acquired;
    this.previous = previous;
    this.events = events === null ? [] : events;
    this.recorded = [];
  }

  async enter() { this.events.push('enter'); return this; }

  exit() { this.events.push('exit'); return false; }

  record(outcome) { this.events.push('record'); this.recorded.push(outcome); return true; }
}

const plain = (value) => toPlain(value, { floats: 'number' });

describe('RecoveryTests', { skip }, () => {
  const assertNothingSignaled = (world, result, reason = null) => {
    assert.equal(result.recovered, false, JSON.stringify(result));
    assert.deepEqual(world.kills, [], 'no process may be signaled');
    assert.deepEqual(world.logs, []);
    if (reason) assert.ok(result.reason.includes(reason), `${result.reason} does not include ${reason}`);
  };

  test('test_a_provably_stale_lock_holder_gets_one_sigterm_and_is_waited_for', async () => {
    const world = new FakeWorld({ exits_after: 3 });
    const result = await world.run();
    assert.deepEqual(world.kills, [[4242, SIGTERM]]);
    assert.equal(result.recovered, true);
    assert.deepEqual([result.pid, result.path], [4242, EXECUTABLE]);
    assert.deepEqual(world.verified, [4242]);
    assert.deepEqual(world.selections, [null, 4242], 'the last process read is for that one pid');
    assert.deepEqual(world.lock_paths, [LOCK, LOCK], 'checked before the signature and again before the signal');
    assert.equal(world.logs.length, 1);
    assert.ok(world.logs[0].includes('pid 4242'));
    assert.ok(world.logs[0].includes(EXECUTABLE));
    assert.match(world.logs[0], /exited after \d+ ms/);
  });

  test('test_the_apps_own_copy_is_a_known_bundle_too', async () => {
    const world = new FakeWorld({ path: HOME_EXECUTABLE });
    assert.equal((await world.run()).recovered, true);
    assert.equal(world.kills.length, 1);
  });

  test('test_a_healthy_or_unverifiable_service_is_never_signaled', async () => {
    for (const verdict of ['valid', 'unknown', new Error('codesign missing'),
      new TimeoutExpired(['codesign'], 4000), osError('no codesign')]) {
      const world = new FakeWorld({ verdict });
      assertNothingSignaled(world, await world.run());
    }
  });

  test('test_a_fresh_service_is_never_a_candidate', async () => {
    const world = new FakeWorld({ start: 'Wed Oct  7 00:34:53 2026' });
    assertNothingSignaled(world, await world.run(), 'no stale service');
    assert.deepEqual(world.verified, [], 'a fresh service is not even checked');
  });

  test('test_no_service_and_a_failing_process_listing_do_nothing', async () => {
    const world = new FakeWorld();
    world.table = [];
    assertNothingSignaled(world, await world.run(), 'no stale service');
    const broken = new FakeWorld();
    const result = await broken.run({ diagnose: async () => { throw new TimeoutExpired(['ps'], 2000); } });
    assertNothingSignaled(broken, result, 'check failed');
  });

  test('test_pid_one_or_this_process_is_never_signaled', async () => {
    for (const pid of [1, 0, process.pid]) {
      const world = new FakeWorld({ pid });
      assertNothingSignaled(world, await world.run());
    }
  });

  test('test_a_process_of_another_user_is_never_signaled', async () => {
    for (const uid of [0, 502]) {
      const world = new FakeWorld({ uid });
      assertNothingSignaled(world, await world.run(), 'no stale service');
      assert.deepEqual(world.verified, []);
    }
  });

  test('test_another_users_stale_service_does_not_block_recovery_of_ours', async () => {
    let world = new FakeWorld();
    world.table.push(world.line(5151, 502, STALE_START, EXECUTABLE));
    assert.equal((await world.run()).recovered, true);
    assert.deepEqual(world.kills.map(([pid]) => pid), [4242]);
    // Two of our own stale services still refuse.
    world = new FakeWorld();
    world.table.push(world.line(5151, 501, STALE_START, EXECUTABLE));
    assertNothingSignaled(world, await world.run(), 'more than one');
  });

  test('test_a_process_with_another_name_is_never_signaled', async () => {
    let world = new FakeWorld({ path: EXECUTABLE.replace(SKY_SERVICE_NAME, 'ChatGPT') });
    world.table = [world.line(4242, 501, STALE_START, world.path)];
    assertNothingSignaled(world, await world.run(), 'no stale service');
    // Even if a table somehow produced one, the executable name is checked again.
    world = new FakeWorld();
    const crafted = { services: [{ pid: 4242, uid: 501, path: EXECUTABLE.replace(SKY_SERVICE_NAME, 'ChatGPT'), started: 1.0, stale: true }] };
    assertNothingSignaled(world, await world.run({ diagnose: () => crafted }), 'known Computer Use bundle');
  });

  test('test_a_service_outside_the_known_bundles_is_never_signaled', async () => {
    for (const path of [`/Applications/Other.app/Contents/MacOS/${SKY_SERVICE_NAME}`,
      `/tmp/Codex Computer Use.app/Contents/MacOS/${SKY_SERVICE_NAME}`]) {
      const world = new FakeWorld({ path });
      assertNothingSignaled(world, await world.run(), 'known Computer Use bundle');
    }
    const world = new FakeWorld();
    assertNothingSignaled(world, await world.run({ executables: new Set() }), 'known Computer Use bundle');
  });

  test('test_a_symlinked_path_is_compared_by_real_path', async () => {
    const world = new FakeWorld({ path: `/tmp/link/Contents/MacOS/${SKY_SERVICE_NAME}` });
    const result = await world.run({ realpath: (path) => (path.startsWith('/tmp/link') ? EXECUTABLE : path) });
    assert.equal(result.recovered, true);
  });

  test('test_more_than_one_stale_service_does_nothing', async () => {
    const world = new FakeWorld();
    world.table.push(world.line(5151, 501, STALE_START, HOME_EXECUTABLE));
    world.stat = stat_with({ ...whole_bundle(EXECUTABLE, REPLACED), ...whole_bundle(HOME_EXECUTABLE, REPLACED) });
    assertNothingSignaled(world, await world.run(), 'more than one');
  });

  test('test_a_healthy_second_service_does_not_stop_recovery_of_the_stale_holder', async () => {
    const world = new FakeWorld();
    world.table.push(world.line(5151, 501, 'Wed Oct  7 00:34:53 2026', HOME_EXECUTABLE));
    world.stat = stat_with({ ...whole_bundle(EXECUTABLE, REPLACED), ...whole_bundle(HOME_EXECUTABLE, 'Wed Oct 7 00:34:50 2026') });
    assert.equal((await world.run()).recovered, true);
    assert.deepEqual(world.kills.map(([pid]) => pid), [4242]);
  });

  test('test_only_the_sole_holder_of_the_lock_is_signaled', async () => {
    for (const holders of [new Set(), new Set([4242, 9999]), new Set([9999]), null]) {
      const world = new FakeWorld({ holders: holders === null ? new Set() : holders });
      const result = await world.run(holders === null ? { holders: () => null } : {});
      assertNothingSignaled(world, result, 'only holder');
      assert.deepEqual(world.verified, [], 'the signature is not even checked without the lock');
    }
  });

  test('test_a_missing_lock_path_does_nothing', async () => {
    const world = new FakeWorld();
    const result = await world.run({ lock_path: null, holders: lock_holders });
    assertNothingSignaled(world, result, 'only holder');
  });

  test('test_a_reused_pid_or_a_changed_service_between_check_and_signal_is_not_signaled', async () => {
    const changes = [
      (world) => { world.table = [world.line(4242, 501, 'Wed Oct  7 00:40:00 2026', EXECUTABLE)]; },
      (world) => { world.table = [world.line(4242, 501, STALE_START, HOME_EXECUTABLE)]; },
      (world) => { world.table = [world.line(4242, 502, STALE_START, EXECUTABLE)]; },
      (world) => { world.table = []; },
      (world) => { world.table = [world.line(7777, 501, STALE_START, EXECUTABLE)]; },
      (world) => { world.table = [world.line(4242, 501, STALE_START, EXECUTABLE), world.line(4242, 501, STALE_START, EXECUTABLE)]; },
      (world) => { world.table.push(`4242 501 not-a-date ${EXECUTABLE}`); },
    ];
    for (const change of changes) {
      const world = new FakeWorld();
      world.stat = stat_with({ ...whole_bundle(EXECUTABLE, REPLACED), ...whole_bundle(HOME_EXECUTABLE, REPLACED) });
      world.after_check = () => change(world);
      assertNothingSignaled(world, await world.run(), 'changed while');
    }
  });

  test('test_the_kernel_reported_executable_must_be_the_known_one', async () => {
    // argv[0], which ps shows, can be chosen by any process of the same user.
    for (const kernel of [null, '/bin/sleep', `/tmp/evil/Contents/MacOS/${SKY_SERVICE_NAME}`, `${HOME_EXECUTABLE}x`]) {
      const world = new FakeWorld();
      world.kernel = kernel;
      assertNothingSignaled(world, await world.run(), 'kernel');
    }
    const world = new FakeWorld();
    world.after_check = () => { world.kernel = '/bin/sleep'; };
    assertNothingSignaled(world, await world.run(), 'changed while');
  });

  test('test_a_lock_that_changes_hands_during_the_signature_check_is_not_signaled', async () => {
    for (const holders of [new Set([9999]), new Set([4242, 9999]), new Set()]) {
      const world = new FakeWorld();
      world.after_check = () => { world.holder_set = holders; };
      assertNothingSignaled(world, await world.run(), 'lock changed hands');
    }
  });

  test('test_an_incomplete_process_listing_does_nothing', async () => {
    const world = new FakeWorld();
    world.table.push(`5151 501 not-a-date ${HOME_EXECUTABLE}`);
    assertNothingSignaled(world, await world.run(), 'incomplete');
  });

  test('test_checks_that_took_too_long_are_not_acted_on', async () => {
    let world = new FakeWorld();
    world.after_check = () => { world.clock += SIGNAL_BUDGET_SECONDS + 0.5; };
    assertNothingSignaled(world, await world.run(), 'too long');
    // The budget is measured on the monotonic clock up to the moment of the signal.
    world = new FakeWorld();
    world.on_times = () => { world.clock += SIGNAL_BUDGET_SECONDS + 0.5; };
    assertNothingSignaled(world, await world.run(), 'too long');
  });

  test('test_nothing_is_signaled_once_the_requester_stopped_waiting', async () => {
    let world = new FakeWorld();
    assertNothingSignaled(world, await world.run({ waiting: () => false }), 'stopped waiting');
    const asked = [];
    world = new FakeWorld();
    await world.run({ waiting: () => { asked.push([...world.order]); return true; } });
    assert.deepEqual(asked, [world.order.slice(0, world.order.indexOf('kill'))], 'asked once, right before the signal');
    world = new FakeWorld();
    assertNothingSignaled(world, await world.run({ waiting: () => { throw osError('closed'); } }), 'check failed');
  });

  test('test_the_default_is_the_real_peer_lock_and_no_requester', () => {
    assert.equal(recovery_defaults.exclusive, peer_lock);
    assert.ok(peer_lock() instanceof PeerLock);
  });

  test('test_without_a_requester_nothing_is_ever_signaled', async () => {
    const world = new FakeWorld();
    const result = await world.run({ waiting: recovery_defaults.waiting });
    assertNothingSignaled(world, result, 'stopped waiting');
  });

  test('test_the_final_reads_follow_every_slow_step_and_the_process_is_read_last', async () => {
    const world = new FakeWorld();
    const peer = new Peer(true, null, world.order);
    assert.equal((await world.run({ exclusive: () => peer })).recovered, true);
    assert.deepEqual(world.order.slice(0, world.order.indexOf('kill') + 1),
      ['enter', 'ps', 'kernel', 'holders1', 'verify', 'record', 'holders2', 'times', 'ps-pid', 'kernel', 'kill']);
  });

  test('test_a_pid_reused_during_the_final_lock_read_is_not_signaled', async () => {
    const world = new FakeWorld();
    world.on_holders = (call) => {
      if (call === 2) {
        world.table = [world.line(4242, 501, 'Wed Oct  7 00:40:00 2026', '/usr/bin/other')];
        world.kernel = '/usr/bin/other';
      }
    };
    assertNothingSignaled(world, await world.run(), 'changed while');
  });

  test('test_a_healthy_service_that_took_over_the_pid_and_path_is_not_signaled', async () => {
    // P exits during the final lock read and its pid goes to a service from the same bundle.
    for (const start of ['Wed Oct  7 00:40:00 2026', 'Tue Oct  6 12:00:00 2026']) {
      const world = new FakeWorld();
      world.on_holders = (call) => { if (call === 2) world.table = [world.line(4242, 501, start, EXECUTABLE)]; };
      assertNothingSignaled(world, await world.run(), 'changed while');
    }
  });

  test('test_a_bundle_restored_after_the_signature_check_is_not_signaled', async () => {
    // The mismatch was seen against the replacement; restoring the old bundle gives all
    // three files new change times, so the service still looks stale but is not the same case.
    const world = new FakeWorld();
    world.after_check = () => { world.stat = stat_with(whole_bundle(world.path, 'Wed Oct 7 00:30:00 2026')); };
    assertNothingSignaled(world, await world.run(), 'bundle changed');
  });

  test('test_restored_files_are_noticed_even_when_the_oldest_change_time_is_untouched', async () => {
    let world = new FakeWorld();
    const base = whole_bundle(world.path, REPLACED);
    const plist = `${world.path.split('/').slice(0, -2).join('/')}/Info.plist`;
    world.after_check = () => {
      const changed = { ...base };
      changed[world.path] = 'Wed Oct 7 00:25:00 2026';
      changed[plist] = 'Wed Oct 7 00:26:00 2026';
      world.stat = stat_with(changed); // the seal keeps the oldest time
    };
    assertNothingSignaled(world, await world.run(), 'bundle changed');
    world = new FakeWorld();
    world.after_check = () => { world.stat = stat_with({}); };
    assertNothingSignaled(world, await world.run(), 'bundle changed');
  });

  test('test_the_peer_lock_is_held_until_the_service_has_exited', async () => {
    const world = new FakeWorld({ exits_after: 3 });
    const peer = new Peer(true, null, world.events);
    assert.equal((await world.run({ exclusive: () => peer })).recovered, true);
    assert.deepEqual(world.events, ['enter', 'record', 'kill', 'poll', 'poll', 'poll', 'poll', 'exit']);
  });

  test('test_a_refused_peer_lock_does_nothing', async () => {
    const world = new FakeWorld();
    assertNothingSignaled(world, await world.run({ exclusive: () => new Peer(false) }), 'another LCU');
  });

  test('test_the_instance_is_recorded_before_the_signal_and_kept', async () => {
    const world = new FakeWorld();
    let peer = new Peer();
    await world.run({ exclusive: () => peer });
    assert.deepEqual(peer.recorded.map(plain), [{ pid: 4242, started: epoch(STALE_START) }]);
    const stuck = new FakeWorld({ exits_after: 10 ** 9 });
    peer = new Peer();
    await stuck.run({ exclusive: () => peer });
    assert.deepEqual(peer.recorded.map(plain), [{ pid: 4242, started: epoch(STALE_START) }],
      'a service that did not exit stays recorded as asked');
    // The record is a JSON float, like Python's.
    assert.equal(dumps(peer.recorded[0]), `{"pid": 4242, "started": ${epoch(STALE_START).toFixed(1)}}`);
  });

  test('test_a_host_that_waited_for_another_does_not_claim_its_recovery', async () => {
    // An old record says nothing about what the other host did; nothing is retried on it.
    const world = new FakeWorld();
    world.table = [];
    const peer = new Peer(true, new Map([['pid', 500], ['started', pyfloat(5.0)]]));
    peer.waited = true; // however long it waited for the other host
    const result = await world.run({ exclusive: () => peer });
    assertNothingSignaled(world, result, 'no stale service');
  });

  test('test_an_attempt_that_ends_without_a_signal_is_cleared_again', async () => {
    for (const hook of ['on_holders', 'on_times']) {
      const world = new FakeWorld();
      world[hook] = (call) => { if (call === undefined || call === 2) world.table = []; };
      const peer = new Peer();
      assertNothingSignaled(world, await world.run({ exclusive: () => peer }), 'changed while');
      assert.deepEqual(peer.recorded.map(plain), [{ pid: 4242, started: epoch(STALE_START) }, {}]);
    }
    let world = new FakeWorld();
    let peer = new Peer();
    assertNothingSignaled(world, await world.run({ exclusive: () => peer, waiting: () => false }), 'stopped waiting');
    assert.deepEqual(plain(peer.recorded.at(-1)), {});
    // An instance asked earlier (which outlived SIGTERM) stays recorded after an attempt on another.
    const earlier = new Map([['pid', 777], ['started', pyfloat(5.0)]]);
    world = new FakeWorld();
    peer = new Peer(true, earlier);
    assertNothingSignaled(world, await world.run({ exclusive: () => peer, waiting: () => false }), 'stopped waiting');
    assert.deepEqual(plain(peer.recorded.at(-1)), { pid: 777, started: 5 });
  });

  test('test_no_record_no_signal', async () => {
    class Unwritable extends Peer {
      record() { return false; }
    }
    const world = new FakeWorld();
    assertNothingSignaled(world, await world.run({ exclusive: () => new Unwritable() }), 'could not be recorded');
  });

  test('test_a_host_that_stops_mid_wait_still_leaves_the_attempt_on_record', async () => {
    const peer = new Peer();
    let world = new FakeWorld({ exits_after: 10 ** 9 });
    const hostStops = () => { throw new PySystemExit('the host process is going away'); };
    await assert.rejects(world.run({ exclusive: () => peer, sleep: hostStops }), PySystemExit);
    assert.equal(world.kills.length, 1);
    assert.equal(world.logs.length, 1, 'a signal that was sent is always logged');
    assert.deepEqual(peer.recorded.map(plain), [{ pid: 4242, started: epoch(STALE_START) }]);
    // The next host sees that record and does not signal this instance again.
    world = new FakeWorld();
    assertNothingSignaled(world, await world.run({ exclusive: () => new Peer(true, peer.recorded[0]) }), 'already asked');
  });

  test('test_one_instance_is_never_signaled_twice_whatever_the_clocks_say', async () => {
    const peer = (previous) => () => new Peer(true, previous);
    const asked = { pid: 4242, started: epoch(STALE_START) };
    for (const wallclock of [0.0, 1e12, -1e12]) {
      const world = new FakeWorld();
      world.clock = wallclock;
      assertNothingSignaled(world, await world.run({ exclusive: peer(asked) }), 'already asked');
    }
    for (const other of [{ ...asked, pid: 9999 }, { ...asked, started: 1.0 }, {}, { pid: 4242 }]) {
      const world = new FakeWorld();
      assert.equal((await world.run({ exclusive: peer(other) })).recovered, true, JSON.stringify(other));
    }
  });

  test('test_a_service_that_does_not_exit_is_waited_for_a_bounded_time_and_never_force_killed', async () => {
    const world = new FakeWorld({ exits_after: 10 ** 9 });
    const result = await world.run();
    assert.deepEqual(world.kills, [[4242, SIGTERM]], 'one SIGTERM and no SIGKILL');
    assert.equal(result.recovered, false);
    assert.ok(result.reason.includes('did not exit'));
    assert.ok(world.clock <= 3.2);
    assert.ok(world.polls <= 40);
    assert.equal(world.logs.length, 1);
    assert.ok(world.logs[0].includes('did not exit'));
  });

  test('test_a_failing_exit_probe_is_not_a_recovery', async () => {
    const world = new FakeWorld();
    const result = await world.run({ exists: () => { throw new Error('probe'); } });
    assert.equal(result.recovered, false);
    assert.equal(world.kills.length, 1);
    assert.equal(world.logs.length, 1);
  });

  test('test_the_signal_is_sigterm_to_one_positive_pid_through_kill_and_nothing_else', async () => {
    const world = new FakeWorld();
    await withRecordedKill(async (real) => {
      await world.run();
      assert.deepEqual(real, [], 'the injected kill is the only way a signal is sent (and there is no killpg)');
    });
    assert.equal(world.kills.length, 1);
    const [[pid, sig]] = world.kills;
    assert.ok(Number.isInteger(pid));
    assert.ok(pid > 1);
    assert.equal(sig, SIGTERM);
    assert.notEqual(sig, SIGKILL);
  });

  test('test_the_exit_probe_refuses_pids_that_are_not_one_process', async () => {
    for (const pid of [0, 1, -1, -4242, true, '4242', null]) {
      await withRecordedKill((kills) => {
        assert.throws(() => _process_exists(pid), ValueError, String(pid));
        assert.deepEqual(kills, []);
      });
    }
  });

  test('test_non_macos_never_looks_for_or_signals_anything', async () => {
    const platform = stale_internals.platform;
    stale_internals.platform = 'linux';
    try {
      await withRecordedKill(async (kills) => {
        assert.deepEqual(await recover_response(), { ok: true, recovered: false, reason: 'not macOS' });
        assert.deepEqual(kills, []);
      });
    } finally {
      stale_internals.platform = platform;
    }
  });

  test('test_the_default_response_passes_the_lock_path_and_the_requesters_presence', async () => {
    const presence = () => true;
    const calls = [];
    const { platform, recover_stale_service: real } = stale_internals;
    const savedLock = process.env.LCU_MAC_SERVICE_LOCK;
    stale_internals.platform = 'darwin';
    stale_internals.recover_stale_service = async (options) => { calls.push(options); return { ok: true, recovered: false }; };
    try {
      process.env.LCU_MAC_SERVICE_LOCK = LOCK;
      await recover_response(presence);
      delete process.env.LCU_MAC_SERVICE_LOCK;
      await recover_response();
    } finally {
      stale_internals.platform = platform;
      stale_internals.recover_stale_service = real;
      if (savedLock === undefined) delete process.env.LCU_MAC_SERVICE_LOCK;
      else process.env.LCU_MAC_SERVICE_LOCK = savedLock;
    }
    const [first, second] = calls;
    assert.equal(first.lock_path, LOCK);
    assert.equal(first.waiting, presence);
    assert.ok(!('exclusive' in first), 'the real peer lock, the default, is used');
    assert.equal(second.lock_path, null);
    assert.equal(second.waiting(), false, 'no requester means nobody is waiting');
  });

  test('test_the_requester_is_waiting_only_while_its_connection_is_open_and_quiet', async () => {
    // The requester side of a unix socket connection, and the host side wrapped in the host's LineReader.
    const { LineReader } = await import('../../lcu/macos_host.mjs');
    const dir = mkdtempSync(join('/tmp', 'lcu-rw-'));
    const address = join(dir, 's.sock');
    const hostSide = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => hostSide.push(new LineReader(socket)));
    await new Promise((resolve) => server.listen(address, resolve));
    const connect = async () => {
      const before = hostSide.length;
      const client = net.createConnection(address);
      client.on('error', () => {});
      await new Promise((resolve) => client.once('connect', resolve));
      while (hostSide.length === before) await new Promise((resolve) => setTimeout(resolve, 5));
      return [hostSide[hostSide.length - 1], client];
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
    try {
      let [here, there] = await connect();
      assert.equal(requester_waiting(here), true);
      there.end(); // shutdown(SHUT_WR): the requester closed its end
      await settle();
      assert.equal(requester_waiting(here), false, 'the requester closed its end');
      here.close();
      [here, there] = await connect();
      there.write('more\n');
      await settle();
      assert.equal(requester_waiting(here), false);
      here.close();
      there.destroy();
      [here, there] = await connect();
      there.destroy();
      here.close(); // a closed descriptor is not a waiting requester
      await settle();
      assert.equal(requester_waiting(here), false, 'a closed descriptor is not a waiting requester');
      assert.equal(requester_waiting(null), false);
    } finally {
      for (const reader of hostSide) reader.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('test_system_tools_are_used_by_absolute_path', () => {
    assert.deepEqual([PS, LSOF, CODESIGN], ['/bin/ps', '/usr/sbin/lsof', '/usr/bin/codesign']);
  });
});

describe('CodesignAndLockTests', { skip }, () => {
  test('test_a_healthy_service_is_valid', async () => {
    const run = answering(0, '', '4242: dynamically valid\n4242: valid on disk\n4242: satisfies its Designated Requirement\n');
    assert.equal(await verify_service_signature(4242, { run }), 'valid');
    assert.deepEqual(run.calls[0][0], ['/usr/bin/codesign', '--verify', '--strict', '4242']);
    assert.ok(Number.isInteger(run.calls[0][1].timeout));
  });

  test('test_only_a_running_versus_disk_mismatch_is_invalid', async () => {
    const mismatch = '4242: the code on disk does not match what is running';
    assert.equal(await verify_service_signature(4242, { run: answering(1, '', mismatch) }), 'invalid');
    for (const run of [answering(1, '', '4242: no such process'),
      answering(1, '', ''),
      answering(1, '', '4242: invalid signature (code or signature have been modified)'),
      answering(1, '', '4242: a sealed resource is missing or invalid'),
      answering(1, '', '4242: invalid or unsupported format for signature'),
      answering(2, '', mismatch),
      answering(3, '', mismatch),
      failing(new TimeoutExpired(['codesign'], 4000)),
      failing(osError('missing'))]) {
      assert.equal(await verify_service_signature(4242, { run }), 'unknown');
    }
    assert.deepEqual([...SIGNATURE_MISMATCH_MARKERS], ['the code on disk does not match what is running']);
  });

  test('test_codesign_runs_with_english_messages', async () => {
    const run = answering(0);
    await verify_service_signature(4242, { run });
    assert.equal(run.calls[0][1].env.LC_TIME, 'C');
    assert.ok(!('LC_ALL' in run.calls[0][1].env));
  });

  test('test_system_tools_run_with_a_bound_even_when_the_child_cannot_be_killed', async () => {
    // The default `run` of each function is bounded_run (JavaScript cannot inspect defaults: read the source).
    for (const [name, source] of [['list_sky_services', list_sky_services], ['verify_service_signature', verify_service_signature],
      ['lock_holders', lock_holders]]) {
      assert.match(source.toString(), /run = bounded_run/, name);
    }

    class Unkillable {
      constructor(args, options) {
        this.args = args;
        this.options = options;
        this.returncode = null;
        this.kills = 0;
        this.waits = [];
      }

      async communicate(timeout) {
        this.waits.push(timeout);
        throw new TimeoutExpired(['lsof'], timeout * 1000); // blocked in the kernel, even after SIGKILL
      }

      kill() { this.kills += 1; }
    }

    const made = [];
    await assert.rejects(bounded_run([LSOF, '-t'], { timeout: 3, popen: (...a) => { made.push(new Unkillable(...a)); return made.at(-1); } }),
      TimeoutExpired);
    const [child] = made;
    assert.equal(child.kills, 1);
    assert.deepEqual(child.waits, [3, 1], 'one bounded wait after the kill, then the child is abandoned');
    assert.equal(await lock_holders(LOCK, { run: (args, options) => bounded_run(args, { ...options, popen: (...b) => new Unkillable(...b) }) }), null);
  });

  test('test_bounded_run_returns_the_output_and_status', async () => {
    class Done {
      constructor(args, options) {
        this.options = options;
        this.returncode = 1;
      }

      async communicate() { return ['out', 'err']; }
    }

    const made = [];
    const result = await bounded_run(['/bin/ps'], { timeout: 2, env: { TZ: 'UTC' }, popen: (...a) => { made.push(new Done(...a)); return made.at(-1); } });
    assert.deepEqual([result.returncode, result.stdout, result.stderr], [1, 'out', 'err']);
    assert.deepEqual(made[0].options.env, { TZ: 'UTC' });
  });

  test('test_bounded_run_runs_real_tools_and_kills_one_that_outlives_its_timeout', { skip: process.platform === 'win32' }, async () => {
    // Not in the Python suite (it only used fakes): the default Popen replacement, on tools this test spawns itself.
    const done = await bounded_run([process.execPath, '-e', 'process.stdout.write("a\\r\\nb"); process.stderr.write("e"); process.exit(3)'], { timeout: 20 });
    assert.deepEqual([done.returncode, done.stdout, done.stderr], [3, 'a\nb', 'e'], 'text mode: universal newlines');
    const started = Date.now();
    await assert.rejects(bounded_run([process.execPath, '-e', 'setTimeout(() => {}, 60000)'], { timeout: 0.3 }), TimeoutExpired);
    assert.ok(Date.now() - started < 5000, 'killed and reaped well inside the extra second');
    await assert.rejects(bounded_run(['/nonexistent/lcu-tool'], { timeout: 2 }), (error) => error.name === 'FileNotFoundError' || /No such file/.test(error.message));
  });

  test('test_lock_holders_parses_lsof_terse_output', async () => {
    assert.deepEqual(await lock_holders(LOCK, { run: answering(0, '4242\n') }), new Set([4242]));
    assert.deepEqual(await lock_holders(LOCK, { run: answering(0, '4242\n7\n') }), new Set([4242, 7]));
    assert.deepEqual(await lock_holders(LOCK, { run: answering(1, '') }), new Set());
    const run = answering(0, '4242\n');
    await lock_holders(LOCK, { run });
    assert.deepEqual(run.calls[0][0], ['/usr/sbin/lsof', '-t', '--', LOCK]);
  });

  test('test_lock_holders_is_unknown_unless_lsof_answered_cleanly', async () => {
    for (const run of [answering(2, ''), answering(0, 'lsof: WARNING\n'),
      answering(1, '4242\n'), // status 1 may mean an error, not a complete list
      answering(0, '4242\n', 'lsof: WARNING: can not stat() file system\n'),
      answering(1, '', 'lsof: status error\n'),
      answering(0, ''),
      failing(new TimeoutExpired(['lsof'], 3000)), failing(osError('x'))]) {
      assert.equal(await lock_holders(LOCK, { run }), null);
    }
    for (const path of [null, '', 'relative/computeruse.sock.lock']) {
      assert.equal(await lock_holders(path, { run: answering(0, '1\n') }), null);
    }
  });

  test('test_the_kernel_executable_path_is_only_asked_for_real_processes_on_macos', async () => {
    const platform = stale_internals.platform;
    stale_internals.platform = 'linux';
    try {
      assert.equal(await executable_path(process.pid), null);
    } finally {
      stale_internals.platform = platform;
    }
    for (const pid of [0, 1, -1, true, '1', null]) {
      assert.equal(await executable_path(pid), null, String(pid));
    }
    if (process.platform === 'darwin') {
      // Read-only: lsof asked about this very test process.
      const path = await executable_path(process.pid);
      assert.ok(path && path.startsWith('/') && existsSync(path), String(path));
      assert.equal(await executable_path(2 ** 30), null);
    }
    // ADAPTATION (lsof instead of proc_pidpath): the reply must be exactly the pid's first text entry.
    const answers = (stdout, returncode = 0, stderr = '') => answering(returncode, stdout, stderr);
    stale_internals.platform = 'darwin';
    try {
      assert.equal(await executable_path(4242, { run: answers('p4242\nftxt\nn/a/b/Svc\nftxt\nn/usr/lib/dyld\n') }), '/a/b/Svc');
      assert.equal(await executable_path(4242, { run: answers('p9\nftxt\nn/a/b/Svc\n') }), null);
      assert.equal(await executable_path(4242, { run: answers('p4242\n', 1) }), null);
      assert.equal(await executable_path(4242, { run: answers('p4242\nftxt\nnrelative\n') }), null);
      assert.equal(await executable_path(4242, { run: answers('p4242\nftxt\nn/a\n', 0, 'lsof: WARNING') }), null);
      assert.equal(await executable_path(4242, { run: failing(new TimeoutExpired(['lsof'], 3000)) }), null);
    } finally {
      stale_internals.platform = platform;
    }
  });

  test('test_known_executables_are_the_configured_service_and_the_apps_copy', () => {
    const environment = { SKY_CUA_SERVICE_PATH: BUNDLE, CODEX_HOME: '/Users/x/.codex' };
    assert.deepEqual(known_service_executables(environment, (path) => path), new Set([EXECUTABLE, HOME_EXECUTABLE]));
    assert.deepEqual(known_service_executables({ SKY_CUA_SERVICE_PATH: 'relative.app' }), new Set());
    assert.deepEqual(known_service_executables({}), new Set());
  });

  test('test_a_bundle_alias_is_allowed_but_an_executable_escaping_it_is_not', () => {
    const environment = { SKY_CUA_SERVICE_PATH: BUNDLE, CODEX_HOME: '/Users/x/.codex' };
    const other = `/Applications/Other.app/Contents/MacOS/${SKY_SERVICE_NAME}`;
    const realpath = (path) => {
      if (path === BUNDLE) return '/real/ChatGPT/Codex Computer Use.app';
      if (path === EXECUTABLE) return `/real/ChatGPT/Codex Computer Use.app/Contents/MacOS/${SKY_SERVICE_NAME}`;
      if (path === HOME_EXECUTABLE) return other; // a symlink that leaves its bundle
      return path;
    };
    assert.deepEqual(known_service_executables(environment, realpath),
      new Set([`/real/ChatGPT/Codex Computer Use.app/Contents/MacOS/${SKY_SERVICE_NAME}`]));
    // Another file name, or the bundle itself, is not a service executable either.
    for (const resolved of ['/real/ChatGPT/Codex Computer Use.app/Contents/MacOS/other', '/real/ChatGPT/Codex Computer Use.app']) {
      assert.deepEqual(known_service_executables({ SKY_CUA_SERVICE_PATH: BUNDLE },
        (path) => (path === BUNDLE ? '/real/ChatGPT/Codex Computer Use.app' : resolved)), new Set());
    }
  });
});

describe('PeerLockTests', { skip }, () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'lcu-peer-'));

  test('test_a_second_holder_waits_a_bounded_time_and_then_is_refused', async () => {
    const base = scratch();
    try {
      const path = join(base, 'recovery.lock');
      const clock = [0.0];
      const sleeps = [];
      const first = new PeerLock(path);
      await first.enter();
      try {
        assert.equal(first.acquired, true);
        const second = new PeerLock(path, {
          wait_seconds: 1, sleep: (seconds) => { sleeps.push(seconds); clock[0] += seconds; }, monotonic: () => clock[0] });
        const held = await second.enter();
        assert.equal(held.acquired, false);
        second.exit();
        assert.ok(clock[0] <= 1.1);
      } finally {
        first.exit();
      }
      const later = await new PeerLock(path).enter();
      assert.equal(later.acquired, true);
      later.exit();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('test_the_last_outcome_is_handed_to_the_next_holder', async () => {
    const base = scratch();
    try {
      const path = join(base, 'recovery.lock');
      const holdOnce = async (action) => {
        const lock = await new PeerLock(path).enter();
        try {
          return action(lock);
        } finally {
          lock.exit();
        }
      };
      await holdOnce((first) => {
        assert.equal(first.previous, null);
        first.record(new Map([['recovered', true], ['pid', 7], ['at', pyfloat(5.0)]]));
      });
      await holdOnce((second) => {
        assert.deepEqual(plain(second.previous), { recovered: true, pid: 7, at: 5 });
        second.record(new Map([['recovered', false], ['at', pyfloat(9.0)]]));
      });
      await holdOnce((third) => assert.deepEqual(plain(third.previous), { recovered: false, at: 9 }));
      writeFileSync(path, 'not json');
      await holdOnce((fourth) => assert.equal(fourth.previous, null));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('test_the_default_lock_file_does_not_depend_on_tmpdir', async () => {
    if (process.platform === 'darwin') {
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = '/somewhere/else';
      let path;
      try {
        path = PeerLock.default_path();
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
      assert.ok(path.startsWith('/'));
      assert.ok(!path.includes('somewhere'));
      assert.ok(path.endsWith(`lcu-stale-service-recovery-${process.getuid()}.lock`));
    } else {
      assert.equal(PeerLock.default_path(), null);
    }
    // confstr failing (here: getconf unusable) means no lock file, so no lock.
    systool.override('getconf', '/nonexistent/getconf');
    try {
      assert.equal(PeerLock.default_path(), null);
      const lock = await new PeerLock().enter();
      assert.equal(lock.acquired, false);
    } finally {
      systool.reset();
    }
  });

  test('test_a_short_write_is_not_a_record', async () => {
    const base = scratch();
    try {
      const path = join(base, 'recovery.lock');
      const lock = await new PeerLock(path).enter();
      const real = stale_internals.write;
      try {
        stale_internals.write = (fd, data, offset) => real(fd, data.subarray(0, 5), offset);
        assert.equal(lock.record(new Map([['signaled', true], ['recovered', false], ['pid', 4242]])), false);
      } finally {
        stale_internals.write = real;
      }
      assert.equal(lock.record(new Map([['signaled', true]])), true);
      lock.exit();
      const again = await new PeerLock(path).enter();
      assert.deepEqual(plain(again.previous), { signaled: true });
      again.exit();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('test_an_unusable_lock_file_means_not_acquired', async () => {
    const base = scratch();
    try {
      const target = join(base, 'real');
      closeSync(openSync(target, 'w'));
      const link = join(base, 'link');
      symlinkSync(target, link);
      let lock = await new PeerLock(link).enter();
      assert.equal(lock.acquired, false, 'a symlink is never followed');
      lock = await new PeerLock(join(base, 'missing-dir', 'x.lock')).enter();
      assert.equal(lock.acquired, false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the record file is created private (0600) and holds the Python JSON text', async () => {
    // Not in the Python suite: the on-disk bytes are what an old Python release's host reads back.
    const base = scratch();
    try {
      const path = join(base, 'recovery.lock');
      const lock = await new PeerLock(path).enter();
      assert.equal(statSync(path).mode & 0o777, 0o600);
      lock.record(new Map([['pid', 4242], ['started', pyfloat(1792895400)]]));
      lock.exit();
      assert.equal(readFileSync(path, 'utf8'), '{"pid": 4242, "started": 1792895400.0}');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('SingleFlightTests', { skip }, () => {
  test('test_a_burst_of_callers_shares_one_run_and_the_next_burst_runs_again', async () => {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const runs = [];
    const work = async () => {
      runs.push(1);
      started();
      await released;
      return { ok: true, run: runs.length };
    };
    const flight = new SingleFlight(work);
    const calls = [flight.run()];
    await startedPromise;
    for (let index = 1; index < 8; index++) calls.push(flight.run());
    release();
    const results = await Promise.all(calls);
    assert.equal(runs.length, 1);
    assert.deepEqual(results, Array(8).fill({ ok: true, run: 1 }));
    assert.equal((await flight.run()).run, 2);
  });

  test('test_the_leaders_arguments_reach_the_work', async () => {
    const seen = [];
    const flight = new SingleFlight((...args) => { seen.push(args); return { ok: true }; });
    assert.deepEqual(await flight.run('leader'), { ok: true });
    assert.deepEqual(seen, [['leader']]);
  });

  test('test_a_failing_run_frees_the_flight_and_waiters_do_not_hang', async () => {
    const calls = [];
    const work = () => {
      calls.push(1);
      if (calls.length === 1) throw new Error('boom');
      return { ok: true };
    };
    const flight = new SingleFlight(work, { wait_seconds: 0.1 });
    await assert.rejects(flight.run(), /boom/);
    assert.deepEqual(await flight.run(), { ok: true });
  });

  test('a follower of a run that outlasts the wait gets the unfinished error', async () => {
    // Not in the Python suite: the bounded wait of a follower.
    let release;
    const flight = new SingleFlight(() => new Promise((resolve) => { release = () => resolve({ ok: true }); }), { wait_seconds: 0.05 });
    const leader = flight.run();
    assert.deepEqual(await flight.run(), { ok: false, error: 'The Computer Use service recovery did not finish.' });
    release();
    assert.deepEqual(await leader, { ok: true });
  });
});

describe('HostRequestTests', { skip }, () => {
  let base;
  before(() => { if (!skip) base = mkdtempSync('/tmp/lcu-hr-'); });
  after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  /** One reply line; a closed connection ends the read instead of spinning. */
  const readLine = (socket, limit = 65536) => new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 8000);
    const finish = () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); };
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.includes(10) || data.length >= limit) finish();
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', reject);
  });

  const connectTo = (address) => new Promise((resolve, reject) => {
    const socket = net.createConnection(address, () => resolve(socket));
    socket.on('error', reject);
  });

  test('test_a_slow_recovery_does_not_delay_turn_cleanup_and_sees_whether_its_requester_waits', async () => {
    const client = join(base, 'client');
    writeFileSync(client, `#!${process.execPath}\nprocess.exit(0);\n`);
    chmodSync(client, 0o755);
    // The real host loop with a slow stand-in for the recovery, so nothing real is inspected.
    const entry = join(base, 'slow_host.mjs');
    writeFileSync(entry, `import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SingleFlight, serve, stale_internals } from ${JSON.stringify(pathToFileURL(MACOS_HOST).href)};
let calls = 0;
async function slow_recovery(waiting) {
  // Each call is held until the test releases it, so no step depends on timing.
  calls += 1;
  const release = join(${JSON.stringify(base)}, 'release' + calls);
  const deadline = Date.now() + 10000;
  while (!existsSync(release) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return { ok: true, recovered: false, reason: 'fixture', waiting: waiting() };
}
stale_internals.shared_recovery = new SingleFlight(slow_recovery, { wait_seconds: 5 });
const [address, clientPath] = process.argv.slice(-2);
await serve(address, clientPath);
process.exit(0);
`);
    const [process_, temporary, address] = await start_original_host({
      node: process.execPath, client, entry, env: { ...process.env } });
    try {
      const slow = await connectTo(address);
      slow.write('{"type":"recover"}\n');
      const connection = await connectTo(address);
      connection.write('{"session_id":"s","turn_id":"t"}\n');
      assert.deepEqual(JSON.parse(await readLine(connection)), { notified: true });
      connection.destroy();
      // Only now may the recovery finish: cleanup was answered while it was held.
      writeFileSync(join(base, 'release1'), '');
      assert.deepEqual(JSON.parse(await readLine(slow)), { ok: true, recovered: false, reason: 'fixture', waiting: true });
      slow.destroy();
      // A requester that gave up (closed its end) is seen as no longer waiting.
      const gone = await connectTo(address);
      gone.write('{"type":"recover"}\n');
      gone.end(); // shutdown(SHUT_WR)
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(join(base, 'release2'), '');
      assert.equal(JSON.parse(await readLine(gone)).waiting, false);
      gone.destroy();
      // The removed read-only diagnosis is just an invalid cleanup request now.
      const diagnose = await connectTo(address);
      diagnose.write('{"type":"diagnose"}\n');
      assert.equal(JSON.parse(await readLine(diagnose)).notified, false);
      diagnose.destroy();
    } finally {
      await stop_original_host(process_, temporary);
    }
  });

  test('the recover reply is compact JSON and the connection closes after it (protocol bytes)', async () => {
    // Not in the Python suite: the exact bytes the wrapper (lcu/macos_sky_service.mjs) reads.
    const client = join(base, 'client2');
    writeFileSync(client, `#!${process.execPath}\nprocess.exit(0);\n`);
    chmodSync(client, 0o755);
    const entry = join(base, 'fixed_host.mjs');
    writeFileSync(entry, `import { SingleFlight, serve, stale_internals } from ${JSON.stringify(pathToFileURL(MACOS_HOST).href)};
stale_internals.shared_recovery = new SingleFlight(async () => ({ ok: true, recovered: true, pid: 4242, path: '/x/y', elapsed_ms: 12 }));
const [address, clientPath] = process.argv.slice(-2);
await serve(address, clientPath);
process.exit(0);
`);
    const [process_, temporary, address] = await start_original_host({
      node: process.execPath, client, entry, env: { ...process.env } });
    try {
      const socket = await connectTo(address);
      socket.write('{"type":"recover"}\n');
      const chunks = [];
      await new Promise((resolve) => { socket.on('data', (chunk) => chunks.push(chunk)); socket.on('close', resolve); });
      assert.equal(Buffer.concat(chunks).toString(), '{"ok":true,"recovered":true,"pid":4242,"path":"/x/y","elapsed_ms":12}\n');
    } finally {
      await stop_original_host(process_, temporary);
    }
  });
});
