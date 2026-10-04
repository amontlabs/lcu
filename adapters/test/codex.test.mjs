import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ElicitRequestSchema,
  ProgressNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const relay = fileURLToPath(new URL('../codex.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url));
const AUDIO_BYTES = Buffer.from([0, 17, 34, 51, 68, 85, 102, 119, 128, 255]);
const INSTRUCTIONS = 'Synthetic Codex relay instructions. Keep this exact fixture text.';
const PUBLIC_TOOLS = [
  {
    name: 'js',
    description: 'Synthetic JavaScript tool for Codex relay tests.',
    inputSchema: {
      type: 'object', properties: { code: { type: 'string' } },
      required: ['code'], additionalProperties: false,
    },
    _meta: { fixtureToolMarker: 'js-descriptor-retained' },
  },
  {
    name: 'js_reset',
    description: 'Synthetic JavaScript reset tool for Codex relay tests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

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

async function connectCodexRelay(relayPath = relay, { delayProgress = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-codex-relay-test-'));
  const logPath = join(directory, 'fixture.jsonl');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: directory,
    TMPDIR: directory,
    LCU_CODEX_FIXTURE_LOG: logPath,
  };
  if (delayProgress) {
    const preload = fileURLToPath(new URL('./codex-progress-delay.mjs', import.meta.url));
    env.NODE_OPTIONS = `--import=${preload}`;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [relayPath, process.execPath, fixture],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'codex-relay-contract-test', version: '1' }, {
    capabilities: { elicitation: { form: {}, url: {} } },
  });
  const receivedMessages = [];
  const progressEvents = [];
  const progressRequestIds = new Map();
  client.setNotificationHandler(ProgressNotificationSchema, async notification => {
    progressEvents.push(notification.params);
  });
  const originalSend = transport.send.bind(transport);
  transport.send = message => {
    if (message.method === 'tools/call' && message.params?.arguments?.code?.startsWith('send-progress')) {
      progressRequestIds.set(message.params._meta?.progressToken, message.id);
    }
    return originalSend(message);
  };
  const elicitationRequests = [];
  const elicitationResponses = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    elicitationRequests.push(structuredClone(request.params));
    return elicitationResponses.shift() ?? { action: 'cancel' };
  });
  let resolveListChanged;
  let listChangedCount = 0;
  const listChanged = new Promise(resolve => { resolveListChanged = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async notification => {
    listChangedCount += 1;
    resolveListChanged(notification);
  });
  try {
    await client.connect(transport);
    const originalOnMessage = transport.onmessage;
    transport.onmessage = message => {
      receivedMessages.push(message);
      return originalOnMessage(message);
    };
  } catch (error) {
    await client.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const logs = () => readRecords(logPath);
  let closePromise;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await client.close().catch(() => {});
      await waitFor(() => logs().some(entry => entry.type === 'fixture-exit'), 2_000).catch(() => {});
      const fixtureStarted = logs().find(entry => entry.type === 'fixture-start');
      let graceful = logs().some(entry => entry.type === 'fixture-exit');
      if (!graceful && fixtureStarted) {
        try { process.kill(fixtureStarted.pid, 'SIGTERM'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        await waitFor(() => logs().some(entry => entry.type === 'fixture-exit')).catch(() => {});
        graceful = logs().some(entry => entry.type === 'fixture-exit');
      }
      rmSync(directory, { recursive: true, force: true });
      return graceful;
    })();
    return closePromise;
  }
  return {
    client,
    logs,
    elicitationRequests,
    elicitationResponses,
    listChanged,
    progressEvents,
    progressRequestIds,
    receivedMessages,
    get listChangedCount() { return listChangedCount; },
    close,
    get stderr() { return stderr; },
  };
}

test('Codex relay starts through the installed current symlink', { timeout: 10_000 }, async () => {
  const install = mkdtempSync(join(tmpdir(), 'lcu-codex-current-symlink-test-'));
  const release = join(install, 'releases', '0.3.0');
  const adapters = join(release, 'adapters');
  mkdirSync(adapters, { recursive: true });
  copyFileSync(relay, join(adapters, 'codex.mjs'));
  copyFileSync(fileURLToPath(new URL('../audio-files.mjs', import.meta.url)), join(adapters, 'audio-files.mjs'));
  copyFileSync(fileURLToPath(new URL('../client.mjs', import.meta.url)), join(adapters, 'client.mjs'));
  copyFileSync(fileURLToPath(new URL('../host-guard.mjs', import.meta.url)), join(adapters, 'host-guard.mjs'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(adapters, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(release, join(install, 'current'), process.platform === 'win32' ? 'junction' : 'dir');

  let bridge;
  try {
    bridge = await connectCodexRelay(join(install, 'current', 'adapters', 'codex.mjs'));
    assert.equal(bridge.client.getServerVersion().name, 'lcu-codex-contract-fixture');
    assert.deepEqual((await bridge.client.listTools()).tools.map(tool => tool.name), ['js', 'js_reset']);
    const result = await bridge.client.callTool({ name: 'js', arguments: { code: 'current-symlink' } });
    assert.equal(result.content[0].text, 'Synthetic result: current-symlink');
  } finally {
    await bridge?.close();
    rmSync(install, { recursive: true, force: true });
  }
});

test('Codex relay preserves MCP contracts and changes only returned audio blocks', { timeout: 20_000 }, async () => {
  const bridge = await connectCodexRelay(relay, { delayProgress: true });
  try {
    assert.deepEqual(bridge.client.getServerVersion(), {
      name: 'lcu-codex-contract-fixture', version: '7.4.2',
    });
    assert.equal(bridge.client.getInstructions(), INSTRUCTIONS);
    assert.deepEqual(bridge.client.getServerCapabilities(), { tools: { listChanged: true } });

    const listed = await bridge.client.listTools();
    assert.deepEqual(listed.tools, PUBLIC_TOOLS);
    assert.ok(!listed.tools.some(tool => ['js_add_node_module_dir', 'turn_ended'].includes(tool.name)));

    const requestMeta = {
      'x-codex-turn-metadata': { session_id: 'fixture-session-81', turn_id: 'fixture-turn-12' },
      callerMarker: { retained: true },
    };
    const identityResult = await bridge.client.callTool({
      name: 'js', arguments: { code: 'metadata-result' }, _meta: requestMeta,
    });
    assert.deepEqual(identityResult, {
      content: [{ type: 'text', text: 'Synthetic result: metadata-result' }],
    });
    assert.deepEqual(bridge.logs().find(entry => entry.type === 'call' && entry.args.code === 'metadata-result'), {
      type: 'call', name: 'js', args: { code: 'metadata-result' }, meta: requestMeta,
    });

    const rich = await bridge.client.callTool({ name: 'js', arguments: { code: 'rich-result' } });
    assert.deepEqual(rich, {
      content: [
        { type: 'text', text: 'Synthetic text before image.', annotations: { audience: ['assistant'] } },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
      structuredContent: { fixture: { retained: true } },
      _meta: { fixtureResultMarker: { revision: 3 } },
    });
    const toolError = await bridge.client.callTool({ name: 'js', arguments: { code: 'tool-error' } });
    assert.deepEqual(toolError, {
      isError: true,
      content: [{ type: 'text', text: 'Synthetic tool-level failure.' }],
      _meta: { fixtureErrorMarker: true },
    });

    const audio = await bridge.client.callTool({ name: 'js', arguments: { code: 'audio-result' } });
    assert.equal(audio.isError, false);
    assert.deepEqual(audio.content.map(item => item.type), ['text', 'text', 'image', 'text']);
    assert.equal(audio.content[0].text, 'Synthetic audio before.');
    assert.equal(audio.content[2].data, 'AQID');
    assert.equal(audio.content[3].text, 'Synthetic audio after.');
    assert.match(audio.content[1].text, /original MIME type: audio\/wav/);
    const savedPath = /saved to (.+)$/.exec(audio.content[1].text)?.[1];
    assert.ok(savedPath);
    assert.equal(isAbsolute(savedPath), true);
    assert.deepEqual(readFileSync(savedPath), AUDIO_BYTES);
    assert.ok(!JSON.stringify(audio).includes(AUDIO_BYTES.toString('base64')));
    assert.deepEqual(audio.content[1].annotations, { audience: ['assistant'] });
    assert.deepEqual(audio.structuredContent, { fixtureAudioResult: { retained: true } });
    assert.deepEqual(audio._meta, { fixtureAudioMarker: { revision: 4 } });

    const moduleRegistration = await bridge.client.callTool({
      name: 'js_add_node_module_dir', arguments: { path: '/synthetic/module-path' },
    });
    assert.equal(moduleRegistration.content[0].text, 'Synthetic module path registered.');
    const cleanupArgs = {
      hook_event_name: 'Stop', session_id: 'fixture-session-81', turn_id: 'fixture-turn-12',
    };
    const cleanupMeta = { 'x-codex-turn-metadata': { session_id: cleanupArgs.session_id, turn_id: cleanupArgs.turn_id } };
    const cleanup = await bridge.client.callTool({ name: 'turn_ended', arguments: cleanupArgs, _meta: cleanupMeta });
    assert.equal(cleanup.content[0].text, 'Synthetic cleanup complete.');
    assert.deepEqual(bridge.logs().find(entry => entry.type === 'call' && entry.name === 'turn_ended'), {
      type: 'call', name: 'turn_ended', args: cleanupArgs, meta: cleanupMeta,
    });

    const accepted = { action: 'accept', content: {}, _meta: { persist: 'session', fixtureResponseMarker: true } };
    bridge.elicitationResponses.push(accepted);
    await bridge.client.callTool({ name: 'js', arguments: { code: 'approval' } });
    assert.deepEqual(bridge.elicitationRequests[0], {
      mode: 'form',
      message: 'Approve the synthetic fixture operation?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'fixture-connector',
        persist: ['session', 'always'],
        fixtureRequestMarker: { retained: true },
      },
    });
    assert.deepEqual(bridge.logs().find(entry => entry.type === 'elicitation-response').response, accepted);

    const progressToken = 'codex-progress-contract-token';
    const progressResult = await bridge.client.callTool(
      { name: 'js', arguments: { code: 'send-progress' },
        _meta: { callerMarker: 'progress-call', progressToken } },
    );
    assert.equal(progressResult.content[0].text, 'Progress sent.');
    await waitFor(() => bridge.progressEvents.length > 0);
    assert.equal(bridge.progressEvents[0].progressToken, progressToken);
    assert.deepEqual(bridge.progressEvents.map(({ progress, total, message }) => ({ progress, total, message })), [{
      progress: 2, total: 5, message: 'Synthetic fixture progress.',
    }], bridge.stderr);
    const requestId = bridge.progressRequestIds.get(progressToken);
    const progressIndex = bridge.receivedMessages.findIndex(message =>
      message.method === 'notifications/progress' && message.params?.progressToken === progressToken);
    const responseIndex = bridge.receivedMessages.findIndex(message =>
      message.id === requestId && Object.hasOwn(message, 'result'));
    assert.ok(progressIndex >= 0, 'the relay must emit progress to its downstream client');
    assert.ok(responseIndex > progressIndex, 'the tool result must not overtake the progress notification');
    assert.equal(bridge.logs().find(entry => entry.type === 'call' && entry.args.code === 'send-progress').meta.callerMarker,
      'progress-call');

    const errorProgressToken = 'codex-progress-error-contract-token';
    await assert.rejects(bridge.client.callTool({
      name: 'js', arguments: { code: 'send-progress-then-fail' },
      _meta: { callerMarker: 'progress-error-call', progressToken: errorProgressToken },
    }));
    await waitFor(() => bridge.progressEvents.some(event => event.progressToken === errorProgressToken));
    const errorRequestId = bridge.progressRequestIds.get(errorProgressToken);
    const errorProgressIndex = bridge.receivedMessages.findIndex(message =>
      message.method === 'notifications/progress' && message.params?.progressToken === errorProgressToken);
    const errorResponseIndex = bridge.receivedMessages.findIndex(message =>
      message.id === errorRequestId && Object.hasOwn(message, 'error'));
    assert.ok(errorProgressIndex >= 0, 'progress before an upstream error must reach the downstream client');
    assert.ok(errorResponseIndex > errorProgressIndex, 'the error response must not overtake accepted progress');

    await bridge.client.callTool({ name: 'js', arguments: { code: 'notify-tools-changed' } });
    const notification = await Promise.race([
      bridge.listChanged,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tool list change was not forwarded')), 2_000)),
    ]);
    assert.deepEqual(notification, { method: 'notifications/tools/list_changed' });
    assert.equal(bridge.listChangedCount, 1);

    const controller = new AbortController();
    const cancelledCall = bridge.client.callTool(
      { name: 'js', arguments: { code: 'wait-for-abort' }, _meta: { callerMarker: 'cancel-call' } },
      undefined,
      { signal: controller.signal },
    );
    await waitFor(() => bridge.logs().some(entry => entry.type === 'call-waiting-for-abort'));
    controller.abort();
    await assert.rejects(cancelledCall);
    await waitFor(() => bridge.logs().some(entry => entry.type === 'call-aborted'));
    assert.equal(bridge.logs().find(entry => entry.type === 'call-aborted').meta.callerMarker, 'cancel-call');

    const gracefulClose = await bridge.close();
    assert.equal(gracefulClose, true, `Codex relay did not gracefully close the upstream fixture: ${bridge.stderr}`);
  } finally {
    await bridge.close();
  }
});
