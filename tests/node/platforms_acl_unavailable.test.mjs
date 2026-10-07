// With no trusted ACL reader (neither getfacl nor /usr/bin/python3), Linux ACLs cannot be judged: the trust
// check refuses (fail closed) instead of trusting the entries. Off Linux no ACL is read, as in Python.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import { internals, _check_trusted_tree, _posix_acl } from '../../lcu/platforms.mjs';
import { ValueError } from '../../lcu/compat/pyjson.mjs';
import { AclReaderUnavailableError } from '../../lcu/compat/acl.mjs';
import { _testing } from '../../lcu/compat/systool.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { it } = skippedOnWindows('Linux POSIX ACL reading (getfacl); never runs on Windows');

const saved = { ...internals };
after(() => {
  Object.assign(internals, saved);
  _testing.reset();
});

it('refuses when ACLs cannot be read on Linux, and ignores ACLs elsewhere', () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-platforms-noacl-')));
  try {
    const app = path.join(base, 'app');
    mkdirSync(app);
    const file = path.join(app, 'file');
    writeFileSync(file, 'x');
    chmodSync(file, 0o755);
    _testing.override('getfacl', path.join(base, 'missing-getfacl'));
    _testing.override('python3', path.join(base, 'missing-python3'));
    const trusted = new Set([0, process.getuid?.()]);
    internals.platform = () => 'linux';
    assert.throws(() => _posix_acl(file), AclReaderUnavailableError);
    assert.throws(() => _check_trusted_tree(app, [file], [], trusted), (error) => {
      assert.ok(error instanceof ValueError);
      assert.match(error.message, /^The application is not in a location only root and this account can change: .* cannot be inspected \(cannot inspect POSIX ACLs .*\)\. Install the app/);
      return true;
    });
    internals.platform = () => 'darwin';
    assert.equal(_posix_acl(file), null);
    _check_trusted_tree(app, [file], [], trusted);
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
