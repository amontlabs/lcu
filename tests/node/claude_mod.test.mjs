// Port of tests/test_claude_mod.py.
import assert from 'node:assert/strict';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import test from 'node:test';

import { ROOT, lcu, tempdir, nat } from './p4_support.mjs';

const claude_mod = await lcu('claude_mod');
const MOD = nat(`${ROOT}/adapters/claude-mod/lcu-approve`);
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
  const home = nat(`${temporary}/home`);
  mkdirSync(home);
  return { temporary, home };
}

test('shipped mod is a function hook plugin for the lcu server', () => {
  const manifest = read(nat(`${MOD}/.claude-plugin/plugin.json`));
  assert.equal(manifest.name, claude_mod.NAME);
  assert.deepEqual(read(nat(`${MOD}/hooks/hooks.json`)), { modules: ['./register.tsx'] });
  const source = readFileSync(nat(`${MOD}/hooks/register.tsx`), 'utf8');
  assert.ok(source.includes("const SERVER = 'lcu'"));
  for (const event of ["'classic.Elicitation'", "'tool.call'", "'tool.check'", "'ui.render'"]) assert.ok(source.includes(event));
  for (const label of ['Allow this conversation', 'Always allow', 'Deny']) {
    assert.ok(readFileSync(nat(`${MOD}/hooks/views.tsx`), 'utf8').includes(label));
  }
  assert.ok(source.includes("'computer-use-apps'"));
});

test('user scope install is idempotent and omits the mod tests', (t) => {
  const { home } = setup(t);
  const target = claude_mod.install(home, ROOT);
  assert.equal(target, nat(`${home}/.claude/skills/lcu-approve`));
  assert.deepEqual(new Set(walkFiles(target)), new Set(['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx',
    'hooks/views.tsx', 'hooks/data.ts', 'types/index.d.ts', 'lcu.json']));
  const before = snapshot(target);
  claude_mod.install(home, ROOT);
  assert.deepEqual(snapshot(target), before);
});

test('install records where the lcu command is', (t) => {
  const { temporary, home } = setup(t);
  let target = claude_mod.install(home, ROOT);
  assert.deepEqual(read(nat(`${target}/lcu.json`)), { lcu: nat(`${ROOT}/bin/lcu`) });
  const release = nat(`${temporary}/prefix/releases/1.0-abc`);
  cpSync(MOD, `${release}/${claude_mod.SOURCE}`, { recursive: true, filter: (src) => !src.split('/').includes('tests') });
  target = claude_mod.install(home, release);
  assert.deepEqual(read(nat(`${target}/lcu.json`)), { lcu: nat(`${temporary}/prefix/current/bin/lcu`) });
  // The written bytes are json.dumps(..., indent=2) + '\n'.
  assert.equal(readFileSync(nat(`${target}/lcu.json`), 'utf8'), `{\n  "lcu": ${JSON.stringify(nat(`${temporary}/prefix/current/bin/lcu`))}\n}\n`);
});

test('project scope installs under the project and not the home', (t) => {
  const { temporary, home } = setup(t);
  const project = nat(`${temporary}/project`);
  mkdirSync(project);
  const target = claude_mod.install(home, ROOT, { project });
  assert.equal(target, nat(`${project}/.claude/skills/lcu-approve`));
  assert.equal(existsSync(nat(`${home}/.claude`)), false);
});

test('reinstall replaces changed files and drops files a release no longer ships', (t) => {
  const { home } = setup(t);
  const target = claude_mod.install(home, ROOT);
  writeFileSync(nat(`${target}/hooks/register.tsx`), 'old');
  writeFileSync(nat(`${target}/hooks/old.tsx`), 'stale');
  claude_mod.install(home, ROOT);
  assert.deepEqual(readFileSync(nat(`${target}/hooks/register.tsx`)), readFileSync(nat(`${MOD}/hooks/register.tsx`)));
  assert.equal(existsSync(nat(`${target}/hooks/old.tsx`)), false);
});

test('a foreign plugin with the same folder name is refused and kept', (t) => {
  const { home } = setup(t);
  const target = nat(`${home}/.claude/skills/lcu-approve`);
  mkdirSync(nat(`${target}/.claude-plugin`), { recursive: true });
  writeFileSync(nat(`${target}/.claude-plugin/plugin.json`), '{"name": "mine"}');
  assert.throws(() => claude_mod.install(home, ROOT), { name: 'ValueError', message: /not the LCU mod/ });
  assert.throws(() => claude_mod.remove(home), { name: 'ValueError', message: /not the LCU mod/ });
  assert.deepEqual(read(nat(`${target}/.claude-plugin/plugin.json`)), { name: 'mine' });
  assert.equal(claude_mod._owned(target), false);
});

test('remove deletes only the mod', (t) => {
  const { home } = setup(t);
  const skills = nat(`${home}/.claude/skills`);
  mkdirSync(nat(`${skills}/other`), { recursive: true });
  writeFileSync(nat(`${skills}/other/SKILL.md`), 'keep');
  claude_mod.install(home, ROOT);
  assert.equal(claude_mod._owned(nat(`${skills}/lcu-approve`)), true);
  assert.equal(claude_mod.remove(home), true);
  assert.equal(existsSync(nat(`${skills}/lcu-approve`)), false);
  assert.equal(readFileSync(nat(`${skills}/other/SKILL.md`), 'utf8'), 'keep');
  assert.equal(claude_mod.remove(home), false);
});

test('missing mod in a release names the fix', (t) => {
  const { temporary, home } = setup(t);
  const empty = nat(`${temporary}/release`);
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
