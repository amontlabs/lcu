// The frozen Python oracle (LCU 0.9.4, the commit in tests/blackbox/BASE) for differential tests that compare a Node
// port with the Python implementation it replaced. The worktree no longer contains lcu/*.py, so differentials load the
// Python modules from the tree tests/blackbox/oracle.py materialises (`git archive BASE`, cached by SHA), or from
// $LCU_ORACLE_ROOT (the Docker runners mount it at /oracle). A missing oracle is an error, never a silent skip.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function materialise() {
  if (process.env.LCU_ORACLE_ROOT) return process.env.LCU_ORACLE_ROOT;
  const done = spawnSync('python3', [path.join(REPO, 'tests/blackbox/oracle.py')], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`The Python oracle tree could not be materialised: ${done.stderr}`);
  return done.stdout.trim();
}

export const ORACLE_ROOT = materialise();
