// Port of tests/test_diagnostic_log.py (all three cases): lcu/diagnostic_log.mjs must match adapters/diagnostics.mjs,
// the module that applies the policy.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as diagnostic_log from '../../lcu/diagnostic_log.mjs';
import * as adapters from '../../adapters/diagnostics.mjs';

describe('DiagnosticLogTests', () => {
  it('test_constants_match_the_javascript_module', () => {
    assert.equal(diagnostic_log.RETENTION_DAYS, adapters.RETENTION_DAYS);
    assert.equal(diagnostic_log.MAX_TOTAL_MB * 1024 * 1024, adapters.MAX_TOTAL_BYTES);
    assert.equal(diagnostic_log.MAX_FILE_MB * 1024 * 1024, adapters.MAX_FILE_BYTES);
  });

  it('test_directory_follows_platform_xdg_and_override', () => {
    const home = '/h';
    assert.equal(diagnostic_log.directory({}, 'darwin', home), '/h/Library/Logs/LCU');
    assert.equal(diagnostic_log.directory({}, 'linux', home), '/h/.local/state/lcu/logs');
    assert.equal(diagnostic_log.directory({ XDG_STATE_HOME: '/s' }, 'linux', home), '/s/lcu/logs');
    assert.equal(diagnostic_log.directory({ LCU_LOG_DIR: '/o', XDG_STATE_HOME: '/s' }, 'darwin', home), '/o');
    // The same answers as the adapters' module that writes the log.
    for (const [env, platform] of [[{}, 'darwin'], [{}, 'linux'], [{ XDG_STATE_HOME: '/s' }, 'linux'], [{ LCU_LOG_DIR: '/o' }, 'linux']]) {
      assert.equal(diagnostic_log.directory(env, platform, home), adapters.diagnosticLogDirectory({ env, platform, home }));
    }
  });

  it('test_disabling_is_reported', () => {
    assert.equal(diagnostic_log.status({}, 'linux', '/h').enabled, true);
    assert.equal(diagnostic_log.status({ LCU_DIAGNOSTIC_LOG: '0' }, 'linux', '/h').enabled, false);
  });

  it('status key order and the summary text are Python\'s', () => {
    assert.deepEqual(Object.keys(diagnostic_log.status({}, 'linux', '/h')),
      ['dir', 'enabled', 'retention_days', 'max_total_mb', 'max_file_mb']);
    assert.equal(diagnostic_log.summary({}, 'linux', '/h'), 'Diagnostic log: /h/.local/state/lcu/logs (metadata only; ' +
      'kept 7 days, at most 20 MB in total and 2 MB per file; LCU_DIAGNOSTIC_LOG=0 turns it off).');
    assert.equal(diagnostic_log.summary({ LCU_DIAGNOSTIC_LOG: '0' }), 'Diagnostic log: off (LCU_DIAGNOSTIC_LOG=0).');
  });
});
