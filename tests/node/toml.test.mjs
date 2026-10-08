import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, parseValue } from '../../lcu/toml.mjs';

test('a Codex config with tables, arrays of tables, inline hooks and comments', () => {
  const text = `# user config
model = "gpt" # trailing
approval_policy = 'on-request'
[mcp_servers.lcu]
command = "/opt/lcu/bin/lcu"
args = [
  "--chrome", # first
  "--audio",
]
default_tools_approval_mode = "approve"
tools.js.approval_mode = "approve"
tools.js_reset = { approval_mode = "prompt" }

[[hooks.Stop]]
hooks = [{ type = "mcp_tool", server = "lcu", tool = "turn_ended", input = { session_id = "s" } }]
[[hooks.Stop]]
matcher = "x"
hooks = []

[hooks.state."/home/a/.codex/config.toml:stop:0:0"]
trusted_hash = "sha256:ab"
[profiles."quoted key".nested]
n = 1_000
f = 1.5e3
h = 0xff
date = 1979-05-27T07:32:00Z
s = """
line \\
  joined"""
l = '''raw\\n'''
`;
  const data = parse(text);
  assert.equal(data.model, 'gpt');
  assert.deepEqual(data.mcp_servers.lcu.args, ['--chrome', '--audio']);
  assert.deepEqual(data.mcp_servers.lcu.tools, { js: { approval_mode: 'approve' }, js_reset: { approval_mode: 'prompt' } });
  assert.deepEqual(data.hooks.Stop, [
    { hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'turn_ended', input: { session_id: 's' } }] },
    { matcher: 'x', hooks: [] }]);
  assert.equal(data.hooks.state['/home/a/.codex/config.toml:stop:0:0'].trusted_hash, 'sha256:ab');
  const nested = data.profiles['quoted key'].nested;
  assert.deepEqual([nested.n, nested.f, nested.h, String(nested.date), nested.s, nested.l],
    [1000, 1500, 255, '1979-05-27T07:32:00Z', 'line joined', 'raw\\n']);
});

test('dotted keys may extend their own table only', () => {
  assert.deepEqual(parse('a.b = 1\na.c = 2\n'), { a: { b: 1, c: 2 } });
  assert.deepEqual(parse('[x]\ny.z = 1\n[x.y.w]\nq = 1\n'), { x: { y: { z: 1, w: { q: 1 } } } });
});

test('invalid documents throw', () => {
  for (const text of ['a = 1\na = 2\n', '[a]\n[a]\n', 'a = {b = 1}\n[a]\n', 'a = 1 b = 2\n', 'a = "open\n',
    '[a]\nb.c = 1\n[a.b]\n', 'a = []\n[[a]]\n', 'a = 01\n', 'k =\n', '= 1\n', 'a = {x = 1}\na.y = 2\n']) {
    assert.throws(() => parse(text), Error, JSON.stringify(text));
  }
});

test('an empty document is an empty table', () => {
  assert.deepEqual(parse(''), {});
  assert.deepEqual(parse('\n# only a comment\n'), {});
});

test('lone inline values', () => {
  assert.deepEqual(parseValue('{a = 1, b.c = "x"}'), { a: 1, b: { c: 'x' } });
  assert.throws(() => parseValue('{a = 1} x'));
});
