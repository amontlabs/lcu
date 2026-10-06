"""Reviewed, expected differences between implementation A and B (`run.py --deviations FILE`).

FILE is JSON (stdlib only, so no YAML):

    {"deviations": [
      {"id": "node-traceback",                      # unique, shown in the report
       "scenario": "cli/*",                          # glob on the scenario name
       "field": "stderr",                            # where it may differ, see FIELDS below
       "before": "exact text in A", "after": "exact text in B",          # or:
       "before_re": "regex on A", "after_re": "regex on B",
       "host": "linux",                              # optional: only when the harness runs on that OS
       "multiline": true,                            # optional: before/after span the lines of one field (below)
       "justification": "why this difference is intended (reviewed)"}]}

Fields: `stdout`, `stderr`, `exit` (the `result:` line), optionally `@N` for run N only (`stderr@2`);
`file:<glob>` (a tree entry line and its inlined content, glob on the path relative to the tree root);
`tree` (with `multiline`: the whole file-tree section as one text, for differences in the order or number of entries);
`recorder` (any recorder-log line) or `recorder:<key>` (recorder lines whose JSON key is `<key>`, e.g. an env
variable name or `argv`).

By default a pattern is matched line by line. With `"multiline": true` it is matched against the whole text of one
field instead: all lines of a run's stdout (or stderr), the whole recorder log, or one file's entry and content, joined
by newlines (so a block of lines, lines present on one side only, or a different line count can be expected).

A file that exists on one side only (an implementation-specific artifact, e.g. Python's copied relay script vs the
Node relay's code-identity stamp) uses `"only": "a"` or `"only": "b"` with a `file:<glob>` field: that side's
pattern (`before`/`before_re` for a, `after`/`after_re` for b; the other one must be "") must match the file's whole
entry block (header line and inlined content, joined by newlines) exactly / as a full regex match, the other side
must not have the file at all, and the block is then removed from that side.

Matching occurrences are replaced by the same token `<deviation ID>` on both sides, only inside that field. If the
two snapshots are then identical, the scenario is EXPECTED (never PASS) and every deviation that matched on both
sides is listed with its justification; otherwise it stays a DIFF and the raw diff is shown. Deviations that
matched nothing are reported as UNUSED.
"""
import fnmatch
import json
import re
from pathlib import Path

REQUIRED = ('id', 'scenario', 'field', 'justification')
_RUN = re.compile(r'^### run (\d+):')
_KEY = re.compile(r'^\s*"([^"]+)":')


def load(path, host=None):
    """The entries of FILE; with `host` ('linux' or 'darwin'), only those without a `host` key or with that one."""
    data = json.loads(Path(path).read_text())
    entries = data.get('deviations') if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise SystemExit(f'{path}: expected {{"deviations": [...]}}')
    seen = set()
    for entry in entries:
        missing = [key for key in REQUIRED if not isinstance(entry.get(key), str) or not entry[key].strip()]
        exact = isinstance(entry.get('before'), str) and isinstance(entry.get('after'), str)
        regex = isinstance(entry.get('before_re'), str) and isinstance(entry.get('after_re'), str)
        if missing or exact == regex:
            raise SystemExit(f'{path}: deviation {entry.get("id")!r} needs {", ".join(missing) or "fields"} and '
                             'exactly one of before/after or before_re/after_re')
        if entry.get('only') is not None:
            pattern_a = entry.get('before_re', entry.get('before'))
            pattern_b = entry.get('after_re', entry.get('after'))
            if (entry['only'] not in ('a', 'b') or not entry['field'].startswith('file:') or
                    (pattern_b if entry['only'] == 'a' else pattern_a) != '' or
                    not (pattern_a if entry['only'] == 'a' else pattern_b)):
                raise SystemExit(f'{path}: deviation {entry["id"]!r}: "only" needs "a" or "b", a file:<glob> field, '
                                 "that side's pattern and an empty pattern for the other side")
        if entry['id'] in seen:
            raise SystemExit(f'{path}: duplicate deviation id {entry["id"]!r}')
        seen.add(entry['id'])
        parse_field(entry['field'])
    return [entry for entry in entries if host is None or entry.get('host') in (None, host)]


def parse_field(field):
    if field == 'tree':
        return ('tree', None, None)
    if field.startswith('file:'):
        return ('file', field[5:], None)
    if field == 'recorder' or field.startswith('recorder:'):
        return ('recorder', field[9:] or None, None)
    name, _, run = field.partition('@')
    if name not in ('stdout', 'stderr', 'exit') or (run and not run.isdigit()):
        raise SystemExit(f'unknown deviation field {field!r}')
    return (name, None, int(run) if run else None)


def tag(text):
    """[(kind, detail, run, line)] for every line of a rendered snapshot."""
    tagged, kind, detail, run, path = [], 'meta', None, None, None
    for line in text.split('\n'):
        match = _RUN.match(line)
        if match:
            kind, run = 'meta', int(match.group(1))
        elif line.startswith('### file tree'):
            kind, run = 'file', None
        elif line.startswith('### recorder log'):
            kind, run = 'recorder', None
        elif kind in ('meta', 'stdout', 'stderr') and run is not None and line == '--- stdout ---':
            kind = 'stdout'
        elif kind in ('meta', 'stdout', 'stderr') and run is not None and line == '--- stderr ---':
            kind = 'stderr'
        if kind == 'file' and not line.startswith('### '):
            if not line.startswith('    | '):
                path = line.split('  ', 1)[0]
            tagged.append(('file', path, None, line))
        elif kind == 'recorder' and not line.startswith('### '):
            key = _KEY.match(line)
            tagged.append(('recorder', key.group(1) if key else None, None, line))
        elif kind == 'meta' and run is not None and line.startswith('result: '):
            tagged.append(('exit', None, run, line))
        else:
            tagged.append((kind if kind in ('stdout', 'stderr') else 'meta', None, run, line))
    return tagged


def _applies(field, kind, detail, run):
    want_kind, want_detail, want_run = field
    if want_kind == 'tree':
        return kind == 'file'
    if want_kind != kind:
        return False
    if want_kind == 'file':
        return detail is not None and fnmatch.fnmatchcase(detail, want_detail)
    if want_kind == 'recorder':
        return want_detail is None or detail == want_detail
    return want_run is None or want_run == run


def _substitute_block(tagged, field, pattern, token, is_regex):
    """Like _substitute, but the pattern sees each field's lines as one text (see `multiline`)."""
    groups = []   # [(kind, detail, run, [lines])] runs of consecutive lines of the same field
    for kind, detail, run, line in tagged:
        key = (kind, detail if kind == 'file' and field[0] == 'file' else None, run)
        if groups and groups[-1][0] == key and _applies(field, kind, detail, run):
            groups[-1][1].append(line)
        else:
            groups.append((key, [line], detail))
    count, out = 0, []
    for (kind, _, run), lines, detail in groups:
        if not _applies(field, kind, detail, run):
            out.extend((kind, detail, run, line) for line in lines)
            continue
        text = '\n'.join(lines)
        if is_regex:
            text, hits = re.subn(pattern, token, text, flags=re.S | re.M)
        else:
            hits = text.count(pattern)
            text = text.replace(pattern, token)
        count += hits
        out.extend((kind, detail, run, line) for line in text.split('\n'))
    return out, count


def _substitute(tagged, field, pattern, token, is_regex):
    count, out = 0, []
    for kind, detail, run, line in tagged:
        if _applies(field, kind, detail, run):
            if is_regex:
                line, hits = re.subn(pattern, token, line)
            else:
                hits = line.count(pattern)
                line = line.replace(pattern, token)
            count += hits
        out.append((kind, detail, run, line))
    return out, count


def _remove_one_sided(mine, other, field, pattern, is_regex):
    """Remove the blocks of files matching `field` from `mine` when each block fully matches `pattern` and `other`
    has no such file; returns (mine', removed count) (0 and unchanged when anything does not hold)."""
    if any(_applies(field, kind, detail, run) for kind, detail, run, _ in other):
        return mine, 0
    blocks = {}
    for kind, detail, run, line in mine:
        if _applies(field, kind, detail, run):
            blocks.setdefault(detail, []).append(line)
    if not blocks:
        return mine, 0
    for lines in blocks.values():
        text = '\n'.join(lines)
        if not (re.fullmatch(pattern, text, flags=re.S) if is_regex else text == pattern):
            return mine, 0
    return [item for item in mine if not _applies(field, *item[:3])], len(blocks)


def reconcile(scenario, left, right, entries):
    """(identical_after, used_ids, left', right') for one scenario."""
    a, b, used = tag(left), tag(right), []
    for entry in entries:
        if not fnmatch.fnmatchcase(scenario, entry['scenario']):
            continue
        field = parse_field(entry['field'])
        if entry.get('only'):
            regex = 'before_re' in entry
            if entry['only'] == 'a':
                a, hits = _remove_one_sided(a, b, field, entry['before_re' if regex else 'before'], regex)
            else:
                b, hits = _remove_one_sided(b, a, field, entry['after_re' if regex else 'after'], regex)
            if hits:
                used.append(entry['id'])
            continue
        token = f'<deviation {entry["id"]}>'
        regex = 'before_re' in entry
        substitute = _substitute_block if entry.get('multiline') else _substitute
        a, hits_a = substitute(a, field, entry['before_re' if regex else 'before'], token, regex)
        b, hits_b = substitute(b, field, entry['after_re' if regex else 'after'], token, regex)
        if hits_a and hits_b:
            used.append(entry['id'])
    left2 = '\n'.join(line for *_, line in a)
    right2 = '\n'.join(line for *_, line in b)
    return left2 == right2, used, left2, right2
