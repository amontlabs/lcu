// Port of tests/test_claude_mod.py.
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import test from 'node:test';

import { ROOT, lcu, tempdir } from './p4_support.mjs';

const claude_mod = await lcu('claude_mod');
const MOD = `${ROOT}/adapters/claude-mod/lcu-approve`;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function walkFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(`${root}/${prefix}`, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, relative));
    else if (statSync(`${root}/${relative}`).isFile()) out.push(relative);
  }
  return out;
}
const snapshot = (root) => Object.fromEntries(walkFiles(root).map((rel) => [rel, readFileSync(`${root}/${rel}`).toString('hex')]));

function setup(t) {
  const temporary = tempdir(t);
  const home = `${temporary}/home`;
  mkdirSync(home);
  return { temporary, home };
}

test('shipped mod is a function hook plugin for the lcu server', () => {
  const manifest = read(`${MOD}/.claude-plugin/plugin.json`);
  assert.equal(manifest.name, claude_mod.NAME);
  assert.deepEqual(read(`${MOD}/hooks/hooks.json`), { modules: ['./register.tsx'] });
  const source = readFileSync(`${MOD}/hooks/register.tsx`, 'utf8');
  assert.ok(source.includes("const SERVER = 'lcu'"));
  for (const event of ["'classic.Elicitation'", "'tool.call'", "'tool.check'", "'ui.render'"]) assert.ok(source.includes(event));
  for (const label of ['Allow this conversation', 'Always allow', 'Deny']) {
    assert.ok(readFileSync(`${MOD}/hooks/views.tsx`, 'utf8').includes(label));
  }
  assert.ok(source.includes("'computer-use-apps'"));
});

test('user scope install is idempotent and omits the mod tests', (t) => {
  const { home } = setup(t);
  const target = claude_mod.install(home, ROOT);
  assert.equal(target, `${home}/.claude/skills/lcu-approve`);
  assert.deepEqual(new Set(walkFiles(target)), new Set(['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx',
    'hooks/views.tsx', 'hooks/data.ts', 'types/index.d.ts', 'lcu.json']));
  const before = snapshot(target);
  claude_mod.install(home, ROOT);
  assert.deepEqual(snapshot(target), before);
});

test('install records where the lcu command is', (t) => {
  const { temporary, home } = setup(t);
  let target = claude_mod.install(home, ROOT);
  assert.deepEqual(read(`${target}/lcu.json`), { lcu: `${ROOT}/bin/lcu` });
  const release = `${temporary}/prefix/releases/1.0-abc`;
  cpSync(MOD, `${release}/${claude_mod.SOURCE}`, { recursive: true, filter: (src) => !src.split('/').includes('tests') });
  target = claude_mod.install(home, release);
  assert.deepEqual(read(`${target}/lcu.json`), { lcu: `${temporary}/prefix/current/bin/lcu` });
  // The written bytes are json.dumps(..., indent=2) + '\n'.
  assert.equal(readFileSync(`${target}/lcu.json`, 'utf8'), `{\n  "lcu": "${temporary}/prefix/current/bin/lcu"\n}\n`);
});

test('project scope installs under the project and not the home', (t) => {
  const { temporary, home } = setup(t);
  const project = `${temporary}/project`;
  mkdirSync(project);
  const target = claude_mod.install(home, ROOT, { project });
  assert.equal(target, `${project}/.claude/skills/lcu-approve`);
  assert.equal(existsSync(`${home}/.claude`), false);
});

test('reinstall replaces changed files and drops files a release no longer ships', (t) => {
  const { home } = setup(t);
  const target = claude_mod.install(home, ROOT);
  writeFileSync(`${target}/hooks/register.tsx`, 'old');
  writeFileSync(`${target}/hooks/old.tsx`, 'stale');
  claude_mod.install(home, ROOT);
  assert.deepEqual(readFileSync(`${target}/hooks/register.tsx`), readFileSync(`${MOD}/hooks/register.tsx`));
  assert.equal(existsSync(`${target}/hooks/old.tsx`), false);
});

test('a foreign plugin with the same folder name is refused and kept', (t) => {
  const { home } = setup(t);
  const target = `${home}/.claude/skills/lcu-approve`;
  mkdirSync(`${target}/.claude-plugin`, { recursive: true });
  writeFileSync(`${target}/.claude-plugin/plugin.json`, '{"name": "mine"}');
  assert.throws(() => claude_mod.install(home, ROOT), { name: 'ValueError', message: /not the LCU mod/ });
  assert.throws(() => claude_mod.remove(home), { name: 'ValueError', message: /not the LCU mod/ });
  assert.deepEqual(read(`${target}/.claude-plugin/plugin.json`), { name: 'mine' });
  assert.equal(claude_mod._owned(target), false);
});

test('remove deletes only the mod', (t) => {
  const { home } = setup(t);
  const skills = `${home}/.claude/skills`;
  mkdirSync(`${skills}/other`, { recursive: true });
  writeFileSync(`${skills}/other/SKILL.md`, 'keep');
  claude_mod.install(home, ROOT);
  assert.equal(claude_mod._owned(`${skills}/lcu-approve`), true);
  assert.equal(claude_mod.remove(home), true);
  assert.equal(existsSync(`${skills}/lcu-approve`), false);
  assert.equal(readFileSync(`${skills}/other/SKILL.md`, 'utf8'), 'keep');
  assert.equal(claude_mod.remove(home), false);
});

test('missing mod in a release names the fix', (t) => {
  const { temporary, home } = setup(t);
  const empty = `${temporary}/release`;
  mkdirSync(empty);
  assert.throws(() => claude_mod.install(home, empty), { name: 'ValueError', message: /Reinstall LCU/ });
});

test('Windows: the stable command goes through current, as WindowsPath selects it (fixture, no live Windows)', () => {
  const saved = claude_mod.internals.platform;
  claude_mod.internals.platform = 'win32';
  try {
    // str(PureWindowsPath(...)) results of the Python implementation.
    assert.equal(claude_mod.lcu_command('C:\\prefix\\releases\\1.0-abc'), 'C:\\prefix\\current\\bin\\lcu');
    assert.equal(claude_mod.lcu_command('C:/prefix/releases/1.0-abc/'), 'C:\\prefix\\current\\bin\\lcu');
    assert.equal(claude_mod.lcu_command('C:\\src\\lcu'), 'C:\\src\\lcu\\bin\\lcu');
    assert.equal(claude_mod.destination('C:\\Users\\me'), 'C:\\Users\\me\\.claude\\skills\\lcu-approve');
    assert.equal(claude_mod.destination('C:\\Users\\me', 'D:\\proj'), 'D:\\proj\\.claude\\skills\\lcu-approve');
  } finally {
    claude_mod.internals.platform = saved;
  }
});
