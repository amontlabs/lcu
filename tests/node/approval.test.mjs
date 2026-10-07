// Port of tests/test_approval.py (the cases that target lcu/approval.py; see .port/notes/approval.md for the
// setup.configure/setup.main cases, which belong to the setup port).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';

import { ROOT, lcu, nat, tempdir } from './p4_support.mjs';
import { which } from '../../lcu/compat/which.mjs';
import { toPlain } from '../../lcu/compat/pyjson.mjs';
import { ORACLE_ROOT } from './oracle_root.mjs';

const approval = await lcu('approval');
const claude_visibility = await lcu('claude_visibility');

// json.dumps(data, indent=2) for the plain test fixtures (string/list/dict only).
const pyDumps = (value) => JSON.stringify(value, null, 2);
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pyDumps(data) + '\n');
};
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const record = (home) => toPlain(approval.load_record(home));
const saveRecord = (home, plain) => approval.save_record(home, new Map(Object.entries(plain).map(([k, v]) => [k, new Map(Object.entries(v))])));

// ------------------------------------------------------------------------------------------- Claude
function claudeSetup(t) {
  const root = tempdir(t);
  const home = nat(`${root}/home`);
  const project = nat(`${root}/project`);
  mkdirSync(home);
  mkdirSync(project);
  return { home, project, user: nat(`${home}/.claude/settings.json`), local: nat(`${project}/.claude/settings.local.json`) };
}

test('claude: auto adds the server rule at user scope and ask removes exactly it', (t) => {
  const { home, user } = claudeSetup(t);
  const original = { model: 'sonnet', permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Edit'] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } };
  write(user, original);
  assert.ok(approval.apply_claude('auto', home).includes('added'));
  const added = read(user);
  assert.deepEqual(added.permissions.allow, ['Read', 'mcp__lcu__js', 'mcp__lcu__js_reset']);
  const { permissions: _a, ...restAdded } = added;
  const { permissions: _o, ...restOriginal } = original;
  assert.deepEqual(restAdded, restOriginal);
  assert.deepEqual(added.permissions.deny, ['Bash(rm *)']);
  assert.deepEqual(added.permissions.ask, ['Edit']);
  assert.ok(approval.apply_claude('ask', home).includes('removed'));
  assert.deepEqual(read(user), original);
  // Byte-exact: the restored file is json.dumps(original, indent=2) + '\n' again.
  assert.equal(readFileSync(user, 'utf8'), pyDumps(original) + '\n');
});

test('claude: project scope uses settings.local and leaves user settings alone', (t) => {
  const { home, project, user, local } = claudeSetup(t);
  write(user, { permissions: { allow: ['Read'] } });
  const before = readFileSync(user);
  approval.apply_claude('auto', home, { project });
  assert.deepEqual(read(local), { permissions: { allow: ['mcp__lcu__js', 'mcp__lcu__js_reset'] } });
  assert.equal(existsSync(nat(`${project}/.claude/settings.json`)), false);
  assert.deepEqual(readFileSync(user), before);
  approval.apply_claude('ask', home, { project });
  assert.deepEqual(read(local), {});
});

test('claude: auto is idempotent and byte stable', (t) => {
  const { home, user } = claudeSetup(t);
  approval.apply_claude('auto', home);
  const first = readFileSync(user);
  assert.ok(approval.apply_claude('auto', home).startsWith('unchanged'));
  assert.deepEqual(readFileSync(user), first);
  assert.deepEqual(read(user).permissions.allow, ['mcp__lcu__js', 'mcp__lcu__js_reset']);
});

test('claude: ask without a rule or file writes nothing', (t) => {
  const { home, user } = claudeSetup(t);
  assert.ok(approval.apply_claude('ask', home).startsWith('unchanged'));
  assert.equal(existsSync(user), false);
  write(user, { permissions: { allow: ['Read'] } });
  const before = readFileSync(user);
  approval.apply_claude('ask', home);
  assert.deepEqual(readFileSync(user), before);
});

test('claude: ask keeps other lcu tool rules and other servers', (t) => {
  const { home, user } = claudeSetup(t);
  write(user, { permissions: { allow: ['mcp__lcu__js', 'mcp__other'] } });
  approval.apply_claude('auto', home);
  assert.deepEqual(read(user).permissions.allow, ['mcp__lcu__js', 'mcp__other', 'mcp__lcu__js_reset']);
  approval.apply_claude('ask', home);
  assert.deepEqual(read(user).permissions.allow, ['mcp__lcu__js', 'mcp__other']);
});

test('claude: ask keeps a rule the user wrote before auto', (t) => {
  const { home, user } = claudeSetup(t);
  const original = { permissions: { allow: ['Read', 'mcp__lcu'] } };
  write(user, original);
  assert.ok(approval.apply_claude('auto', home).startsWith('unchanged'));
  assert.ok(approval.apply_claude('ask', home).includes('kept your own'));
  assert.deepEqual(read(user), original);
});

test('claude: ask without a record never removes an identical rule', (t) => {
  const { home, user } = claudeSetup(t);
  const original = { permissions: { allow: ['mcp__lcu'] } };
  write(user, original);
  approval.apply_claude('ask', home);
  assert.deepEqual(read(user), original);
});

test('claude: records are per settings path', (t) => {
  const { home, project, user, local } = claudeSetup(t);
  write(local, { permissions: { allow: ['mcp__lcu'] } });
  approval.apply_claude('auto', home); // user scope: added
  approval.apply_claude('auto', home, { project }); // project: user's own rule
  approval.apply_claude('ask', home, { project });
  assert.deepEqual(read(local), { permissions: { allow: ['mcp__lcu'] } });
  approval.apply_claude('ask', home);
  assert.deepEqual(read(user), {});
});

test('claude: host-only tools stay denied alongside the allow rule', (t) => {
  const { home, user } = claudeSetup(t);
  claude_visibility.install(home);
  approval.apply_claude('auto', home);
  let { permissions } = read(user);
  assert.deepEqual(permissions.allow, ['mcp__lcu__js', 'mcp__lcu__js_reset']);
  assert.deepEqual(permissions.deny, claude_visibility.HOST_ONLY);
  approval.apply_claude('ask', home);
  ({ permissions } = read(user));
  assert.equal('allow' in permissions, false);
  assert.deepEqual(permissions.deny, claude_visibility.HOST_ONLY);
});

test('claude: allow entries are exactly the model-visible tools', (t) => {
  const { home, user } = claudeSetup(t);
  claude_visibility.install(home);
  approval.apply_claude('auto', home);
  const { permissions } = read(user);
  assert.deepEqual([...permissions.allow].sort(), approval.MODEL_TOOLS.map((tool) => `mcp__lcu__${tool}`).sort());
  assert.equal(permissions.allow.includes('mcp__lcu'), false);
  for (const rule of claude_visibility.HOST_ONLY) {
    assert.ok(permissions.deny.includes(rule));
    assert.equal(permissions.allow.includes(rule), false);
  }
  assert.deepEqual(permissions.allow.filter((rule) => rule.includes('*') || rule === 'mcp__lcu'), []);
});

test('claude: model tool lists agree across the port and adapters', () => {
  const client = readFileSync(nat(`${ROOT}/adapters/client.mjs`), 'utf8');
  const relay = readFileSync(nat(`${ROOT}/adapters/claude.mjs`), 'utf8');
  const names = (text, constant) => text.match(new RegExp(constant + ' = new Set\\(\\[([^\\]]*)\\]\\)'))[1];
  const expected = approval.MODEL_TOOLS.map((tool) => `'${tool}'`).join(', ');
  assert.equal(names(client, 'MODEL_TOOLS'), expected);
  assert.equal(names(relay, 'PUBLIC_TOOLS'), expected);
  assert.deepEqual(approval.OMP_TOOLS, approval.MODEL_TOOLS);
  const matcher = approval.MODEL_TOOLS.map((tool) => `mcp__lcu__${tool}`).join('|');
  assert.ok(readFileSync(nat(`${ORACLE_ROOT}/lcu/claude_visibility.py`), 'utf8').includes(matcher));
  assert.ok(readFileSync(nat(`${ROOT}/lcu/claude_visibility.mjs`), 'utf8').includes(matcher));
  const modOnly = claude_visibility.MOD_ONLY.map((rule) => `'${rule.replace(/^mcp__lcu__/, '')}'`).join(', ');
  assert.equal(names(relay, 'MOD_ONLY_TOOLS'), modOnly);
  assert.ok(client.includes('toolu_plugin_'));
});

test('claude: tool categories are disjoint and each is handled consistently', (t) => {
  const { home, user } = claudeSetup(t);
  claude_visibility.install(home);
  approval.apply_claude('auto', home);
  let { permissions } = read(user);
  const model = new Set(approval.MODEL_TOOLS.map((tool) => `mcp__lcu__${tool}`));
  const hostOnly = new Set(claude_visibility.HOST_ONLY);
  const modOnly = new Set(claude_visibility.MOD_ONLY);
  const overlap = (a, b) => [...a].some((x) => b.has(x));
  assert.equal(overlap(model, hostOnly) || overlap(model, modOnly) || overlap(hostOnly, modOnly), false);
  assert.deepEqual(new Set(permissions.allow), model);
  assert.deepEqual(new Set(permissions.deny), hostOnly);
  for (const mode of ['auto', 'ask']) {
    approval.apply_claude(mode, home);
    ({ permissions } = read(user));
    for (const rule of modOnly) {
      assert.equal((permissions.allow ?? []).includes(rule), false);
      assert.equal((permissions.deny ?? []).includes(rule), false);
    }
  }
});

test('claude: legacy blanket rule is migrated by auto and removed by ask', (t) => {
  const { home, user } = claudeSetup(t);
  write(user, { permissions: { allow: ['Read'] } });
  saveRecord(home, { [`claude-code|${user}`]: { added: ['mcp__lcu'] } });
  write(user, { permissions: { allow: ['Read', 'mcp__lcu'] } });
  assert.ok(approval.apply_claude('auto', home).startsWith('added'));
  assert.deepEqual(read(user).permissions.allow, ['Read', 'mcp__lcu__js', 'mcp__lcu__js_reset']);
  assert.deepEqual(record(home)[`claude-code|${user}`].added, ['mcp__lcu__js', 'mcp__lcu__js_reset']);
  approval.apply_claude('ask', home);
  assert.deepEqual(read(user), { permissions: { allow: ['Read'] } });
});

test('claude: ask removes a recorded legacy rule without migrating', (t) => {
  const { home, user } = claudeSetup(t);
  write(user, { permissions: { allow: ['Read', 'mcp__lcu'] } });
  saveRecord(home, { [`claude-code|${user}`]: { added: ['mcp__lcu'] } });
  assert.ok(approval.apply_claude('ask', home).includes('removed'));
  assert.deepEqual(read(user), { permissions: { allow: ['Read'] } });
  assert.equal(approval.load_record(home).size, 0);
});

test('claude: ask never removes exact rules the user wrote', (t) => {
  const { home, user } = claudeSetup(t);
  const original = { permissions: { allow: ['mcp__lcu__js', 'mcp__lcu__js_reset'] } };
  write(user, original);
  assert.ok(approval.apply_claude('auto', home).startsWith('unchanged'));
  assert.ok(approval.apply_claude('ask', home).includes('kept your own'));
  assert.deepEqual(read(user), original);
});

test('claude: malformed settings are rejected without a write', (t) => {
  const { home, user } = claudeSetup(t);
  for (const content of ['{ not json', '[]', '{"permissions": []}', '{"permissions": {"allow": "x"}}',
    '{"permissions": {"allow": [1]}}']) {
    mkdirSync(dirname(user), { recursive: true });
    writeFileSync(user, content);
    assert.throws(() => approval.apply_claude('auto', home), (error) => error.name === 'ValueError' || error.name === 'JSONDecodeError');
    assert.equal(readFileSync(user, 'utf8'), content);
  }
});

test('claude: outcome texts match Python', (t) => {
  // Extra: the exact strings setup prints.
  const { home, user } = claudeSetup(t);
  assert.equal(approval.apply_claude('ask', home), 'unchanged (no settings file)');
  assert.equal(approval.apply_claude('auto', home),
    `added \`mcp__lcu__js\`, \`mcp__lcu__js_reset\` in permissions.allow (${user})`);
  assert.equal(approval.apply_claude('ask', home),
    `removed \`mcp__lcu__js\`, \`mcp__lcu__js_reset\` in permissions.allow (${user})`);
  assert.equal(readFileSync(approval.record_path(home), 'utf8'), '{}\n');
});

// ------------------------------------------------------------------------------------------- OMP
class FakeOmpConfig {
  // Stands in for `omp config get|set|reset tools.approval`.
  constructor(value = {}) {
    this.value = { ...value };
    this.calls = [];
    this.run = (argv, options) => {
      this.calls.push(argv.slice(2));
      this.lastOptions = options;
      const [action, key] = [argv[2], argv[3]];
      assert.equal(key, 'tools.approval');
      if (action === 'get') return { args: argv, returncode: 0, stdout: JSON.stringify({ key, value: this.value }), stderr: '' };
      if (action === 'set') this.value = JSON.parse(argv[4]);
      else if (action === 'reset') this.value = {};
      else throw new Error(String(argv));
      return { args: argv, returncode: 0, stdout: '', stderr: '' };
    };
  }

  get writes() {
    return this.calls.filter((call) => call[0] !== 'get');
  }
}

function withInternals(replacements, body) {
  const saved = { ...approval.internals };
  Object.assign(approval.internals, replacements);
  try {
    return body();
  } finally {
    Object.assign(approval.internals, saved);
  }
}

const ompApply = (home, mode, fake, env = {}) => withInternals({ which: () => '/bin/omp', run: fake.run },
  () => approval.apply_omp(mode, home, { env: { PATH: '/bin', ...env } }));

test('omp: auto allows both tools and keeps other policies', (t) => {
  const home = tempdir(t);
  const fake = new FakeOmpConfig({ bash: 'prompt' });
  ompApply(home, 'auto', fake);
  assert.deepEqual(fake.value, { bash: 'prompt', js: 'allow', js_reset: 'allow' });
  // The set argument is json.dumps(updated, sort_keys=True).
  assert.deepEqual(fake.writes, [['set', 'tools.approval', '{"bash": "prompt", "js": "allow", "js_reset": "allow"}']]);
});

test('omp: auto is idempotent', (t) => {
  const home = tempdir(t);
  const fake = new FakeOmpConfig({ js: 'allow', js_reset: 'allow' });
  assert.equal(ompApply(home, 'auto', fake), 'unchanged');
  assert.deepEqual(fake.writes, []);
});

test("omp: auto keeps a user's explicit non-allow policy", (t) => {
  const home = tempdir(t);
  const fake = new FakeOmpConfig({ js: 'deny' });
  const outcome = ompApply(home, 'auto', fake);
  assert.deepEqual(fake.value, { js: 'deny', js_reset: 'allow' });
  assert.ok(outcome.includes('kept your `js: deny`'));
  assert.equal(outcome, 'kept your `js: deny`, added `js_reset: allow` in tools.approval');
});

test('omp: ask removes only the allow entries it added', (t) => {
  const home = tempdir(t);
  let fake = new FakeOmpConfig({ bash: 'prompt' });
  ompApply(home, 'auto', fake);
  ompApply(home, 'ask', fake);
  assert.deepEqual(fake.value, { bash: 'prompt' });
  fake = new FakeOmpConfig({ js: 'deny' });
  ompApply(home, 'auto', fake);
  ompApply(home, 'ask', fake);
  assert.deepEqual(fake.value, { js: 'deny' });
});

test('omp: ask keeps preexisting allow entries', (t) => {
  const home = tempdir(t);
  let fake = new FakeOmpConfig({ js: 'allow', bash: 'prompt' });
  ompApply(home, 'auto', fake);
  assert.deepEqual(fake.value, { js: 'allow', js_reset: 'allow', bash: 'prompt' });
  ompApply(home, 'ask', fake);
  assert.deepEqual(fake.value, { js: 'allow', bash: 'prompt' });
  // And with no auto at all, an allow entry is never LCU's to remove.
  fake = new FakeOmpConfig({ js: 'allow', js_reset: 'allow' });
  ompApply(home, 'ask', fake);
  assert.deepEqual(fake.writes, []);
});

test('omp: records are per profile', (t) => {
  const home = tempdir(t);
  const fake = new FakeOmpConfig();
  ompApply(home, 'auto', fake, { OMP_PROFILE: 'blue' });
  const other = new FakeOmpConfig({ js: 'allow', js_reset: 'allow' });
  ompApply(home, 'ask', other, { OMP_PROFILE: 'green' });
  assert.deepEqual(other.writes, []);
  ompApply(home, 'ask', fake, { OMP_PROFILE: 'blue' });
  assert.deepEqual(fake.value, {});
  // Record key: omp|<home>|json.dumps(profile, sort_keys=True)
  ompApply(home, 'auto', fake, { OMP_PROFILE: 'blue', PI_CODING_AGENT_DIR: '/p' });
  assert.deepEqual(Object.keys(record(home)), [`omp|${home}|{"OMP_PROFILE": "blue", "PI_CODING_AGENT_DIR": "/p"}`]);
});

test('omp: ask resets the setting when nothing else remains', (t) => {
  const home = tempdir(t);
  const fake = new FakeOmpConfig();
  ompApply(home, 'auto', fake);
  fake.calls.length = 0;
  ompApply(home, 'ask', fake);
  assert.deepEqual(fake.writes, [['reset', 'tools.approval']]);
  assert.equal(ompApply(home, 'ask', fake), 'unchanged');
});

test('omp: environment selects the profile', (t) => {
  const home = tempdir(t);
  const fake = new FakeOmpConfig();
  ompApply(home, 'auto', fake, { OMP_PROFILE: 'blue' });
  assert.equal(fake.lastOptions.env.OMP_PROFILE, 'blue');
  assert.equal(fake.lastOptions.cwd, home);
  assert.equal(fake.lastOptions.stdin, 'devnull');
  assert.equal(fake.lastOptions.timeout, 60000);
});

test('omp: missing omp and unexpected output fail clearly', (t) => {
  const home = tempdir(t);
  withInternals({ which: () => null }, () => {
    assert.throws(() => approval.apply_omp('auto', home, { env: { PATH: '/bin' } }),
      { name: 'ValueError', message: /not on the target account PATH/ });
  });
  for (const stdout of ['[]', 'not json', '{"key": "x"}']) {
    withInternals({ which: () => '/bin/omp', run: (argv) => ({ args: argv, returncode: 0, stdout, stderr: '' }) }, () => {
      assert.throws(() => approval.apply_omp('auto', home, { env: { PATH: '/bin' } }),
        { name: 'ValueError', message: /unexpected/ });
    });
  }
  withInternals({ which: () => '/bin/omp', run: (argv) => ({ args: argv, returncode: 3, stdout: '', stderr: ' boom \n' }) }, () => {
    assert.throws(() => approval.apply_omp('auto', home, { env: { PATH: '/bin' } }),
      { name: 'ValueError', message: 'omp config exited 3: boom' });
  });
});

test('omp: real omp round trip in an isolated profile', { skip: which('omp') ? false : 'OMP is not installed' }, (t) => {
  const home = tempdir(t);
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: nat(`${home}/agent`), NO_COLOR: '1' };
  const omp = (...args) => {
    const result = spawnSync('omp', ['config', ...args], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  omp('set', 'tools.approval', '{"bash":"prompt"}');
  const current = () => JSON.parse(omp('get', 'tools.approval', '--json')).value;
  approval.apply_omp('auto', home, { env });
  assert.deepEqual(current(), { bash: 'prompt', js: 'allow', js_reset: 'allow' });
  approval.apply_omp('ask', home, { env });
  assert.deepEqual(current(), { bash: 'prompt' });
});

// ------------------------------------------------------------------------------------------- Codex
const TOOLS = { js: { approval_mode: 'approve' }, js_reset: { approval_mode: 'approve' } };

function codexSetup(t) {
  const root = tempdir(t);
  const home = nat(`${root}/home`);
  const project = nat(`${root}/project`);
  mkdirSync(home);
  mkdirSync(project);
  const config = nat(`${home}/.codex/config.toml`);
  const plan = (mode, scope = 'user') => approval.codex_plan(mode, home, { scope, project, env: { HOME: home } });
  const writeToml = (text, path = config) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const cycle = (mode, scope = 'user') => {
    const result = plan(mode, scope);
    approval.apply(mode, 'codex', home, { scope, project, env: { HOME: home }, plan: result });
    return result;
  };
  return { home, project, config, plan, writeToml, cycle };
}

test('codex: auto approves exactly the model tools and never the server', (t) => {
  const { plan } = codexSetup(t);
  const { policy } = plan('auto');
  assert.deepEqual(policy, { tools: TOOLS });
  assert.equal('default_tools_approval_mode' in policy, false);
  assert.deepEqual(plan('ask').policy, {});
  assert.deepEqual(plan(null).policy, {});
});

test('codex: ask removes only the tool entries auto added', (t) => {
  const { home, plan, writeToml, cycle } = codexSetup(t);
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n');
  assert.deepEqual(cycle('auto').policy, { default_tools_approval_mode: 'prompt', tools: TOOLS });
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n' +
    '[mcp_servers.lcu.tools.js]\napproval_mode = "approve"\n' +
    '[mcp_servers.lcu.tools.js_reset]\napproval_mode = "approve"\n');
  cycle('auto'); // idempotent
  assert.deepEqual(plan('ask').policy, { default_tools_approval_mode: 'prompt' });
  cycle('ask');
  assert.equal(approval.load_record(home).size, 0);
});

test('codex: a tool mode the user set is kept and never removed', (t) => {
  const { home, plan, writeToml, cycle } = codexSetup(t);
  writeToml('[mcp_servers.lcu.tools.js]\napproval_mode = "prompt"\n' +
    '[mcp_servers.lcu.tools.js_reset]\napproval_mode = "approve"\n');
  assert.deepEqual(cycle('auto').policy.tools, { js: { approval_mode: 'prompt' }, js_reset: { approval_mode: 'approve' } });
  assert.equal(approval.load_record(home).size, 0);
  assert.deepEqual(plan('ask').policy.tools, { js: { approval_mode: 'prompt' }, js_reset: { approval_mode: 'approve' } });
});

test('codex: legacy server-wide record is migrated by auto and restored by ask', (t) => {
  const { home, config, plan, writeToml, cycle } = codexSetup(t);
  const key = `codex|${config}`;
  for (const [mode, expected] of [['auto', { default_tools_approval_mode: 'prompt', tools: TOOLS }],
    ['ask', { default_tools_approval_mode: 'prompt' }]]) {
    saveRecord(home, { [key]: { prior: 'prompt' } });
    writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n');
    assert.deepEqual(plan(mode).policy, expected);
  }
  saveRecord(home, { [key]: { prior: null } });
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n');
  assert.deepEqual(plan('auto').policy, { tools: TOOLS });
  assert.deepEqual(plan('ask').policy, {});
  cycle('auto');
  assert.deepEqual(record(home)[key], { tools: ['js', 'js_reset'] });
});

test('codex: registration policy merges tools over the host contract', () => {
  const host = { startup_timeout_sec: 120, tools: { js: { output_token_limit: 25000 } } };
  const merged = approval.merge_codex_policy(host, { tools: TOOLS });
  assert.deepEqual(merged.tools.js, { output_token_limit: 25000, approval_mode: 'approve' });
  assert.deepEqual(merged.tools.js_reset, { approval_mode: 'approve' });
  assert.deepEqual(approval.merge_codex_policy(host, {}), host);
  // setup passes host_policy() as a Map (pyjson loads); the result is then a Map too.
  const mapHost = new Map([['startup_timeout_sec', 120], ['tools', new Map([['js', new Map([['output_token_limit', 25000]])]])]]);
  const mergedMap = approval.merge_codex_policy(mapHost, { default_tools_approval_mode: 'prompt', tools: TOOLS });
  assert.ok(mergedMap instanceof Map);
  assert.deepEqual([...mergedMap.keys()], ['startup_timeout_sec', 'tools', 'default_tools_approval_mode']);
  assert.deepEqual([...mergedMap.get('tools').get('js')], [['output_token_limit', 25000], ['approval_mode', 'approve']]);
});

test('codex: value not recorded by LCU is preserved by ask and default', (t) => {
  const { plan, writeToml } = codexSetup(t);
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "approve"\n');
  for (const mode of ['ask', null]) assert.deepEqual(plan(mode).policy, { default_tools_approval_mode: 'approve' });
});

test('codex: project scope reads and records the project config', (t) => {
  const { project, plan, writeToml, cycle } = codexSetup(t);
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n');
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "never"\n', nat(`${project}/.codex/config.toml`));
  cycle('auto', 'project');
  assert.deepEqual(plan('ask', 'user').policy, { default_tools_approval_mode: 'prompt' });
  assert.deepEqual(plan('ask', 'project').policy, { default_tools_approval_mode: 'never' });
});

test('codex: an unreadable config fails clearly unless no mode was requested', (t) => {
  // Extra: the error text Python prints for a malformed config.
  const { config, plan, writeToml } = codexSetup(t);
  writeToml('[mcp_servers.lcu\n');
  assert.deepEqual(plan(null), { policy: {}, key: `codex|${config}`, record: 'keep' });
  assert.throws(() => plan('auto'), {
    name: 'ValueError',
    message: `Cannot read the Codex config at ${config}: Expected ']' at the end of a table declaration (at line 1, column 17)`,
  });
});

// ------------------------------------------------------------------------------------------- apply()
test('apply: pi and hermes record nothing to configure', () => {
  assert.ok(approval.apply('auto', 'pi', '/h', { scope: 'user', project: null, env: {} }).includes('no permission system'));
  assert.ok(approval.apply('ask', 'hermes', '/h', { scope: 'user', project: null, env: {} }).includes('pre_tool_call'));
});

test('apply: unknown mode is rejected', () => {
  assert.throws(() => approval.apply('yolo', 'pi', '/h', { scope: 'user', project: null, env: {} }), { name: 'ValueError' });
});

test('apply: codex outcome texts', (t) => {
  const { home, project } = codexSetup(t);
  const env = { HOME: home };
  assert.equal(approval.apply('auto', 'codex', home, { scope: 'user', project, env }),
    'registered `approval_mode = "approve"` for the `js` and `js_reset` tools of `[mcp_servers.lcu]`');
  assert.equal(approval.apply('ask', 'codex', home, { scope: 'user', project, env }),
    'registered `[mcp_servers.lcu]` without an `approval_mode` LCU added');
  assert.equal(approval.apply('ask', 'codex', home, { scope: 'user', project, env,
    plan: { record: 'keep', restored: 'prompt' } }),
  'restored your previous `default_tools_approval_mode = "prompt"` for `[mcp_servers.lcu]`');
});

test('record: malformed approval.json is refused', (t) => {
  const { home } = codexSetup(t);
  for (const content of ['[]', '{"a": 1}', 'nope', '\xff']) {
    mkdirSync(dirname(approval.record_path(home)), { recursive: true });
    writeFileSync(approval.record_path(home), content, 'latin1');
    assert.throws(() => approval.load_record(home), {
      name: 'ValueError',
      message: `Malformed LCU approval record at ${approval.record_path(home)}; check it, then delete it and rerun setup.`,
    });
  }
});

// ------------------------------------------------------------------------------------------- review P2-6 / P2-7
test('null ownership fields fail like Python before anything is written', (t) => {
  const { home, config, plan, writeToml } = codexSetup(t);
  writeToml('[mcp_servers.lcu]\ndefault_tools_approval_mode = "prompt"\n');
  approval.save_record(home, new Map([[`codex|${config}`, new Map([['tools', null]])]]));
  const recordBefore = readFileSync(approval.record_path(home));
  assert.throws(() => plan('auto'), { name: 'TypeError', message: "'NoneType' object is not iterable" });
  assert.deepEqual(readFileSync(approval.record_path(home)), recordBefore);

  const key = `omp|${home}|{}`;
  approval.save_record(home, new Map([[key, new Map([['added', null]])]]));
  const fake = new FakeOmpConfig({ js: 'allow', js_reset: 'allow' });
  assert.throws(() => ompApply(home, 'ask', fake), { name: 'TypeError', message: "'NoneType' object is not iterable" });
  assert.deepEqual(fake.calls, []); // Python fails before invoking its CLI
  assert.deepEqual(toPlain(approval.load_record(home)), { [key]: { added: null } });

  const user = nat(`${home}/.claude/settings.json`);
  write(user, { permissions: { allow: ['mcp__lcu__js'] } });
  const before = readFileSync(user);
  approval.save_record(home, new Map([[`claude-code|${user}`, new Map([['added', 5]])]]));
  assert.throws(() => approval.apply_claude('ask', home), { name: 'TypeError', message: "'int' object is not iterable" });
  assert.deepEqual(readFileSync(user), before);
});

test('a corrupt Claude record cannot make ask remove permissions LCU never writes (hardening over Python)', (t) => {
  // Python 3.12 LCU removes every rule a (corrupt or edited) record names; the Node port only ever removes
  // LCU's own rule names (mcp__lcu__js, mcp__lcu__js_reset and the legacy mcp__lcu). Documented in
  // .port/notes/approval.md as an intentional behaviour change.
  const { home, user } = claudeSetup(t);
  write(user, { permissions: { allow: ['Read', 'mcp__other__js', 'mcp__lcu__js'] } });
  saveRecord(home, { [`claude-code|${user}`]: { added: ['Read', 'mcp__other__js', 'mcp__lcu__js'] } });
  assert.equal(approval.apply_claude('ask', home), `removed \`mcp__lcu__js\` in permissions.allow (${user})`);
  assert.deepEqual(read(user), { permissions: { allow: ['Read', 'mcp__other__js'] } });
  saveRecord(home, { [`claude-code|${user}`]: { added: ['Read'] } });
  assert.ok(approval.apply_claude('ask', home).startsWith('unchanged'));
  assert.deepEqual(read(user), { permissions: { allow: ['Read', 'mcp__other__js'] } });
});

// ------------------------------------------------------------------------------------------- round 2 R4
test('Windows: approval records and settings paths use WindowsPath semantics (fixture, no live Windows)', async () => {
  const setup = await lcu('setup');
  const saved = { platform: setup.impl.platform, windows_paths: setup.impl.windows_paths };
  setup.impl.platform = 'win32';
  setup.impl.windows_paths = true;
  try {
    assert.equal(approval.record_path('C:\\Users\\Fixture'), 'C:\\Users\\Fixture\\AppData\\Local\\LCU\\approval.json');
    assert.equal(approval.record_path('D:\\Users\\Other'), 'D:\\Users\\Other\\AppData\\Local\\LCU\\approval.json');
    assert.equal(approval.claude_settings_path('C:\\Users\\Fixture'), 'C:\\Users\\Fixture\\.claude\\settings.json');
    assert.equal(approval.claude_settings_path('C:\\Users\\Fixture', 'D:\\proj'), 'D:\\proj\\.claude\\settings.local.json');
    assert.equal(approval.codex_config_path('C:\\Users\\Fixture', 'user', null, {}), 'C:\\Users\\Fixture\\.codex\\config.toml');
    assert.equal(approval.codex_config_path('C:\\Users\\Fixture', 'user', null, { CODEX_HOME: 'E:\\codex' }), 'E:\\codex\\config.toml');
    assert.equal(approval.codex_config_path('C:\\Users\\Fixture', 'project', 'D:\\proj', {}), 'D:\\proj\\.codex\\config.toml');
  } finally {
    Object.assign(setup.impl, saved);
  }
});

test('approval records do not depend on the working directory', (t) => {
  const { home, user } = claudeSetup(t);
  const elsewhere = tempdir(t);
  const stray = nat(`${elsewhere}/approval.json`);
  writeFileSync(stray, '{"unrelated": {}}\n');
  const strayBytes = readFileSync(stray);
  const previous = process.cwd();
  try {
    process.chdir(elsewhere);
    approval.apply_claude('auto', home);
    process.chdir(dirname(home));
    assert.ok(approval.apply_claude('ask', home).startsWith('removed'));
  } finally {
    process.chdir(previous);
  }
  assert.deepEqual(readFileSync(stray), strayBytes);
  assert.equal(approval.record_path(home), process.platform === 'win32' ? nat(`${home}/AppData/Local/LCU/approval.json`)
    : `${home}/.local/state/lcu/approval.json`);
  assert.deepEqual(read(user), {});
});
