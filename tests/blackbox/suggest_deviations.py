#!/usr/bin/env python3
"""List what differs between A and B for every scenario dumped by `run.py --dump-diffs DIR`, field by field, in the
form deviations.py matches (field name, A text, B text), so a reviewer can write exact `before`/`after` entries.

    python3 tests/blackbox/suggest_deviations.py DIR [SCENARIO-SUBSTRING ...]   # human-readable
    python3 tests/blackbox/suggest_deviations.py --json DIR                      # [{scenario, field, before, after}]

Fields: `stdout@N` / `stderr@N` / `exit@N` per run, `recorder`, `file:<path>`; differences in the command header
lines (argv, cwd, labels) are reported as `meta` (they cannot be expected, only fixed).
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deviations  # noqa: E402


def groups(text):
    """{field name: joined text} for one rendered snapshot (same grouping as deviations._substitute_block)."""
    result, order = {}, []
    for kind, detail, run, line in deviations.tag(text):
        if kind == 'file':
            name = f'file:{detail}'
        elif kind == 'recorder':
            name = 'recorder'
        elif kind in ('stdout', 'stderr', 'exit'):
            name = f'{kind}@{run}'
        else:
            name = f'meta@{run}'
        if name not in result:
            result[name] = []
            order.append(name)
        result[name].append(line)
    return {name: '\n'.join(result[name]) for name in order}


def differences(a_text, b_text):
    a, b = groups(a_text), groups(b_text)
    out = []
    for name in list(a) + [name for name in b if name not in a]:
        if a.get(name) != b.get(name):
            out.append({'field': name, 'before': a.get(name, ''), 'after': b.get(name, '')})
    return out


def main(argv):
    as_json = '--json' in argv
    argv = [a for a in argv if a != '--json']
    root, filters = Path(argv[0]), argv[1:]
    report = []
    for folder in sorted(root.iterdir()):
        if filters and not any(f in folder.name for f in filters):
            continue
        scenario = folder.name.replace('__', '/')
        for item in differences((folder / 'A.txt').read_text(), (folder / 'B.txt').read_text()):
            report.append({'scenario': scenario, **item})
    if as_json:
        print(json.dumps(report, indent=1))
        return
    for item in report:
        print(f'=== {item["scenario"]} :: {item["field"]}')
        print('--- A')
        print(item['before'][:1500])
        print('--- B')
        print(item['after'][:1500])


if __name__ == '__main__':
    main(sys.argv[1:])
