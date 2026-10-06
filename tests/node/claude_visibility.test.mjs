// Port of tests/test_claude_visibility.py.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { lcu, tempdir } from './p4_support.mjs';

const { HOST_ONLY, install } = await lcu('claude_visibility');
const { JSONDecodeError } = await import('../../lcu/compat/pyjson.mjs');

const pyDumps = (value) => JSON.stringify(value, null, 0).replace(/":/g, '": ').replace(/,"/g, ', "');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function setup(t) {
  const home = `${tempdir(t)}/home`;
  mkdirSync(home);
  return home;
}

test('user scope preserves unrelated settings and is idempotent', (t) => {
  const home = setup(t);
  const path = `${home}/.claude/settings.json`;
  mkdirSync(`${home}/.claude`);
  writeFileSync(path, pyDumps({
    model: 'sonnet',
    permissions: { allow: ['Read'], deny: ['Bash(rm *)'] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] },
  }) + '\n');
  assert.equal(install(home), path);
  const data = read(path);
  assert.equal(data.model, 'sonnet');
  assert.deepEqual(data.permissions.allow, ['Read']);
  assert.deepEqual(data.permissions.deny, ['Bash(rm *)', ...HOST_ONLY]);
  assert.equal(data.hooks.UserPromptSubmit[0].hooks[0].command, 'existing-hook');
  const pick = (event, tool) => data.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.tool === tool);
  const beforeContext = pick('PreToolUse', 'set_turn_context');
  assert.equal(beforeContext.length, 1);
  assert.equal(beforeContext[0].type, 'mcp_tool');
  assert.equal(beforeContext[0].input.turn_id, '${prompt_id}');
  const stopCleanup = pick('Stop', 'turn_ended');
  assert.equal(stopCleanup.length, 1);
  assert.equal(stopCleanup[0].input.turn_id, '${prompt_id}');
  const failureCleanup = pick('StopFailure', 'turn_ended');
  assert.equal(failureCleanup.length, 1);
  assert.equal(failureCleanup[0].input.hook_event_name, 'Interrupt');
  const subagentCleanup = pick('SubagentStop', 'turn_ended');
  assert.equal(subagentCleanup.length, 1);
  assert.deepEqual(subagentCleanup[0].input, {
    hook_event_name: 'SubagentStop', session_id: '${agent_id}', turn_id: '${prompt_id}',
  });
  const first = readFileSync(path);
  install(home);
  assert.deepEqual(readFileSync(path), first);
});

test('existing hook groups are preserved and malformed hooks are refused', (t) => {
  const home = setup(t);
  const path = `${home}/.claude/settings.json`;
  mkdirSync(`${home}/.claude`);
  const contextHook = {
    type: 'mcp_tool', server: 'lcu', tool: 'set_turn_context',
    input: {
      session_id: '${session_id}', turn_id: '${prompt_id}', tool_use_id: '${tool_use_id}', agent_id: '${agent_id}',
    },
  };
  writeFileSync(path, pyDumps({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [contextHook] }],
    Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }],
  } }));
  install(home);
  const data = read(path);
  assert.equal(data.hooks.PreToolUse[0].matcher, 'Bash');
  assert.deepEqual(data.hooks.PreToolUse[0].hooks[0], contextHook);
  assert.equal(data.hooks.Stop[0].hooks[0].command, 'existing-stop');
  assert.equal(data.hooks.PreToolUse.length, 2);
  assert.equal(data.hooks.Stop.length, 2);

  writeFileSync(path, '{"hooks":[]}');
  const malformed = readFileSync(path);
  assert.throws(() => install(home), { name: 'ValueError', message: /hooks must be an object/ });
  assert.deepEqual(readFileSync(path), malformed);
});

test('malformed nested hook structures are refused without writes', (t) => {
  const home = setup(t);
  const path = `${home}/.claude/settings.json`;
  mkdirSync(`${home}/.claude`);
  for (const value of [
    { hooks: { PreToolUse: {} } },
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: {} }] } },
    { hooks: { Stop: [{ hooks: [null] }] } },
  ]) {
    const original = Buffer.from(pyDumps(value) + '\n');
    writeFileSync(path, original);
    assert.throws(() => install(home), { name: 'ValueError' });
    assert.deepEqual(readFileSync(path), original);
  }
});

test('project scope writes local file only', (t) => {
  const home = setup(t);
  const project = `${home}/project`;
  mkdirSync(project);
  const path = install(home, { project });
  assert.equal(path, `${project}/.claude/settings.local.json`);
  assert.deepEqual(read(path).permissions.deny, HOST_ONLY);
  assert.equal(existsSync(`${home}/.claude/settings.json`), false);
  assert.equal(existsSync(`${project}/.claude/settings.json`), false);
});

test('malformed existing settings remain unchanged', (t) => {
  const home = setup(t);
  const path = `${home}/.claude/settings.json`;
  mkdirSync(`${home}/.claude`);
  writeFileSync(path, '{broken JSON');
  assert.throws(() => install(home), JSONDecodeError);
  assert.equal(readFileSync(path, 'utf8'), '{broken JSON');
});

test('settings bytes match Python json.dumps(indent=2) for unrelated values', (t) => {
  // Extra (beyond the Python suite): floats, big ints and integer-like keys survive the read-modify-write.
  const home = setup(t);
  const path = `${home}/.claude/settings.json`;
  mkdirSync(`${home}/.claude`);
  writeFileSync(path, '{"b": 1.0, "10": 2, "2": 12345678901234567890, "s": "\\u00e9"}');
  install(home);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.startsWith('{\n  "b": 1.0,\n  "10": 2,\n  "2": 12345678901234567890,\n  "s": "\\u00e9",\n  "permissions": {'), text);
});
