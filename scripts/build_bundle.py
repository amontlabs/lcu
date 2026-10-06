#!/usr/bin/env python3
"""Build a thin LCU archive; setup requires an app already installed locally."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

sys.dont_write_bytecode = True
from bundle import VERSION, architecture, seal, verify
from provision_agent_tools import provision as provision_agents

SOURCE = Path(__file__).resolve().parents[1]

# The docs/*.md set shipped in every archive; README rounds out the reachable
# roots for verification-record selection.
SHIPPED_DOCS = ('INSTALLATION.md', 'DEVELOPMENT.md', 'INSTRUCTIONS.md',
                'VERIFICATION.md', 'PROVENANCE.md', 'PARITY-STATUS.md',
                'STANDALONE-ADAPTATIONS.md', 'ADAPTERS.md')
_LINK = re.compile(r'\]\(([^)]+)\)')


def linked_docs(source):
    """Documents under docs/ reachable by relative .md links from the shipped docs.

    Shipping only the transitive closure keeps every relative document link in
    the archive resolvable while dropping records nothing links to.
    """
    source = Path(source)
    docs = (source / 'docs').resolve()
    roots = [source / 'README.md', *(source / 'docs' / name for name in SHIPPED_DOCS)]
    seen, linked, stack = set(), set(), [path.resolve() for path in roots]
    while stack:
        path = stack.pop()
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        for match in _LINK.finditer(path.read_text(encoding='utf-8')):
            target = match.group(1).split('#', 1)[0].strip()
            if not target or '://' in target or target.startswith('mailto:'):
                continue
            resolved = (path.parent / target).resolve()
            if resolved.suffix == '.md' and resolved.is_relative_to(docs):
                linked.add(resolved)
                stack.append(resolved)
    return linked


def linked_verification_records(source):
    verification = (Path(source) / 'docs/verification').resolve()
    return {path for path in linked_docs(source) if path.parent == verification}


OWNER_AUTH = 'lcu-owner-auth'

# The macOS app's Node is validated by the same requirement the launchers' pre-Node gate uses.
MAC_NODE_REQUIREMENT = 'anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"'
_RESOLVE_MAC_APP = (
    "import { pathToFileURL } from 'node:url';"
    "const { resolve_installed_mac_app } = await import(pathToFileURL(process.argv[1]).href);"
    "try { const app = resolve_installed_mac_app(process.argv[2], { arch: process.argv[3] });"
    " process.stdout.write(JSON.stringify({ runtime: app.runtime })); }"
    " catch (error) { process.stderr.write(String(error && error.message || error)); process.exit(1); }")


def resolve_mac_runtime(app, arch):
    """Validate a locally installed ChatGPT.app with LCU's own validator (lcu/platforms.mjs) running on that app's
    signed Node, and return its `cua_node` directory. Nothing runtime-related is imported by this build tool."""
    app = Path(app).expanduser()
    node = app / 'Contents/Resources/cua_node/bin/node'
    if app.is_symlink() or not node.is_file():
        raise ValueError(f'Expected a local ChatGPT.app directory with its bundled Node: {app}')
    signature = subprocess.run(['/usr/bin/codesign', '--verify', '--strict', f'-R={MAC_NODE_REQUIREMENT}',
                                str(node.resolve(strict=True))], capture_output=True, text=True, timeout=60)
    if signature.returncode:
        raise ValueError(f"The ChatGPT app's bundled Node is not signed by OpenAI: {signature.stderr.strip()}")
    result = subprocess.run([str(node), '--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
                             _RESOLVE_MAC_APP, str(SOURCE / 'lcu/platforms.mjs'), str(app), arch],
                            capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'The ChatGPT app could not be validated')
    return Path(json.loads(result.stdout)['runtime'])


# -- what each platform's archive ships ---------------------------------------------------------------------------
# Every lcu/*.mjs and lcu/compat/*.mjs is shared; platform-specific host modules are listed here. tests/node/
# bundle_closure.test.mjs proves that the files each platform ships contain every module its entry points can load.
LCU_ONLY = {
    'linux': ('linux_sky_service.mjs', 'session.mjs'),
    'darwin': ('macos_host.mjs', 'macos_sky_service.mjs', 'session.mjs'),
    # macos_host.mjs: windows_host.mjs imports its process/line helpers. platforms.mjs: doctor.mjs imports it.
    'windows': ('macos_host.mjs', 'windows.mjs', 'windows_host.mjs', 'windows_host_entry.cjs',
                'windows_lifetime_host.cjs', 'windows_sky_service.mjs'),
}
LCU_OTHER_PLATFORMS = {name for names in LCU_ONLY.values() for name in names}
SCRIPTS_COMMON = ('bundle_runtime.mjs', 'startup_env.mjs', 'install.mjs', 'installed_app.mjs')
SCRIPTS = {
    # install.py / install_macos.py: the names an older release's `lcu update` runs (tiny trampolines to install.sh).
    'linux': ('install.sh', 'install.py', 'install_macos.py', 'install_macos.mjs'),
    'darwin': ('install.sh', 'install.py', 'install_macos.py', 'install_macos.mjs'),
    # bundle.py: the bridge imports architecture/verify from it before the long copy.
    'windows': ('bundle.py', 'install_windows.py', 'install_windows.mjs', 'windows_launcher.py',
                'windows_launcher.mjs'),
}


def runtime_files(target, source=None):
    """Relative paths (posix) of the LCU runtime an archive for TARGET ships: lcu/, scripts/ and bin/ launchers
    (without docs, adapters, agent-tools, metadata or generated files)."""
    source = Path(source or SOURCE)
    if target not in LCU_ONLY:
        raise ValueError(f'Unknown target: {target}')
    files = []
    for path in sorted((source / 'lcu').iterdir()):
        if path.suffix in ('.mjs', '.cjs') and (path.name in LCU_ONLY[target] or path.name not in LCU_OTHER_PLATFORMS):
            files.append(f'lcu/{path.name}')
    files += [f'lcu/compat/{path.name}' for path in sorted((source / 'lcu/compat').glob('*.mjs'))]
    files += [f'scripts/{name}' for name in (*SCRIPTS[target], *SCRIPTS_COMMON)]
    files += ['bin/lcu.cmd'] if target == 'windows' else ['bin/lcu', 'bin/lcu-session']
    if target == 'linux':
        files.append('bin/lcu-codex-sandbox')
    return sorted(set(files))


def build_owner_auth(destination):
    """Compile LCU's own owner-authentication helper (used by `lcu apps`) for this Mac.

    The helper is ad-hoc signed (swiftc's linker signs it); it is LCU's code, not an OpenAI binary.
    """
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['swiftc', '-O', str(SOURCE / 'scripts/native' / (OWNER_AUTH + '.swift')),
                    '-o', str(destination)], check=True, timeout=300)
    subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'org.amontlabs.lcu-owner-auth',
                    str(destination)], check=True, timeout=60,
                   capture_output=True)
    os.chmod(destination, 0o755)


def smoke_test(release, target, node=None):
    """Import every shipped Node module and run `lcu --help` through the release's entry module. The macOS build
    uses the selected app's Node (what the installed launchers run); other builds use the `node` on PATH
    (build-time only: the installed runtime always runs on the ChatGPT app's bundled Node)."""
    node = str(node or shutil.which('node') or '')
    if not node:
        raise ValueError('A Node >= 22 is required to smoke-test the archive')
    flags = [node, '--disable-warning=ExperimentalWarning']
    modules = sorted(path.relative_to(release).as_posix() for folder in ('lcu', 'lcu/compat')
                     for path in (release / folder).glob('*.mjs') if path.name != 'entry.mjs')
    script = ("import { pathToFileURL } from 'node:url';"
              "for (const file of process.argv.slice(2)) await import(pathToFileURL(file).href);")
    subprocess.run([*flags, '--input-type=module', '-e', script, *[str(release / name) for name in modules]],
                   cwd=release, check=True, timeout=120)
    result = subprocess.run([*flags, str(release / 'lcu/entry.mjs'), 'lcu', '--help'], cwd=release,
                            capture_output=True, text=True, timeout=60)
    if result.returncode or not result.stdout.startswith('Usage: lcu'):
        raise ValueError(f'The archive failed its Node smoke test: {result.stderr.strip() or result.stdout.strip()}')


def build(output, package=None, *, target='linux', app=None):
    if package is not None:
        raise ValueError('Build-time --package is retired. Install the official app separately before LCU setup.')
    # The Windows archive contains only platform-neutral LCU source and locked
    # JavaScript dependencies. Build it on a trusted development host; the
    # Windows installer validates the registered official MSIX in place.
    arch = 'x64' if target == 'windows' else architecture(target)
    selected_node = None
    if target == 'darwin':
        policy = json.loads((SOURCE / 'runtime.lock.json').read_text())['platforms']['darwin']
        if arch not in policy.get('architectures', {}):
            raise ValueError(f'This LCU release does not support macOS {arch}.')
        selected_node = resolve_mac_runtime(app or Path('/Applications/ChatGPT.app'), arch) / 'bin/node'
    elif target not in ('linux', 'windows') or app is not None:
        raise ValueError('An installed application path is supported only for a macOS build.')
    output.mkdir(parents=True, exist_ok=True)
    name = f'lcu-{VERSION}-{target}-{arch}'
    destination = output / (name + ('.zip' if target == 'windows' else '.tar.gz'))
    if destination.exists() or destination.with_suffix(destination.suffix + '.sha256').exists():
        raise ValueError(f'Release already exists: {destination}; use a new output directory.')
    with tempfile.TemporaryDirectory(prefix='lcu-build-') as temporary:
        scratch = Path(temporary)
        release = scratch / name
        release.mkdir()
        for relative in runtime_files(target):
            destination_file = release / relative
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE / relative, destination_file)
        if target == 'darwin':
            build_owner_auth(release / 'bin' / OWNER_AUTH)
        (release / 'docs').mkdir()
        for filename in SHIPPED_DOCS:
            shutil.copy2(SOURCE / 'docs' / filename, release / 'docs' / filename)
        # Ship only documents the shipped docs link to (transitively), so every
        # relative document link resolves without carrying unlinked records.
        docs = (SOURCE / 'docs').resolve()
        for document in sorted(linked_docs(SOURCE)):
            if document.is_symlink():
                raise ValueError(f'Linked document cannot be a symlink: {document}')
            shipped = release / 'docs' / document.relative_to(docs)
            shipped.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(document, shipped)
        for filename in ('README.md', 'LICENSE', 'runtime.lock.json', 'tested-versions.json'):
            shutil.copy2(SOURCE / filename, release / filename)
        provision_agents(release, SOURCE / 'scripts/agent-tools', target=target,
                         mac_node=selected_node, adapters_source=SOURCE / 'adapters')
        smoke_test(release, target, selected_node)
        seal(release, arch, target)
        verify(release, arch, target)
        fd, temporary_archive = tempfile.mkstemp(prefix='.lcu-', suffix=destination.suffix, dir=output)
        os.close(fd)
        try:
            if target == 'windows':
                with zipfile.ZipFile(temporary_archive, 'w', compression=zipfile.ZIP_DEFLATED,
                                     compresslevel=6) as archive:
                    for path in sorted(release.rglob('*')):
                        if path.is_symlink():
                            raise ValueError(f'Windows bundle cannot contain a symlink: {path}')
                        if path.is_file():
                            archive.write(path, arcname=(Path(name) / path.relative_to(release)).as_posix())
            else:
                with tarfile.open(temporary_archive, 'w:gz', compresslevel=6) as archive:
                    archive.add(release, arcname=name)
            os.chmod(temporary_archive, 0o644)
            os.replace(temporary_archive, destination)
        finally:
            Path(temporary_archive).unlink(missing_ok=True)
    with destination.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    destination.with_suffix(destination.suffix + '.sha256').write_text(f'{digest}  {destination.name}\n')
    print(destination)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=SOURCE / 'dist')
    parser.add_argument('--package', type=Path, help='Retired; install the official app separately before LCU setup')
    parser.add_argument('--platform', choices=('linux', 'darwin', 'windows'), default='linux')
    parser.add_argument('--app', type=Path, help='Pinned locally installed ChatGPT.app for a macOS build')
    args = parser.parse_args()
    try:
        if sys.version_info < (3, 12):
            raise ValueError('Python 3.12 or later is required')
        build(args.output.resolve(), args.package.resolve() if args.package else None,
              target=args.platform, app=args.app)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        sys.exit(f'LCU build: {exc}')
