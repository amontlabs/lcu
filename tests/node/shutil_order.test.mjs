// lcu/compat/shutil.mjs rmtree removes entries in CPython 3.12.10's order (files of a directory in scan order at
// once, subdirectories last to first, depth first), so when an unreadable directory stops it, the same entries are
// left behind. Differential against the real CPython 3.12.10 on identical trees (same names, created in the same
// order, same file system).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmtree } from '../../lcu/compat/shutil.mjs';
import { python312 } from './runtime_support.mjs';
import { skippedOnWindows } from './windows_skip.mjs';

const { describe, it } = skippedOnWindows('compares rmtree order with CPython when chmod 0 makes a directory unreadable; Windows has no such permission failure');

function python31210() {
  for (const candidate of [process.env.LCU_TEST_PYTHON, process.env.LCU_PYTHON312, '/opt/cpython-3.12.10/bin/python3.12',
    python312(), 'python3.12', 'python3']) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[:3] == (3, 12, 10))'], { encoding: 'utf8' });
    if (probe.stdout?.trim() === 'True') return candidate;
  }
  return null;
}
const PYTHON = python31210();

function tree(base, spec) {
  mkdirSync(base);
  for (const [path, kind] of spec) {
    const full = join(base, path);
    if (kind === 'dir') mkdirSync(full);
    else if (kind === 'locked') {
      mkdirSync(full);
      writeFileSync(join(full, 'hidden'), 'y');
      chmodSync(full, 0);
    } else if (kind === 'link') symlinkSync('/nonexistent', full);
    else writeFileSync(full, 'x');
  }
}

function listing(base, prefix = '') {
  const out = [];
  for (const name of readdirSync(base).sort()) {
    const full = join(base, name);
    const rel = `${prefix}${name}`;
    if (!lstatSync(full).isDirectory()) {
      out.push(rel);
      continue;
    }
    try {
      out.push(`${rel}/`, ...listing(full, `${rel}/`));
    } catch (error) {
      if (error.code !== 'EACCES') throw error;
      out.push(`${rel}/ (locked)`);
    }
  }
  return out;
}

const CASES = {
  'a directory before the locked one': [['a', 'dir'], ['a/file', 'file'], ['a/hard', 'file'], ['locked', 'locked'], ['link', 'link'],
    ['top', 'file']],
  'nested directories and files': [['d1', 'dir'], ['d1/x', 'file'], ['d1/sub', 'dir'], ['d1/sub/y', 'file'], ['d2', 'dir'], ['d2/z', 'file'],
    ['d3', 'locked'], ['d4', 'dir'], ['d4/w', 'file'], ['f1', 'file'], ['f2', 'file']],
  'locked first by name': [['0locked', 'locked'], ['m', 'dir'], ['m/q', 'file'], ['z', 'dir'], ['z/r', 'file'], ['zz', 'file']],
  'everything removable': [['a', 'dir'], ['a/b', 'dir'], ['a/b/c', 'file'], ['x', 'file'], ['l', 'link']],
};

describe('rmtree order matches CPython 3.12.10', { skip: (PYTHON === null && 'needs CPython 3.12.10 (LCU_TEST_PYTHON)')
  || (process.getuid?.() === 0 && 'root can read every directory') }, () => {
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, () => {
      const base = mkdtempSync(join(tmpdir(), 'lcu-rmorder-'));
      try {
        const python = join(base, 'python');
        const node = join(base, 'node');
        tree(python, spec);
        tree(node, spec);
        const result = spawnSync(PYTHON, ['-c', 'import shutil, sys\ntry:\n    shutil.rmtree(sys.argv[1])\nexcept OSError as e:\n    print(type(e).__name__, e.filename)', python],
          { encoding: 'utf8' });
        let nodeFailure = '';
        try {
          rmtree(node);
        } catch (error) {
          nodeFailure = `${error.code} ${String(error.path)}`;
        }
        const failed = result.stdout.trim();
        assert.equal(Boolean(failed), Boolean(nodeFailure), `${failed} / ${nodeFailure}`);
        if (failed) assert.equal(failed.split(' ')[1].replace(python, node), nodeFailure.split(' ')[1]);
        assert.equal(existsSync(python), existsSync(node));
        if (existsSync(python)) assert.deepEqual(listing(node), listing(python));
      } finally {
        for (const dir of ['python', 'node']) {
          for (const sub of ['locked', '0locked', 'd3']) {
            try {
              chmodSync(join(base, dir, sub), 0o700);
            } catch { /* not there */ }
          }
        }
        rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }
});
