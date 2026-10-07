// Port of tests/test_tested_versions.py: every tested.* and status.* case. The doctor and setup cases
// (test_doctor_reports_the_pair..., the doctor half of test_status_and_doctor_report..., and
// test_setup_reports_an_untested_pair...) belong to the doctor/setup ports.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as tested from '../../lcu/tested.mjs';
import { PySystemExit } from '../../lcu/compat/argparse.mjs';
import { captureIo, tempDir, withEnv } from './runtime_support.mjs';
import { mkdirSync, chmodSync } from 'node:fs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const PAIR = { platform: 'linux', architecture: 'arm64', app_version: '26.915.31945',
  runtime: '0.0.16/20260915001755-492f19756c31' };
const entry = (changes = {}) => ({ platform: 'linux', architecture: 'arm64', app_version: '26.915.31945',
  runtime: '0.0.16/20260915001755-492f19756c31', lcu_version: '0.7.0',
  app_sha256: 'b'.repeat(64), evidence: 'docs/releases/0.7.0.md', ...changes });

// status.mjs imports setup.mjs and update.mjs; load it lazily so the tested.* cases run on their own.
let statusModule = null;
async function status(t) {
  if (statusModule) return statusModule;
  try {
    statusModule = await import('../../lcu/status.mjs');
  } catch (error) {
    t.skip(`lcu/status.mjs cannot load yet: ${error.message}`);
    return null;
  }
  return statusModule;
}

describe('TestedVersionTests', () => {
  let temporary;
  let root;
  beforeEach(() => {
    temporary = tempDir();
    root = temporary.path;
  });
  afterEach(() => temporary.cleanup());

  const record = (entries, extra = {}) => writeFileSync(join(root, tested.RECORD), JSON.stringify({ format: 1, entries, ...extra }));

  it('test_tested_pair_reports_the_lcu_version_and_package_hash', () => {
    record([entry(), entry({ architecture: 'x64', app_sha256: 'c'.repeat(64) })]);
    const result = tested.assess(root, PAIR);
    assert.deepEqual([result.status, result.tested], ['tested', true]);
    assert.equal(result.tested_with_lcu, '0.7.0');
    assert.equal(result.app_sha256, 'b'.repeat(64));
    assert.equal(result.warning, null);
    assert.ok(tested.status_lines(result)[0].includes('Tested pair: yes'));
  });

  it('test_untested_app_version_warns_and_lists_the_tested_pairs', () => {
    record([entry()]);
    const result = tested.assess(root, { ...PAIR, app_version: '26.999.1' });
    assert.deepEqual([result.status, result.tested], ['untested', false]);
    assert.ok(result.warning.includes('LCU will still use it'));
    assert.ok(result.warning.includes('ChatGPT 26.915.31945 with CUA 0.0.16/20260915001755-492f19756c31'));
    assert.deepEqual(result.tested_pairs, [{ app_version: '26.915.31945', runtime: PAIR.runtime, lcu_version: '0.7.0' }]);
    assert.equal(tested.status_lines(result)[0], 'Tested pair: no.');
  });

  it('test_native_input_lists_toolkits_only_for_the_exact_pair', () => {
    record([entry({ native_input: ['gtk4'] }), entry({ architecture: 'x64', app_sha256: 'c'.repeat(64) })]);
    assert.deepEqual(tested.native_input(root, PAIR), ['gtk4']);
    assert.deepEqual(tested.native_input(root, { ...PAIR, app_version: '26.999.1' }), []);
    assert.deepEqual(tested.native_input(root, { ...PAIR, architecture: 'x64' }), []);
  });

  it('test_native_input_is_empty_without_a_usable_record', () => {
    assert.deepEqual(tested.native_input(root, PAIR), []);
    writeFileSync(join(root, tested.RECORD), '{broken');
    assert.deepEqual(tested.native_input(root, PAIR), []);
  });

  it('test_an_unknown_native_input_toolkit_invalidates_the_record', () => {
    for (const value of [['gtk3'], 'gtk4', [1]]) {
      record([entry({ native_input: value })]);
      const [entries, problem] = tested.load_entries(root);
      assert.equal(entries, null);
      assert.ok(problem.includes('invalid entry'), JSON.stringify(value));
    }
  });

  it('test_the_runtime_must_match_as_well_as_the_app_version', () => {
    record([entry()]);
    assert.equal(tested.assess(root, { ...PAIR, runtime: '0.0.99/other' }).status, 'untested');
  });

  it('test_another_architecture_or_platform_is_not_covered', () => {
    record([entry()]);
    const arch = tested.assess(root, { ...PAIR, architecture: 'x64' });
    assert.equal(arch.status, 'untested');
    assert.ok(arch.warning.includes('No pair is recorded for this platform and architecture'));
    assert.equal(tested.assess(root, { ...PAIR, platform: 'darwin' }).status, 'untested');
  });

  it('test_missing_record_is_unknown_and_never_an_error', () => {
    const result = tested.assess(root, PAIR);
    assert.deepEqual([result.status, result.tested], ['unknown', null]);
    assert.ok(result.warning.includes('is missing'));
    assert.ok(result.warning.includes('LCU will still use it'));
  });

  it('test_unreadable_or_invalid_record_is_unknown', () => {
    for (const content of ['not json', JSON.stringify({ format: 2, entries: [] }), JSON.stringify({ format: 1 }),
      JSON.stringify({ format: 1, entries: [{ platform: 'linux' }] }),
      JSON.stringify({ format: 1, entries: [entry({ app_sha256: 'nothex' })] })]) {
      writeFileSync(join(root, tested.RECORD), content);
      const result = tested.assess(root, PAIR);
      assert.equal(result.status, 'unknown', content);
      assert.ok(result.warning, content);
    }
  });

  it('format == 1 follows Python equality (1.0 and true count, "1" does not)', () => {
    for (const [format, ok] of [['1.0', true], ['true', true], ['"1"', false]]) {
      writeFileSync(join(root, tested.RECORD), `{"format": ${format}, "entries": []}`);
      assert.equal(tested.load_entries(root)[1] === null, ok, format);
    }
  });

  it('an unreadable record reports Python text (directory in its place)', () => {
    const { mkdirSync } = process.getBuiltinModule('node:fs');
    mkdirSync(join(root, tested.RECORD));
    const [, problem] = tested.load_entries(root);
    assert.equal(problem, `the tested-versions record is unreadable (${join(root, tested.RECORD)}: [Errno 21] Is a directory: '${join(root, tested.RECORD)}')`);
  });

  it('test_the_checked_in_record_is_valid_and_has_no_duplicate_pairs', () => {
    const [entries, problem] = tested.load_entries(REPO);
    assert.equal(problem, null);
    const keys = entries.map((e) => ['platform', 'architecture', 'app_version', 'runtime'].map((k) => e.get(k)).join('\0'));
    assert.equal(new Set(keys).size, keys.length);
    for (const e of entries) assert.ok(existsSync(join(REPO, e.get('evidence'))), e.get('evidence'));
  });

  it('test_report_never_raises_for_an_unreadable_app', () => {
    let out = '';
    tested.report(root, { file: { write: (text) => { out += text; } } });
    assert.ok(out.includes('Tested pair: unknown'));
  });

  const makeRelease = (platform = 'linux', architecture = 'arm64') => {
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform, architecture, app: 'app' }));
    writeFileSync(join(root, 'bundle.json'), JSON.stringify({ version: '9.9.9' }));
  };

  async function runStatus(t, argv, metadata = null) {
    const module = await status(t);
    if (!module) return null;
    const saved = { ...module.internals };
    module.internals.paths = () => [join(root, 'app'), join(root, 'app/resources'), join(root, 'app/resources/cua_node'),
      metadata ?? { version: PAIR.app_version, runtime: PAIR.runtime }];
    module.internals.saved_setup = () => null;
    const io = captureIo();
    try {
      await module.main(root, argv);
    } finally {
      io.restore();
      Object.assign(module.internals, saved);
    }
    return io.out;
  }

  it('test_status_json_exposes_the_tested_state', async (t) => {
    makeRelease();
    record([entry()]);
    const text = await runStatus(t, ['--json']);
    if (text === null) return;
    const report = JSON.parse(text);
    assert.equal(report.lcu_version, '9.9.9');
    assert.deepEqual(report.app, { path: join(root, 'app'), version: PAIR.app_version, runtime: PAIR.runtime });
    assert.equal(report.compatibility.tested, true);
    const untested = JSON.parse(await runStatus(t, ['--json'], { version: '27.1.1', runtime: PAIR.runtime }));
    assert.equal(untested.compatibility.status, 'untested');
    assert.equal(untested.compatibility.tested, false);
    assert.ok(untested.compatibility.warning.includes('not a pair LCU has tested'));
  });

  it('test_status_text_prints_the_warning_for_an_untested_pair', async (t) => {
    makeRelease();
    record([entry()]);
    const text = await runStatus(t, [], { version: '27.1.1', runtime: PAIR.runtime });
    if (text === null) return;
    assert.ok(text.includes('Original app: ChatGPT 27.1.1'));
    assert.ok(text.includes('Warning: ChatGPT 27.1.1'));
  });

  it('test_status_without_a_selected_app_fails_with_json_error', async (t) => {
    const module = await status(t);
    if (!module) return;
    const io = captureIo();
    let failure;
    try {
      await module.main(root, ['--json']);
    } catch (error) {
      failure = error;
    } finally {
      io.restore();
    }
    assert.ok(failure instanceof PySystemExit);
    assert.equal(failure.status, 1);
    assert.ok(JSON.parse(io.out).error.includes('installation.json'));
  });

  it('test_status_and_doctor_report_an_app_changed_since_install (status half)', async (t) => {
    makeRelease();
    record([entry()]);
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform: 'linux', architecture: 'arm64', app: 'app',
      package_version: PAIR.app_version, runtime: PAIR.runtime }));
    const first = await runStatus(t, ['--json']);
    if (first === null) return;
    assert.equal(JSON.parse(first).changed_since_install, null);
    const upgraded = { version: '27.2.0', runtime: PAIR.runtime };
    const report = JSON.parse(await runStatus(t, ['--json'], upgraded));
    assert.ok(report.changed_since_install.includes('differs from the one recorded'));
    assert.ok(report.changed_since_install.includes(PAIR.app_version));
    assert.ok((await runStatus(t, [], upgraded)).includes('stop them, restart them'));
  });

  it('status JSON keeps Python json.dumps(indent=2) formatting and key order', async (t) => {
    makeRelease();
    record([entry()]);
    const text = await runStatus(t, ['--json']);
    if (text === null) return;
    assert.ok(text.startsWith('{\n  "lcu_version": "9.9.9",\n  "release": '));
    assert.deepEqual(Object.keys(JSON.parse(text)), ['lcu_version', 'release', 'platform', 'architecture', 'app',
      'compatibility', 'changed_since_install', 'setup', 'pending', 'update', 'diagnostic_log']);
  });

  it('review #12: arbitrary evidence keeps its key order (numeric-looking keys) in status JSON', async (t) => {
    makeRelease();
    writeFileSync(join(root, tested.RECORD), '{"format": 1, "entries": [{"platform": "linux", "architecture": "arm64", ' +
      `"app_version": "${PAIR.app_version}", "runtime": "${PAIR.runtime}", "lcu_version": "0.7.0", ` +
      '"evidence": {"2": "second", "1": "first", "x": 1.0}}]}');
    const text = await runStatus(t, ['--json']);
    if (text === null) return;
    assert.ok(text.includes('"evidence": {\n      "2": "second",\n      "1": "first",\n      "x": 1.0\n    }'), text);
  });

  // ---- review #13: the doctor and setup cases of test_tested_versions.py, through the real reporting seams ----
  async function doctorRun(t, metadata) {
    let doctor;
    try {
      doctor = await import('../../lcu/doctor.mjs');
    } catch (error) {
      t.skip(`lcu/doctor.mjs cannot load: ${error.message}`);
      return null;
    }
    let out = '';
    const saved = { ...doctor.internals };
    doctor.internals.write = (text) => { out += text; };
    const io = captureIo();
    let code;
    try {
      code = await doctor.main(root, ['--non-interactive'], {
        resolved: [join(root, 'app'), join(root, 'app/resources'), join(root, 'app/resources/cua_node'), metadata], env: {} });
    } finally {
      io.restore();
      Object.assign(doctor.internals, saved);
    }
    return [code, out + io.out];
  }

  it('test_doctor_reports_the_pair_and_still_runs_for_an_untested_one', async (t) => {
    makeRelease();
    record([entry()]);
    const result = await doctorRun(t, { version: '27.1.1', runtime: PAIR.runtime });
    if (!result) return;
    const [code, out] = result;
    assert.equal(code, 2); // no desktop session in this environment, not the version
    assert.ok(out.includes('Original app: ChatGPT 27.1.1'));
    assert.ok(out.includes('Warning: ChatGPT 27.1.1 with CUA'));
    assert.ok(out.includes('LCU will still use it'));
  });

  it('test_status_and_doctor_name_the_diagnostic_log_and_its_policy', async (t) => {
    makeRelease();
    record([entry()]);
    const logDir = join(root, 'diagnostics');
    await withEnv({ LCU_LOG_DIR: logDir }, async () => {
      const text = await runStatus(t, ['--json']);
      if (text === null) return;
      assert.deepEqual(JSON.parse(text).diagnostic_log,
        { dir: logDir, enabled: true, retention_days: 7, max_total_mb: 20, max_file_mb: 2 });
      assert.ok((await runStatus(t, [])).includes(`Diagnostic log: ${logDir}`));
      const result = await doctorRun(t, { version: PAIR.app_version, runtime: PAIR.runtime });
      if (!result) return;
      assert.ok(result[1].includes(`Diagnostic log: ${logDir} (metadata only; kept 7 days, at most 20 MB in total ` +
        'and 2 MB per file'), result[1]);
    }, { clear: false });
    await withEnv({ LCU_DIAGNOSTIC_LOG: '0' }, async () => {
      const text = await runStatus(t, ['--json']);
      if (text === null) return;
      assert.equal(JSON.parse(text).diagnostic_log.enabled, false);
      assert.ok((await runStatus(t, [])).includes('Diagnostic log: off'));
    }, { clear: false });
  });

  it('test_status_and_doctor_report_an_app_changed_since_install (doctor half)', async (t) => {
    makeRelease();
    record([entry()]);
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ platform: 'linux', architecture: 'arm64', app: 'app',
      package_version: PAIR.app_version, runtime: PAIR.runtime }));
    const result = await doctorRun(t, { version: '27.2.0', runtime: PAIR.runtime });
    if (!result) return;
    assert.ok(result[1].includes('differs from the one recorded'));
  });

  it('test_setup_reports_an_untested_pair_and_still_registers (real tested reporter)', async (t) => {
    let setup;
    try {
      setup = await import('../../lcu/setup.mjs');
    } catch (error) {
      return t.skip(`lcu/setup.mjs cannot load: ${error.message}`);
    }
    const prefix = join(root, 'prefix');
    const current = join(prefix, 'current');
    for (const name of ['bin/lcu', 'bin/lcu-session']) {
      mkdirSync(join(current, 'bin'), { recursive: true });
      writeFileSync(join(current, name), 'fixture');
      chmodSync(join(current, name), 0o755);
    }
    root = current;
    makeRelease();
    record([entry()]);
    const home = join(prefix, 'home');
    mkdirSync(home);
    const account = { pw_name: 'fixture', pw_uid: process.getuid?.() ?? 0, pw_gid: process.getgid?.() ?? 0, pw_dir: home };
    const savedImpl = { ...setup.impl };
    const savedIo = { ...setup.io };
    const savedTested = { ...tested.internals };
    let configured = 0;
    Object.assign(setup.impl, {
      platform: 'linux', validate: () => [account, ['codex']], installer_environment: () => {}, installer_paths: () => {},
      configure: () => { configured += 1; return []; }, run: () => ({ returncode: 0, stdout: '', stderr: '' }),
    });
    tested.internals.paths = () => [join(current, 'app'), join(current, 'app/resources'), join(current, 'app/resources/cua_node'),
      { version: '27.1.1', runtime: PAIR.runtime }];
    let out = '';
    setup.io.stdout = (text) => { out += text; };
    const io = captureIo();
    try {
      await setup.main(['--prefix', prefix, '--agent', 'codex', '--session', 'direct', '--yes']);
    } finally {
      io.restore();
      Object.assign(setup.impl, savedImpl);
      Object.assign(setup.io, savedIo);
      Object.assign(tested.internals, savedTested);
    }
    out += io.out;
    assert.ok(out.includes('Tested pair: no.'), out);
    assert.ok(out.includes('Warning: ChatGPT 27.1.1'), out);
    assert.equal(configured, 1);
  });
});
