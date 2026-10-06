// The CPython 3.12 oracle for differential node tests (LCU's Python baseline: 3.12, Unicode 15.0).
// PATH's python3 may be another version (e.g. 3.14, Unicode 16), whose answers are not the baseline's.
import { spawnSync } from 'node:child_process';

const CANDIDATES = [process.env.LCU_PYTHON312, 'python3.12',
  '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', '/usr/bin/python3.12', 'python3'];

function find() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    const done = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[:2] == (3, 12))'], { encoding: 'utf8' });
    if (done.status === 0 && done.stdout.trim() === 'True') return candidate;
  }
  return null;
}

export const PYTHON = find();
