"""The frozen Python oracle for the differential tests.

The worktree no longer contains `lcu/*.py`, so a test that compares a Node module with the Python implementation it
replaced imports that implementation from the tree `tests/blackbox/oracle.py` materialises (`git archive` of the commit
in tests/blackbox/BASE, cached by SHA), or from $LCU_ORACLE_ROOT (the Docker runners mount it at /oracle). Importing
this module puts the oracle first on sys.path, so `from lcu import platforms` is the Python 0.9.4 module. A missing
oracle is an error, never a silent skip.
"""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]


def _materialise():
    configured = os.environ.get('LCU_ORACLE_ROOT')
    if configured:
        return Path(configured)
    sys.path.insert(0, str(ROOT / 'tests/blackbox'))
    try:
        import oracle
        return Path(oracle.materialise())
    finally:
        sys.path.remove(str(ROOT / 'tests/blackbox'))
        sys.modules.pop('oracle', None)


ORACLE = _materialise()
if not (ORACLE / 'lcu/__init__.py').is_file():
    raise RuntimeError(f'The Python oracle tree has no lcu package: {ORACLE}')
if str(ORACLE) not in sys.path:
    sys.path.insert(0, str(ORACLE))
