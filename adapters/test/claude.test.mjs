import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const relay = fileURLToPath(new URL('../claude.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./claude-fixture.mjs', import.meta.url));
const clientModule = fileURLToPath(new URL('../client.mjs', import.meta.url));

function installedCurrentEntryPoint(directory) {
  const releaseAdapters = join(directory, 'releases', '0.3.0-test', 'adapters');
  mkdirSync(releaseAdapters, { recursive: true });
  copyFileSync(relay, join(releaseAdapters, 'claude.mjs'));
  copyFileSync(clientModule, join(releaseAdapters, 'client.mjs'));
  copyFileSync(fileURLToPath(new URL('../host-guard.mjs', import.meta.url)), join(releaseAdapters, 'host-guard.mjs'));
  symlinkSync(join(dirname(relay), 'node_modules'), join(releaseAdapters, 'node_modules'), 'dir');
  symlinkSync(join(directory, 'releases', '0.3.0-test'), join(directory, 'current'), 'dir');
  return join(directory, 'current', 'adapters', 'claude.mjs');
}

function readRecords(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Condition did not become true within ${timeoutMs} ms`);
}

async function connectRelay({ throughCurrentSymlink = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-claude-relay-test-'));
  const logPath = join(directory, 'original-fixture.jsonl');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    TMPDIR: directory,
    LCU_FIXTURE_LOG: logPath,
  };
  const scriptPath = throughCurrentSymlink ? installedCurrentEntryPoint(directory) : relay;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scriptPath, process.execPath, fixture],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'claude-relay-contract-test', version: '1' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  const elicitationRequests = [];
  const elicitationResponses = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    elicitationRequests.push(structuredClone(request.params));
    const next = elicitationResponses.shift();
    return (typeof next === 'function' ? await next(request.params) : next) ?? { action: 'cancel' };
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const logs = () => readRecords(logPath);
  async function close() {
    await client.close().catch(() => {});
    const started = logs().find(entry => entry.type === 'fixture-start');
    if (started && !logs().some(entry => entry.type === 'fixture-exit')) {
      try { process.kill(started.pid, 'SIGTERM'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await waitFor(() => logs().some(entry => entry.type === 'fixture-exit')).catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    client,
    logs,
    elicitationRequests,
    respondToNextElicitation(response) { elicitationResponses.push(response); },
    close,
    get stderr() { return stderr; },
  };
}

async function bindContext(client, {
  sessionId = 'session-test', turnId = 'prompt-test', toolUseId, agentId,
}) {
  const arguments_ = {
    session_id: sessionId,
    turn_id: turnId,
    tool_use_id: toolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
  };
  return client.callTool({ name: 'set_turn_context', arguments: arguments_ });
}

async function callWithContext(client, name, args, {
  sessionId = 'session-test', turnId = 'prompt-test', toolUseId, agentId, callerMeta = {}, signal,
}) {
  await bindContext(client, { sessionId, turnId, toolUseId, agentId });
  return client.callTool({ name, arguments: args, _meta: {
    'claudecode/toolUseId': toolUseId,
    ...callerMeta,
  } }, undefined, { signal });
}

async function assertOriginalProtocol(bridge) {
  assert.equal(bridge.client.getInstructions(),
    'Original Claude relay fixture instructions. Preserve this text exactly.');
  const tools = (await bridge.client.listTools()).tools;
  assert.deepEqual(tools.filter(tool => tool.name === 'js' || tool.name === 'js_reset'), [
    { name: 'js', description: 'Original JavaScript tool description.', inputSchema: {
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false,
    } },
    { name: 'js_reset', description: 'Original JavaScript reset description.', inputSchema: {
      type: 'object', properties: {}, additionalProperties: false,
    } },
  ]);

  const context = {
    session_id: 'session-smoke', turn_id: 'prompt-smoke',
    tool_use_id: 'tool-use-smoke',
  };
  const bind = await bridge.client.callTool({ name: 'set_turn_context', arguments: context });
  assert.equal(bind.content[0].text, 'Turn context bound.');
  const result = await bridge.client.callTool({
    name: 'js',
    arguments: { code: 'identity-smoke' },
    _meta: { 'claudecode/toolUseId': context.tool_use_id, callerMarker: { retained: true },
      'openai/confirmation_policies': { computer_use: 'confirm' },
      'sandbox/policy': { mode: 'workspace-write' },
      'x-codex-turn-metadata': { caller_field: 'retained', thread_id: 'real-thread', thread_source: 'subagent' } },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'identity-smoke' }]);

  const forwarded = bridge.logs().find(entry => entry.type === 'tool-call' && entry.name === 'js');
  assert.deepEqual(forwarded, {
    type: 'tool-call',
    name: 'js',
    args: { code: 'identity-smoke' },
    meta: {
      'claudecode/toolUseId': context.tool_use_id,
      callerMarker: { retained: true },
      'openai/confirmation_policies': { computer_use: 'confirm' },
      'sandbox/policy': { mode: 'workspace-write' },
      'x-codex-turn-metadata': {
        caller_field: 'retained', thread_id: 'real-thread', thread_source: 'subagent',
        session_id: context.session_id, turn_id: context.turn_id, call_id: context.tool_use_id,
      },
    },
  });
}

test('Claude relay preserves original tool contract and forwards the exact correlated identity', async () => {
  const bridge = await connectRelay();
  try {
    await assertOriginalProtocol(bridge);
  } finally {
    await bridge.close();
  }
});

test('Claude relay starts and preserves its protocol through an installed current symlink', async () => {
  const bridge = await connectRelay({ throughCurrentSymlink: true });
  try {
    await assertOriginalProtocol(bridge);
  } finally {
    await bridge.close();
  }
});

test('Claude relay preserves original results/errors and isolates parallel and stale tool-use identities', async () => {
  const bridge = await connectRelay();
  try {
    const missing = await bridge.client.callTool({ name: 'js', arguments: { code: 'must-not-run' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' && entry.name === 'js').length, 0);

    const rich = await callWithContext(bridge.client, 'js', { code: 'rich-result' }, { toolUseId: 'rich-use' });
    assert.deepEqual(rich, {
      content: [
        { type: 'text', text: 'Original result text.', annotations: { audience: ['assistant'], priority: 0.7 } },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      structuredContent: { nested: { retained: true } },
      _meta: { originalResult: { revision: 4 } },
    });
    const failure = await callWithContext(bridge.client, 'js', { code: 'tool-error' }, { toolUseId: 'error-use' });
    assert.deepEqual(failure, {
      isError: true,
      content: [{ type: 'text', text: 'Original tool-level failure.' }],
      _meta: { originalError: true },
    });

    await bindContext(bridge.client, {
      sessionId: 'parallel-session-a', turnId: 'parallel-turn-a', toolUseId: 'parallel-use-a',
    });
    await bindContext(bridge.client, {
      sessionId: 'parallel-session-b', turnId: 'parallel-turn-b', toolUseId: 'parallel-use-b',
    });
    const [parallelJs, parallelReset] = await Promise.all([
      bridge.client.callTool({ name: 'js', arguments: { code: 'parallel-slow' }, _meta: {
        'claudecode/toolUseId': 'parallel-use-a', caller: 'a',
      } }),
      bridge.client.callTool({ name: 'js_reset', arguments: {}, _meta: {
        'claudecode/toolUseId': 'parallel-use-b', caller: 'b',
      } }),
    ]);
    assert.equal(parallelJs.content[0].text, 'parallel-slow');
    assert.equal(parallelReset.content[0].text, 'Original reset result.');
    const parallelCalls = bridge.logs().filter(entry => entry.type === 'tool-call' &&
      (entry.args.code === 'parallel-slow' || entry.name === 'js_reset'));
    assert.deepEqual(parallelCalls.map(entry => ({
      name: entry.name,
      meta: entry.meta,
    })).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'js', meta: {
        'claudecode/toolUseId': 'parallel-use-a',
        caller: 'a',
        'x-codex-turn-metadata': { session_id: 'parallel-session-a', turn_id: 'parallel-turn-a', call_id: 'parallel-use-a' },
      } },
      { name: 'js_reset', meta: {
        'claudecode/toolUseId': 'parallel-use-b',
        caller: 'b',
        'x-codex-turn-metadata': { session_id: 'parallel-session-b', turn_id: 'parallel-turn-b', call_id: 'parallel-use-b' },
      } },
    ]);

    await bindContext(bridge.client, {
      sessionId: 'stale-session', turnId: 'stale-turn', toolUseId: 'stale-use',
    });
    const cleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: 'stale-session', turn_id: 'stale-turn',
    } });
    assert.equal(cleanup.content[0].text, 'Original cleanup completed.');
    const stale = await bridge.client.callTool({ name: 'js', arguments: { code: 'stale-must-not-run' }, _meta: {
      'claudecode/toolUseId': 'stale-use',
    } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' &&
      entry.args.code === 'stale-must-not-run').length, 0);
  } finally {
    await bridge.close();
  }
});


test('Claude relay isolates overlapping child identities and makes SubagentStop cleanup idempotent', async () => {
  const bridge = await connectRelay();
  try {
    const sessionId = 'shared-host-session';
    const turnId = 'shared-prompt';
    const initial = [
      { toolUseId: 'parent-active', code: 'parent-active' },
      { toolUseId: 'child-a-active', code: 'child-a-active', agentId: 'agent-a' },
      { toolUseId: 'child-b-active', code: 'child-b-active', agentId: 'agent-b' },
    ];
    for (const identity of initial) {
      await bindContext(bridge.client, { sessionId, turnId, ...identity });
    }
    const results = await Promise.all(initial.map(identity => bridge.client.callTool({
      name: 'js', arguments: { code: identity.code },
      _meta: { 'claudecode/toolUseId': identity.toolUseId },
    })));
    assert.ok(results.every(result => !result.isError));

    const forwarded = Object.fromEntries(bridge.logs()
      .filter(entry => entry.type === 'tool-call' && initial.some(item => item.code === entry.args.code))
      .map(entry => [entry.args.code, entry.meta['x-codex-turn-metadata']]));
    assert.deepEqual(forwarded, {
      'parent-active': { session_id: sessionId, turn_id: turnId, call_id: 'parent-active' },
      'child-a-active': { session_id: 'agent-a', turn_id: turnId, call_id: 'child-a-active' },
      'child-b-active': { session_id: 'agent-b', turn_id: turnId, call_id: 'child-b-active' },
    });

    const pending = [
      { toolUseId: 'parent-pending', code: 'parent-pending' },
      { toolUseId: 'child-a-pending', code: 'child-a-pending', agentId: 'agent-a' },
      { toolUseId: 'child-b-pending', code: 'child-b-pending', agentId: 'agent-b' },
    ];
    for (const identity of pending) {
      await bindContext(bridge.client, { sessionId, turnId, ...identity });
    }

    const childAStop = { hook_event_name: 'SubagentStop', session_id: 'agent-a', turn_id: turnId };
    const childACleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: childAStop });
    assert.ok(!childACleanup.isError);

    const duplicateCleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: childAStop });
    assert.equal(duplicateCleanup.content[0].text, 'Turn already ended.');
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.hook_event_name === 'SubagentStop' && entry.args.session_id === 'agent-a').length, 1);

    const staleChild = await bridge.client.callTool({ name: 'js', arguments: { code: 'child-a-stale' },
      _meta: { 'claudecode/toolUseId': 'child-a-pending' } });
    assert.equal(staleChild.isError, true);
    assert.match(staleChild.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' &&
      entry.args.code === 'child-a-stale').length, 0);

    const parentStop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.ok(!parentStop.isError);
    const staleParent = await bridge.client.callTool({ name: 'js', arguments: { code: 'parent-stale' },
      _meta: { 'claudecode/toolUseId': 'parent-pending' } });
    assert.equal(staleParent.isError, true);
    assert.match(staleParent.content[0].text, /Missing exact Claude PreToolUse identity/);
    assert.equal(bridge.logs().filter(entry => entry.type === 'tool-call' &&
      entry.args.code === 'parent-stale').length, 0);

    const childB = await bridge.client.callTool({ name: 'js', arguments: { code: 'child-b-pending' },
      _meta: { 'claudecode/toolUseId': 'child-b-pending' } });
    assert.ok(!childB.isError);
    const childBStop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'SubagentStop', session_id: 'agent-b', turn_id: turnId,
    } });
    assert.ok(!childBStop.isError);
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.hook_event_name === 'SubagentStop').length, 2);
  } finally {
    await bridge.close();
  }
});

test('Claude relay re-runs Stop cleanup after an aborted call re-binds the same turn', async () => {
  const bridge = await connectRelay();
  try {
    const sessionId = 'relive-session';
    const turnId = 'relive-turn';
    // An aborted call runs Interrupt cleanup, marking the turn ended.
    const controller = new AbortController();
    const aborted = callWithContext(bridge.client, 'js', { code: 'cancel-active' }, {
      sessionId, turnId, toolUseId: 'relive-abort', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => bridge.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    assert.ok((await aborted).error, 'the canceled call should reject at the caller');
    await waitFor(() => bridge.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId));
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId).length, 1);

    // The model continues in the same prompt_id: re-binding revives the turn.
    const live = await callWithContext(bridge.client, 'js', { code: 'relive-live' }, {
      sessionId, turnId, toolUseId: 'relive-live',
    });
    assert.equal(live.content[0].text, 'relive-live');

    // The final Stop must reach upstream turn_ended a second time, not dedupe.
    const stop = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.equal(stop.content[0].text, 'Original cleanup completed.');
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId).length, 2);

    // A duplicate Stop for the still-ended turn is still deduped.
    const duplicate = await bridge.client.callTool({ name: 'turn_ended', arguments: {
      hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
    } });
    assert.equal(duplicate.content[0].text, 'Turn already ended.');
    assert.equal(bridge.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === sessionId).length, 2);
  } finally {
    await bridge.close();
  }
});

test('Claude relay maps native scopes and passes unrelated form and URL elicitations through unchanged', async () => {
  const bridge = await connectRelay();
  try {
    const nativeMeta = {
      codex_approval_kind: 'mcp_tool_call',
      connector_id: 'computer-use',
      persist: ['session', 'always'],
      tool_name: 'get_app_state',
      tool_params: { app: 'dev.lcu.NativeFixture.generated' },
      fixtureOpaque: { keep: true },
    };
    for (const [choice, expected] of [
      ['once', { action: 'accept', content: {} }],
      ['session', { action: 'accept', content: {}, _meta: { persist: 'session' } }],
      ['always', { action: 'accept', content: {}, _meta: { persist: 'always' } }],
      ['decline', { action: 'decline' }],
    ]) {
      bridge.respondToNextElicitation({ action: 'accept', content: { choice } });
      const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
        toolUseId: `approval-${choice}`,
      });
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
      const shown = bridge.elicitationRequests.at(-1);
      assert.deepEqual(shown._meta, nativeMeta);
      assert.equal(shown.message, 'Allow Computer Use to use "LCU Fixture App"?');
      const choiceSchema = shown.requestedSchema.properties.choice;
      const choices = choiceSchema.enum?.map((value, index) => ({
        value,
        label: choiceSchema.enumNames?.[index],
      })) ?? choiceSchema.oneOf?.map(option => ({ value: option.const, label: option.title }));
      assert.deepEqual(choices, [
        { value: 'once', label: 'Allow once' },
        { value: 'session', label: 'Allow for this session' },
        { value: 'always', label: 'Always allow' },
        { value: 'decline', label: 'Decline' },
      ]);
    }

    bridge.respondToNextElicitation({ action: 'cancel' });
    const cancelled = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
      toolUseId: 'approval-cancel',
    });
    assert.deepEqual(JSON.parse(cancelled.content[0].text), { action: 'cancel' });

    bridge.respondToNextElicitation({ action: 'accept', content: { choice: 'always' } });
    const unoffered = await callWithContext(bridge.client, 'js', { code: 'approval-native-session-only' }, {
      toolUseId: 'approval-unoffered-scope',
    });
    assert.deepEqual(JSON.parse(unoffered.content[0].text), { action: 'cancel' });
    const sessionOnly = bridge.elicitationRequests.at(-1).requestedSchema.properties.choice;
    assert.deepEqual(sessionOnly.enum, ['once', 'session', 'decline']);

    const unrelatedMeta = { fixture: 'unrelated-form', opaque: { id: 39 } };
    const unrelatedRequest = {
      mode: 'form',
      message: 'Enter the fixture secret.',
      requestedSchema: { type: 'object', properties: { secret: { type: 'string', minLength: 1 } }, required: ['secret'] },
      _meta: unrelatedMeta,
    };
    bridge.respondToNextElicitation({ action: 'accept', content: { secret: 'kept secret' } });
    const form = await callWithContext(bridge.client, 'js', { code: 'approval-form' }, {
      toolUseId: 'approval-unrelated-form',
    });
    assert.deepEqual(JSON.parse(form.content[0].text), { action: 'accept', content: { secret: 'kept secret' } });
    assert.deepEqual(bridge.elicitationRequests.at(-1), unrelatedRequest);

    const urlRequest = {
      mode: 'url',
      message: 'Open the original fixture approval URL.',
      elicitationId: 'fixture-url-elicitation',
      url: 'https://approval.example.invalid/continue',
      _meta: { fixture: 'url-form-pass-through', opaque: { id: 71 } },
    };
    bridge.respondToNextElicitation({ action: 'decline' });
    const url = await callWithContext(bridge.client, 'js', { code: 'approval-url' }, {
      toolUseId: 'approval-url',
    });
    assert.deepEqual(JSON.parse(url.content[0].text), { action: 'decline' });
    assert.deepEqual(bridge.elicitationRequests.at(-1), urlRequest);
  } finally {
    await bridge.close();
  }
});

test('Claude relay interrupts an active turn on cancel and drains cleanup before a real stdio close', async () => {
  const cancelled = await connectRelay();
  try {
    const controller = new AbortController();
    const pending = callWithContext(cancelled.client, 'js', { code: 'cancel-active' }, {
      sessionId: 'cancel-session', turnId: 'cancel-turn', toolUseId: 'cancel-use', signal: controller.signal,
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => cancelled.logs().some(entry => entry.type === 'active-call-start'));
    controller.abort();
    const settled = await pending;
    assert.ok(settled.error, 'an explicitly canceled MCP request should reject at the caller');
    await waitFor(() => cancelled.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'cancel-session' && entry.args.turn_id === 'cancel-turn'));
    assert.equal(cancelled.logs().filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'cancel-session').length, 1);
  } finally {
    await cancelled.close();
  }

  const closed = await connectRelay();
  try {
    const pending = callWithContext(closed.client, 'js', { code: 'close-active' }, {
      sessionId: 'close-session', turnId: 'close-turn', toolUseId: 'close-use',
    }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => closed.logs().some(entry => entry.type === 'active-call-start'));
    await closed.client.close();
    const settled = await pending;
    assert.ok(settled.error, 'closing the host transport should settle the active tool call');
    await waitFor(() => closed.logs().some(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'close-session' && entry.args.turn_id === 'close-turn'));
    const events = closed.logs();
    const startIndex = events.findIndex(entry => entry.type === 'active-call-start' && entry.code === 'close-active');
    const cleanupIndex = events.findIndex(entry => entry.type === 'turn-ended' && entry.args.session_id === 'close-session');
    const exitIndex = events.findIndex(entry => entry.type === 'fixture-exit');
    assert.ok(startIndex >= 0 && cleanupIndex > startIndex && exitIndex > cleanupIndex,
      'the relay must complete original Interrupt cleanup before closing the original server');
    assert.equal(events.filter(entry => entry.type === 'turn-ended' &&
      entry.args.session_id === 'close-session').length, 1);
  } finally {
    await closed.close();
  }
});

test('Claude relay declines an approval for an agent host app without asking the host', async () => {
  const bridge = await connectRelay();
  try {
    const before = bridge.elicitationRequests.length;
    bridge.respondToNextElicitation({ action: 'accept', content: { choice: 'always' } });
    const result = await callWithContext(bridge.client, 'js', { code: 'approval-native-host' }, {
      toolUseId: 'approval-agent-host',
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'decline' });
    assert.equal(bridge.elicitationRequests.length, before);
  } finally {
    await bridge.close();
  }
});

const MOD = { 'claudecode/toolUseId': 'toolu_plugin_0123456789abcdef' };
const approvalCall = (client, name, args, meta = MOD) =>
  client.callTool({ name, arguments: args, _meta: meta });
const NATIVE_MESSAGE = 'Allow Computer Use to use "LCU Fixture App"?';

test('Claude relay answers a native-app approval from the choice the lcu-approve mod recorded', async () => {
  const bridge = await connectRelay();
  try {
    for (const [choice, expected] of [
      ['session', { action: 'accept', content: {}, _meta: { persist: 'session' } }],
      ['always', { action: 'accept', content: {}, _meta: { persist: 'always' } }],
      ['deny', { action: 'decline' }],
      ['cancel', { action: 'cancel' }],
    ]) {
      let described;
      bridge.respondToNextElicitation(async () => {
        const request = await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE });
        described = JSON.parse(request.content[0].text);
        const recorded = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice });
        assert.notEqual(recorded.isError, true);
        // The host's own form is blocked by the mod, so Claude Code answers decline.
        return { action: 'decline' };
      });
      const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, {
        toolUseId: `mod-${choice}`,
      });
      assert.deepEqual(JSON.parse(result.content[0].text), expected, choice);
      assert.deepEqual({ ...described, id: 'ID' }, {
        id: 'ID',
        message: NATIVE_MESSAGE,
        app: 'dev.lcu.NativeFixture.generated',
        label: 'dev.lcu.NativeFixture.generated',
        scopes: ['session', 'always'],
        riskLevel: 'low',
      });
      // The record is gone with the elicitation: the choice cannot be replayed.
      const replay = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'session' });
      assert.equal(replay.isError, true);
    }
  } finally {
    await bridge.close();
  }
});

test('Claude relay falls back to the host answer when the mod recorded nothing', async () => {
  const bridge = await connectRelay();
  try {
    bridge.respondToNextElicitation(async () => ({ action: 'accept', content: { choice: 'session' } }));
    const accepted = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'host-session' });
    assert.deepEqual(JSON.parse(accepted.content[0].text),
      { action: 'accept', content: {}, _meta: { persist: 'session' } });

    // A mod that only asked for the description and never chose leaves the host decline in force.
    bridge.respondToNextElicitation(async () => {
      await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE });
      return { action: 'decline' };
    });
    const declined = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'host-decline' });
    assert.deepEqual(JSON.parse(declined.content[0].text), { action: 'decline' });
  } finally {
    await bridge.close();
  }
});

test('Claude relay rejects approval choices that are not the mod\'s, current, single use and offered', async () => {
  const bridge = await connectRelay();
  try {
    const attempts = [];
    bridge.respondToNextElicitation(async () => {
      const described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      const choose = (args, meta) => approvalCall(bridge.client, 'approval_choice', args, meta);
      attempts.push(
        // The model's own tool-use ids, no id, and a hook-type call carry no plugin prefix.
        await choose({ id: described.id, choice: 'session' }, { 'claudecode/toolUseId': 'toolu_01ABC' }),
        await choose({ id: described.id, choice: 'session' }, {}),
        await choose({ id: 'not-the-pending-id', choice: 'session' }),
        await choose({ id: described.id, choice: 'forever' }),
        // A second description for the same message finds nothing left to claim.
        await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE }),
        await approvalCall(bridge.client, 'approval_request', { message: 'Some other question?' }),
        await approvalCall(bridge.client, 'approval_request', { message: NATIVE_MESSAGE }, { 'claudecode/toolUseId': 'toolu_01model' }),
      );
      const first = await choose({ id: described.id, choice: 'session' });
      const second = await choose({ id: described.id, choice: 'always' });
      attempts.push(second);
      assert.notEqual(first.isError, true);
      return { action: 'decline' };
    });
    const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'rejects' });
    assert.deepEqual(attempts.map(attempt => attempt.isError), [true, true, true, true, true, true, true, true]);
    assert.deepEqual(JSON.parse(result.content[0].text),
      { action: 'accept', content: {}, _meta: { persist: 'session' } });

    // Persistent approval not offered: "always" is refused and the host's answer stands.
    let refused;
    bridge.respondToNextElicitation(async () => {
      const described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      assert.deepEqual(described.scopes, ['session']);
      refused = await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'always' });
      return { action: 'decline' };
    });
    const sessionOnly = await callWithContext(bridge.client, 'js', { code: 'approval-native-session-only' }, {
      toolUseId: 'rejects-always',
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(sessionOnly.content[0].text), { action: 'decline' });
  } finally {
    await bridge.close();
  }
});

test('Claude relay holds approval_wait until the mod records the choice from a button press', async () => {
  const bridge = await connectRelay();
  try {
    let waited;
    bridge.respondToNextElicitation(async () => {
      const described = JSON.parse((await approvalCall(bridge.client, 'approval_request',
        { message: NATIVE_MESSAGE })).content[0].text);
      const pending = approvalCall(bridge.client, 'approval_wait', { id: described.id });
      const modelWait = await approvalCall(bridge.client, 'approval_wait', { id: described.id },
        { 'claudecode/toolUseId': 'toolu_01model' });
      assert.equal(modelWait.isError, true);
      await new Promise(resolve => setTimeout(resolve, 50));
      await approvalCall(bridge.client, 'approval_choice', { id: described.id, choice: 'always' });
      waited = JSON.parse((await pending).content[0].text);
      return { action: 'decline' };
    });
    const result = await callWithContext(bridge.client, 'js', { code: 'approval-native' }, { toolUseId: 'wait' });
    assert.deepEqual(waited, { choice: 'always' });
    assert.deepEqual(JSON.parse(result.content[0].text),
      { action: 'accept', content: {}, _meta: { persist: 'always' } });
  } finally {
    await bridge.close();
  }
});

test('Claude relay lists the host-only approval tools for the mod and answers none of them to the model', async () => {
  const bridge = await connectRelay();
  try {
    const names = (await bridge.client.listTools()).tools.map(tool => tool.name);
    for (const name of ['approval_request', 'approval_wait', 'approval_choice']) assert.ok(names.includes(name), name);
    for (const [name, args] of [['approval_request', { message: NATIVE_MESSAGE }],
      ['approval_wait', { id: 'x' }], ['approval_choice', { id: 'x', choice: 'always' }]]) {
      const refused = await approvalCall(bridge.client, name, args, { 'claudecode/toolUseId': 'toolu_01model' });
      assert.equal(refused.isError, true, name);
    }
  } finally {
    await bridge.close();
  }
});
