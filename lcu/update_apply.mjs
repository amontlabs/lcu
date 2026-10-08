// `lcu update` apply step: fetch the release archive, verify it, and run its installer on this release's Node.
//
// Downloads only LCU's own release archive. The official app is never fetched or touched; the new installer
// reuses the app the installation already points at. Agent registrations point at `<prefix>/current` (or
// `<prefix>\lcu.cmd`), so a runtime-only reinstall keeps them working; setup is not re-run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import { request, testSource } from './update.mjs';

export const DOWNLOAD = 'https://github.com/amontlabs/lcu/releases/download';
const TIMEOUT = 60;

/** What tests replace. */
export const deps = {
  run(command) {
    // A .cmd launcher runs through cmd.exe: Node does not start batch files directly.
    const result = command[0].endsWith('.cmd')
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command.map((part) => `"${part}"`).join(' ')}"`],
        { stdio: 'inherit', windowsVerbatimArguments: true })
      : spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
    return result.status ?? 1;
  },
  download: async (url) => {
    const source = testSource();
    if (source) return readFileSync(join(source, ...url.slice(DOWNLOAD.length + 1).split('/')));
    return (await request(url, { limit: Infinity, timeout: TIMEOUT * 30 })).body;
  },
  interactive: () => process.stdin.isTTY,
  writable: (path) => { try { accessSync(path, constants.W_OK); return true; } catch { return false; } },
  uid: () => process.getuid?.() ?? null,
  print: (text) => process.stdout.write(text),
  report: (text) => process.stderr.write(text),
};

function readJson(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Malformed ${path}`);
  return data;
}

/** Release archive name for one platform and architecture. */
export function assetName(version, platform, arch) {
  if (!['darwin', 'linux', 'windows'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`No LCU release archive for ${platform} ${arch}.`);
  }
  return `lcu-${version}-${platform}-${arch}${platform === 'windows' ? '.zip' : '.tar.gz'}`;
}

/** `[prefix, bundle, installation]` for a release directory, or throws. */
function layout(rootPath) {
  if (!existsSync(join(rootPath, 'bundle.json'))) {
    throw new Error('This LCU is a source checkout; `lcu update` only updates an installed release. ' +
      'Rebuild from source or install a release archive.');
  }
  const root = realpathSync(rootPath);
  const prefix = dirname(dirname(root));
  if (basename(dirname(root)) !== 'releases' || !existsSync(join(prefix, '.lcu-install'))) {
    throw new Error(`${root} is not inside an LCU installation prefix (<prefix>/releases/<name>); update refused.`);
  }
  return [prefix, readJson(join(root, 'bundle.json')), readJson(join(root, 'installation.json'))];
}

/** The new release's installer, run on this release's Node, reproducing the existing install (runtime only). */
export function installerCommand(platform, prefix, installation, source, node = process.execPath) {
  if (platform === 'windows') return [node, join(source, 'scripts/install_windows.mjs'), '--prefix', prefix, '--runtime-only'];
  const command = [node, join(source, 'scripts/install.mjs'), '--prefix', prefix, '--runtime-only'];
  const app = installation.app;
  if (typeof app === 'string' && posix.isAbsolute(app) && existsSync(app)) command.push('--existing-app', app);
  // apt cannot run unattended; system libraries stay as installed.
  if (platform === 'linux') command.push('--skip-system');
  return command;
}

/** The digest a `.sha256` file gives for `name`. */
export function expectedSha256(text, name) {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (/^[0-9a-fA-F]{64}$/.test(parts[0]) && (parts.length === 1 || parts.at(-1).replace(/^\*/, '') === name)) {
      return parts[0].toLowerCase();
    }
  }
  throw new Error(`Malformed checksum file for ${name}.`);
}

const unsafe = (name) => !name || posix.isAbsolute(name) || win32.isAbsolute(name) || /^[A-Za-z]:/.test(name) ||
  name.split(/[\\/]/).includes('..');

/** Entries of a gzip-compressed tar: `{name, type: file|directory|symlink|hardlink, mode, data, link}`. */
export function tarEntries(archive) {
  const data = gunzipSync(archive);
  const entries = [];
  const text = (start, length) => data.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '');
  const octal = (start, length) => parseInt(text(start, length).trim() || '0', 8);
  let pax = {};
  let longName = null;
  let longLink = null;
  for (let offset = 0; offset + 512 <= data.length;) {
    if (data.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = octal(offset + 124, 12);
    const flag = String.fromCharCode(data[offset + 156] || 48);
    const body = data.subarray(offset + 512, offset + 512 + size);
    const prefix = text(offset + 345, 155);
    const header = { name: (prefix ? `${prefix}/` : '') + text(offset, 100), link: text(offset + 157, 100), mode: octal(offset + 100, 8) };
    offset += 512 + Math.ceil(size / 512) * 512;
    if (flag === 'x') {
      for (const record of body.toString('utf8').matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[record[1]] = record[2];
      continue;
    }
    if (flag === 'g') continue;
    if (flag === 'L' || flag === 'K') {
      const value = body.toString('utf8').replace(/\0[\s\S]*$/, '');
      if (flag === 'L') longName = value;
      else longLink = value;
      continue;
    }
    const type = { 0: 'file', 7: 'file', 5: 'directory', 2: 'symlink', 1: 'hardlink' }[flag];
    const name = pax.path ?? longName ?? header.name;
    if (!type) throw new Error(`Unsupported entry in archive: ${name}`);
    entries.push({ name, type, mode: header.mode, data: type === 'file' ? body : null, link: pax.linkpath ?? longLink ?? header.link });
    pax = {};
    longName = longLink = null;
  }
  return entries;
}

/** Entries of a zip archive, as `tarEntries` gives them. */
export function zipEntries(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('The archive is not a zip file.');
  const entries = [];
  let at = archive.readUInt32LE(end + 16);
  for (let count = archive.readUInt16LE(end + 10); count > 0; count -= 1) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip directory is corrupt.');
    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extra = archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
    const attributes = archive.readUInt32LE(at + 38);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra;
    if (((attributes >>> 16) & 0o170000) === 0o120000) throw new Error(`Unsafe entry in archive: ${name}`);
    if (name.endsWith('/')) {
      entries.push({ name, type: 'directory', mode: 0o755 });
      continue;
    }
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(start, start + compressed);
    if (![0, 8].includes(method)) throw new Error(`Unsupported compression in archive: ${name}`);
    entries.push({ name, type: 'file', mode: 0o644, data: method === 8 ? inflateRawSync(raw) : raw });
  }
  return entries;
}

/** Write checked entries under `destination`; refuses paths and links that leave it, and special files. */
export function extract(entries, destination) {
  for (const entry of entries) {
    if (unsafe(entry.name)) throw new Error(`Unsafe path in archive: ${entry.name}`);
    if (entry.type === 'symlink' || entry.type === 'hardlink') {
      const base = entry.type === 'symlink' ? posix.dirname(entry.name) : '';
      const resolved = posix.normalize(posix.join(base, entry.link));
      if (posix.isAbsolute(entry.link) || /^[A-Za-z]:/.test(entry.link) || resolved === '..' || resolved.startsWith('../')) {
        throw new Error(`Archive link escapes the release: ${entry.name}`);
      }
    }
  }
  for (const entry of entries) {
    const path = join(destination, ...entry.name.split('/').filter(Boolean));
    mkdirSync(entry.type === 'directory' ? path : dirname(path), { recursive: true });
    if (entry.type === 'file') {
      writeFileSync(path, entry.data);
      if (process.platform !== 'win32') chmodSync(path, entry.mode & 0o755);
    } else if (entry.type === 'symlink') {
      symlinkSync(entry.link, path);
    } else if (entry.type === 'hardlink') {
      copyFileSync(join(destination, ...entry.link.split('/').filter(Boolean)), path);
    }
  }
}

/** Download, verify and extract the archive; returns the extracted release directory. */
export async function download(info, name, directory) {
  const base = `${DOWNLOAD}/${info.tag}/${name}`;
  deps.report(`Downloading ${base}\n`);
  const archive = await deps.download(base);
  const expected = expectedSha256((await deps.download(`${base}.sha256`)).toString('utf8'), name);
  if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error(`Checksum mismatch for ${name}; refusing to install it.`);
  const extracted = join(directory, 'extract');
  mkdirSync(extracted);
  extract(name.endsWith('.zip') ? zipEntries(archive) : tarEntries(archive), extracted);
  const source = join(extracted, name.replace(/\.(zip|tar\.gz)$/, ''));
  if (!existsSync(join(source, 'bundle.json'))) throw new Error('The archive does not contain an LCU release bundle.');
  return source;
}

const quote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

/** Update the installation containing `root`; returns an exit status. */
export async function apply(root, info, { yes = false } = {}) {
  let prefix, bundle, installation, platform, name;
  try {
    [prefix, bundle, installation] = layout(root);
    platform = installation.platform ?? 'linux';
    name = assetName(info.version, platform, installation.architecture ?? bundle.architecture);
  } catch (error) {
    deps.report(`lcu update: ${error.message}\n`);
    return 1;
  }
  const lcu = join(prefix, platform === 'windows' ? 'lcu.cmd' : 'current/bin/lcu');
  deps.print(`LCU update: ${bundle.version} -> ${info.version}\n  prefix:  ${prefix}\n  archive: ${name}\n` +
    `  release: ${info.release_url ?? ''}\n`);
  if (!yes) {
    if (!deps.interactive()) {
      deps.report(`Not interactive; nothing changed. To apply, run:\n  ${quote(lcu)} update --yes\n`);
      return 2;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('Proceed? [y/N] ');
    prompt.close();
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      deps.print('Cancelled.\n');
      return 1;
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), 'lcu-update-'));
  let keep = false;
  try {
    const source = await download(info, name, temporary);
    const command = installerCommand(platform, prefix, installation, source);
    if (platform === 'linux') {
      const uid = deps.uid();
      const user = uid === 0 ? process.env.SUDO_USER : null;
      if (uid === 0 && !user) {
        deps.report('lcu update: running as root without SUDO_USER; run it as the desktop account through sudo or as that account.\n');
        return 1;
      }
      if (uid !== 0 && ![prefix, join(prefix, '.lcu-install'), join(prefix, 'releases')].every(deps.writable)) {
        keep = true;
        deps.report(`${prefix} is not writable by this account. The verified release is at ${source}; install it with:\n` +
          `  sudo ${[...command, '--user', userInfo().username].map(quote).join(' ')}\nThen delete ${temporary}.\n`);
        return 1;
      }
      if (user) command.push('--user', user);
    }
    const status = deps.run(command);
    if (status) {
      deps.report(`lcu update: the installer failed (exit ${status}); the previous release stays current.\n`);
      return status;
    }
    // The new release refreshes what setup copied out of the old one (the Claude mod, the Chrome relay).
    if (deps.run([lcu, 'update', '--post-install'])) {
      deps.report(`lcu update: could not refresh harness integrations; rerun \`${lcu} setup\` for your agents.\n`);
    }
    deps.print(`LCU ${info.version} installed. Restart agents that use LCU so they load the new release.\n` +
      `To reclaim space from superseded releases, run: ${quote(lcu)} prune\n`);
    return 0;
  } catch (error) {
    deps.report(`lcu update: ${error.message}\n`);
    return 1;
  } finally {
    if (!keep) rmSync(temporary, { recursive: true, force: true });
  }
}
