"""Install LCU's `lcu-approve` mod for Claude Code.

The mod shows the computer-use runtime's per-app approval as a native pane (or
question dialog) in the terminal and in the Claude app's Code tab, where the
host cannot render the runtime's MCP form. It is a plugin folder under the
`skills` directory, which Claude Code loads without a hot-reload question and
watches for changes: `~/.claude/skills/lcu-approve` for user scope and
`<project>/.claude/skills/lcu-approve` for project scope.
"""
import json
from pathlib import Path

NAME = 'lcu-approve'
SOURCE = Path('adapters/claude-mod') / NAME
MANIFEST = Path('.claude-plugin/plugin.json')
# Written beside the mod at install time: where the `lcu` command of this installation is.
CONFIG = Path('lcu.json')


def source_files(release_root):
    """Relative paths and contents of the mod shipped in a release."""
    root = Path(release_root) / SOURCE
    if not (root / MANIFEST).is_file():
        raise ValueError(f'LCU Claude mod missing: {root}. Reinstall LCU into this release prefix, then rerun setup.')
    # The mod's own tests (run by `claude plugin test`) stay in the repository.
    return {path.relative_to(root): path.read_bytes() for path in sorted(root.rglob('*'))
            if path.is_file() and path.relative_to(root).parts[0] != 'tests' and path.name != '.DS_Store'}


def lcu_command(release_root):
    """The stable `lcu` path of an installation: through `current` when the release sits in a prefix."""
    root = Path(release_root)
    if root.parent.name == 'releases':
        root = root.parent.parent / 'current'
    return root / 'bin' / 'lcu'


def destination(home, project=None):
    base = Path(project) / '.claude' if project else Path(home) / '.claude'
    return base / 'skills' / NAME


def _owned(path):
    """True when the folder holds LCU's mod (never touch a plugin of that name that is not ours)."""
    try:
        return json.loads((path / MANIFEST).read_text()).get('name') == NAME
    except (OSError, ValueError, AttributeError):
        return False


def install(home, release_root, *, project=None):
    """Copy the mod into the selected scope's skills folder; returns the folder."""
    from .setup import Change, apply_changes, read_file
    target = destination(home, project)
    if target.exists() and not _owned(target):
        raise ValueError(f'{target} exists and is not the LCU mod; move it aside, then rerun setup.')
    files = source_files(release_root)
    # The approved-apps panel runs `lcu apps`; this is where it finds the command.
    files[CONFIG] = (json.dumps({'lcu': str(lcu_command(release_root))}, indent=2) + '\n').encode()
    changes = [Change(target / relative, read_file(target / relative), data)
               for relative, data in files.items()]
    apply_changes(changes)
    # Drop files an earlier release shipped and this one does not.
    if target.is_dir():
        for path in sorted(target.rglob('*'), reverse=True):
            relative = path.relative_to(target)
            if path.is_file() and relative not in files:
                path.unlink()
            elif path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    return target


def remove(home, *, project=None):
    """Remove the mod from the selected scope; returns whether anything was removed."""
    target = destination(home, project)
    if not target.exists():
        return False
    if not _owned(target):
        raise ValueError(f'{target} is not the LCU mod; left in place.')
    for path in sorted(target.rglob('*'), reverse=True):
        if path.is_symlink() or path.is_file():
            path.unlink()
        else:
            path.rmdir()
    target.rmdir()
    return True
