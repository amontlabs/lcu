#!/usr/bin/env python3
"""Black-box differential harness: run every scenario against implementation A and B and diff the snapshots.

    python3 tests/blackbox/run.py                      # oracle (A) vs this worktree (B)
    python3 tests/blackbox/run.py --a X --b Y -k mcp   # any two roots, scenarios matching a substring/glob
    python3 tests/blackbox/run.py --list
    python3 tests/blackbox/run.py --golden             # write A's snapshots to tests/blackbox/golden/<platform>/
"""
import argparse
import difflib
import fcntl
import fnmatch
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import traceback

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import coverage
import deviations
import oracle
import sandbox
from scenarios import load

WORKTREE = HERE.parents[1]


def host():
    return 'darwin' if sys.platform == 'darwin' else 'linux'


def _matches(name, pattern):
    """A glob (contains * ? [) must match the whole name; anything else is a name PREFIX ('mcp' selects mcp/...,
    never rt/mac/...mcp...). Use '*text*' for substring matching."""
    return fnmatch.fnmatchcase(name, pattern) if any(c in pattern for c in '*?[') else name.startswith(pattern)


def selected(registry, patterns, excludes=()):
    chosen = []
    for name, entry in sorted(registry.items()):
        if patterns and not any(_matches(name, p) for p in patterns):
            continue
        if any(_matches(name, p) for p in excludes):
            continue
        chosen.append(entry)
    return chosen


def execute(entry, impl_root, keep=False, extra_env=None):
    """Run one scenario in a fresh sandbox against one implementation and return its rendered snapshot."""
    name = entry.name.replace('/', '__')
    # Sandboxes live at fixed absolute paths, so concurrent harness runs (other agents, CI) take turns per scenario.
    sandbox.BASE.mkdir(parents=True, exist_ok=True)
    lock = open(sandbox.BASE / f'.lock-{name}', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX)
    sb = sandbox.Sandbox(name, impl_root, account_home=entry.account_home, extra_env=extra_env)
    try:
        entry.fn(sb)
        return sb.finish(entry.normalise)
    except Exception:
        return 'HARNESS ERROR\n' + traceback.format_exc()
    finally:
        if not keep:
            shutil.rmtree(sb.root, ignore_errors=True)
        lock.close()


def run_coverage(chosen, root_a, keep):
    scratch = Path(tempfile.mkdtemp(prefix='lcu-bb-cov-'))
    pythonpath, hits = coverage.prepare(scratch)
    extra = {'PYTHONPATH': pythonpath, 'LCU_BB_COV_DIR': str(hits), 'LCU_BB_COV_ROOT': str(sandbox.BASE)}
    ran = 0
    for entry in chosen:
        if (host() not in entry.hosts or (entry.account_home and os.environ.get('LCU_BB_DISPOSABLE') != '1')
                or entry.needs_root != (os.getuid() == 0)):
            print(f'SKIP {entry.name}')
            continue
        execute(entry, root_a, keep, extra_env=extra)
        ran += 1
        print(f'TRACED {entry.name}')
    data_dir = WORKTREE / '.port/coverage-data'
    data_dir.mkdir(parents=True, exist_ok=True)
    mine = coverage.collect(hits)
    (data_dir / f'{host()}.json').write_text(json.dumps(
        {'host': host(), 'scenarios': ran, 'lines': {k: sorted(v) for k, v in sorted(mine.items())}}, indent=0))
    shutil.rmtree(scratch, ignore_errors=True)
    return write_coverage_report(root_a)


def write_coverage_report(root_a):
    """Merge every .port/coverage-data/<host>.json and write .port/coverage.md."""
    data_dir = WORKTREE / '.port/coverage-data'
    merged, hosts, total = {}, set(), 0
    for dump in sorted(data_dir.glob('*.json')):
        record = json.loads(dump.read_text())
        hosts.add(record['host'])
        total += record['scenarios']
        for relative, lines in record['lines'].items():
            merged.setdefault(relative, set()).update(lines)
    (WORKTREE / '.port/coverage.md').write_text(coverage.report(root_a, merged, hosts, total))
    print(f'wrote .port/coverage.md from {sorted(hosts)}')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--a', type=Path, help='implementation root A (default: the oracle at tests/blackbox/BASE)')
    parser.add_argument('--b', type=Path, help='implementation root B (default: this worktree)')
    parser.add_argument('-k', action='append', default=[], metavar='PATTERN',
                        help='run scenarios whose name starts with PATTERN, or matches it as a glob (*x* for substring); repeatable')
    parser.add_argument('-x', '--exclude', action='append', default=[], metavar='PATTERN',
                        help='skip scenarios matching PATTERN (same matching as -k); repeatable')
    parser.add_argument('--list', action='store_true', help='list scenarios and exit')
    parser.add_argument('--keep', action='store_true', help='leave the last sandboxes under /tmp/lcu-bb for inspection')
    parser.add_argument('--golden', action='store_true', help="write A's snapshots to tests/blackbox/golden/<platform>/")
    parser.add_argument('--node', help='Node to run every fake app/recorder on (path or command; default: node on PATH); '
                        'e.g. --node ~/.nvm/versions/node/v22.0.0/bin/node')
    parser.add_argument('--b-overlay', type=Path, metavar='DIR',
                        help="copy DIR's files over B's tree (in a temporary copy) before running, to try an in-progress entry point")
    parser.add_argument('--coverage', action='store_true',
                        help='run the oracle only, trace which Python it executes, merge into .port/coverage-data/ and '
                             'write .port/coverage.md')
    parser.add_argument('--coverage-report', action='store_true',
                        help='only re-render .port/coverage.md from the saved .port/coverage-data/*.json')
    parser.add_argument('--deviations', type=Path, metavar='FILE',
                        help='reviewed JSON allowlist of expected A/B differences (see deviations.py); matching '
                             'scenarios are reported as EXPECTED with their justification, never as PASS')
    parser.add_argument('--runs', type=int, default=1, help='repeat B this many times (determinism check); default 1')
    parser.add_argument('--dump-diffs', type=Path, metavar='DIR',
                        help="write A's and the first differing B snapshot of every DIFF scenario to DIR/<scenario>/{A,B}.txt "
                             '(input of suggest_deviations.py)')
    args = parser.parse_args(argv)

    if args.node:
        resolved = shutil.which(os.path.expanduser(args.node))
        if not resolved:
            parser.error(f'--node {args.node}: not found')
        os.environ['LCU_BB_NODE'] = resolved
    registry = load()
    chosen = selected(registry, args.k, args.exclude)
    if args.list:
        for entry in chosen:
            state = 'runs here' if host() in entry.hosts else 'skipped on ' + host()
            print(f'{entry.name:40} hosts={",".join(entry.hosts):14} {state}')
        return 0
    root_a = args.a.resolve() if args.a else oracle.materialise()
    root_b = args.b.resolve() if args.b else WORKTREE
    if args.b_overlay:
        overlay_root = Path(tempfile.mkdtemp(prefix='lcu-bb-overlay-'))
        shutil.copytree(root_b, overlay_root / 'tree', symlinks=True,
                        ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__', '.claude'))
        shutil.copytree(args.b_overlay.resolve(), overlay_root / 'tree', symlinks=True, dirs_exist_ok=True)
        root_b = overlay_root / 'tree'
    if args.coverage_report:
        return write_coverage_report(root_a)
    if args.coverage:
        return run_coverage(chosen, root_a, args.keep)
    allowed = deviations.load(args.deviations, host()) if args.deviations else []
    expected, expected_ids = 0, {}
    failures = 0
    skipped = 0
    for entry in chosen:
        if host() not in entry.hosts:
            skipped += 1
            print(f'SKIP {entry.name} (hosts: {", ".join(entry.hosts)})')
            continue
        if entry.account_home and os.environ.get('LCU_BB_DISPOSABLE') != '1':
            skipped += 1
            print(f'SKIP {entry.name} (writes the account home; runs only via docker.sh)')
            continue
        if entry.needs_root != (os.getuid() == 0):
            skipped += 1
            print(f'SKIP {entry.name} ({"needs root: docker.sh --root" if entry.needs_root else "not a root scenario"})')
            continue
        left = execute(entry, root_a, args.keep)
        if args.golden:
            target = HERE / 'golden' / host() / (entry.name.replace('/', '__') + '.txt')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(left)
            print(f'GOLDEN {entry.name} -> {target.relative_to(HERE)}')
            continue
        bad = left.startswith('HARNESS ERROR')
        diff = []
        used = set()
        for attempt in range(args.runs):
            right = execute(entry, root_b, args.keep)
            if right != left:
                if allowed and not right.startswith('HARNESS ERROR'):
                    same, ids, _, _ = deviations.reconcile(entry.name, left, right, allowed)
                    if same and ids:
                        used.update(ids)
                        continue
                diff = list(difflib.unified_diff(left.splitlines(True), right.splitlines(True),
                                                 f'A: {root_a}', f'B: {root_b}', n=3))
                break
        if bad:
            print(f'ERROR {entry.name}\n{left}')
            failures += 1
        elif not diff and used:
            expected += 1
            for ident in sorted(used):
                expected_ids.setdefault(ident, []).append(entry.name)
            print(f'EXPECTED {entry.name} (deviations: {", ".join(sorted(used))})')
        elif diff:
            failures += 1
            if args.dump_diffs:
                target = args.dump_diffs / entry.name.replace('/', '__')
                target.mkdir(parents=True, exist_ok=True)
                (target / 'A.txt').write_text(left)
                (target / 'B.txt').write_text(right)
            print(f'DIFF {entry.name}')
            sys.stdout.writelines(diff if diff[-1].endswith('\n') else diff + ['\n'])
        else:
            print(f'PASS {entry.name}')
    total = len(chosen) - skipped
    if args.golden:
        print(f'\n{total} goldens written, {skipped} skipped')
        return 0
    if allowed:
        by_id = {entry['id']: entry for entry in allowed}
        print('\nExpected deviations applied (reviewed allowlist ' + str(args.deviations) + '):')
        for ident, names in sorted(expected_ids.items()):
            print(f'  {ident}: {by_id[ident]["justification"]}\n    scenarios: {", ".join(names)}')
        for ident in sorted(set(by_id) - set(expected_ids)):
            print(f'  UNUSED {ident} ({by_id[ident]["scenario"]}, {by_id[ident]["field"]})')
    print(f'\n{total - failures - expected}/{total} identical, {expected} expected deviations, '
          f'{failures} differing, {skipped} skipped')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
