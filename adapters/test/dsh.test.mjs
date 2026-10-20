import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, childEnvironment, inject, name, PROMPT_ORDER, PROMPT_SECTION } from '../dsh/plugin.mjs';

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));

/** A Cordis-shaped context with DSH's tools, systemPrompt, sessionProjections and userQuestions services. */
function host({ questions } = {}) {
  const tools = new Map();
  const sections = [];
  const listeners = new Map();
  const effects = [];
  const warnings = [];
  const turns = new Map();
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    on(event, listener, options) {
      assert.deepEqual(options, { global: true });
      listeners.set(event, listener);
    },
    effect(run) { effects.push(run()); },
    get(service) {
      if (service === 'userQuestions') return questions;
      if (service === 'sessionProjections') {
        return { stateOf: (session, key) => key === 'turnBoundary' ? turns.get(session.id) : undefined };
      }
      return undefined;
    },
    logger: { warn(message) { warnings.push(message); } },
  };
  const agent = (sessionId, model = 'deepseek-flash') => ({ session: { id: sessionId }, options: { model } });
  return {
    ctx, tools, sections, warnings,
    startTurn(sessionId, turn) { turns.set(sessionId, { openTurnStartSeq: turn * 10, lastTurn: turn }); },
    endTurn(sessionId, turn, kind = 'completed') {
      turns.set(sessionId, { openTurnStartSeq: null, lastTurn: turn });
      listeners.get('session/event')({ id: sessionId }, { type: 'turn/end', data: { turn, reason: { kind } } });
    },
    dispose: () => Promise.all(effects.map(dispose => dispose())),
    async call(tool, sessionId, args, { callId = 'dsh-call', signal = new AbortController().signal, model } = {}) {
      return tools.get(tool).options.call(args, { agent: agent(sessionId, model), callId, signal });
    },
    agent,
  };
}

// The stand-in for @deepseek-ai/dsh-mcp-client's createMcpToolDefinition: keeps the options it was given.
const createMcpToolDefinition = (ctx, options) => ({ name: options.name, options });

async function withPlugin(options, run) {
  const directory = mkdtempSync(join(tmpdir(), 'lcu-dsh-'));
  const log = join(directory, 'mcp.jsonl');
  const saved = { command: process.env.LCU_MCP_COMMAND, log: process.env.LCU_FIXTURE_LOG };
  process.env.LCU_MCP_COMMAND = JSON.stringify([process.execPath, fixture]);
  process.env.LCU_FIXTURE_LOG = log;
  const dsh = host(options);
  const entries = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  };
  const until = async (predicate) => {
    for (let i = 0; i < 200 && !predicate(entries()); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(entries()), JSON.stringify(entries()));
  };
  try {
    await apply(dsh.ctx, { command: ['/unused/lcu'] }, { createMcpToolDefinition });
    return await run(dsh, entries, until);
  } finally {
    await dsh.dispose();
    for (const [key, value] of [['LCU_MCP_COMMAND', saved.command], ['LCU_FIXTURE_LOG', saved.log]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('DSH plugin registers only js and js_reset, the original instructions, and Cordis metadata', async () => {
  assert.equal(name, 'lcu-computer-use');
  assert.deepEqual(inject, ['tools', 'systemPrompt']);
  await withPlugin({}, async ({ tools, sections }) => {
    assert.deepEqual([...tools.keys()], ['js', 'js_reset']);
    const js = tools.get('js').options;
    assert.equal(js.rawName, 'js');
    assert.equal(js.description, 'Original JS description.');
    assert.equal(js.inputSchema.required[0], 'code');
    assert.equal('timeoutMs' in tools.get('js'), false);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, PROMPT_SECTION);
    assert.equal(sections[0].order, PROMPT_ORDER);
    assert.equal(sections[0].interpolate, false);
    assert.equal(sections[0].text(), 'Original CUA initialization guide.');
  });
});

test('DSH plugin refuses to load without the DSH tool helper', async () => {
  await assert.rejects(apply(host().ctx, {}), /lcu setup --agent dsh/);
});

test('DSH calls carry the session, one turn id per DSH turn, the call id and the model; turn/end ends it', async () => {
  await withPlugin({}, async (dsh, entries, until) => {
    dsh.startTurn('dsh-session', 1);
    const first = await dsh.call('js', 'dsh-session', { code: 'one' }, { callId: 'call-1' });
    assert.equal(first.content[0].text, 'one');
    await dsh.call('js', 'dsh-session', { code: 'two' }, { callId: 'call-2' });
    dsh.endTurn('dsh-session', 1);
    await until(list => list.length === 3);
    dsh.startTurn('dsh-session', 2);
    await dsh.call('js', 'dsh-session', { code: 'three' }, { callId: 'call-3' });
    dsh.endTurn('dsh-session', 2, 'aborted');
    await until(list => list.length === 5);
    const [one, two, stop, three, interrupt] = entries();
    const meta = entry => entry.meta['x-codex-turn-metadata'];
    assert.deepEqual([meta(one).session_id, meta(one).call_id, meta(one).model], ['dsh-session', 'call-1', 'deepseek-flash']);
    assert.equal(meta(two).call_id, 'call-2');
    assert.equal(meta(one).turn_id, meta(two).turn_id);
    assert.deepEqual([stop.name, stop.args.hook_event_name, stop.args.turn_id], ['turn_ended', 'Stop', meta(one).turn_id]);
    assert.notEqual(meta(three).turn_id, meta(one).turn_id);
    assert.deepEqual([interrupt.args.hook_event_name, interrupt.args.turn_id], ['Interrupt', meta(three).turn_id]);
    // A turn without an LCU call ends nothing upstream.
    dsh.startTurn('dsh-session', 3);
    dsh.endTurn('dsh-session', 3);
    dsh.endTurn('other-session', 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(entries().length, 5);
  });
});

test('DSH calls outside an open turn fail before reaching the runtime', async () => {
  await withPlugin({}, async (dsh, entries) => {
    await assert.rejects(dsh.call('js', 'idle-session', { code: 'x' }), /active DSH agent turn/);
    await assert.rejects(dsh.tools.get('js').options.call({ code: 'x' }, { callId: 'c', signal: new AbortController().signal }),
      /DSH agent session/);
    assert.deepEqual(entries(), []);
  });
});

test('a failed DSH turn cleanup stays pending, blocks the next turn until it succeeds, and is retried', async () => {
  await withPlugin({}, async (dsh, entries, until) => {
    dsh.startTurn('fail-once-session', 1);
    await dsh.call('js', 'fail-once-session', { code: 'first' });
    dsh.endTurn('fail-once-session', 1);
    await until(list => list.length === 2);
    await until(() => dsh.warnings.length === 1);
    assert.match(dsh.warnings[0], /LCU turn cleanup is pending: Original CUA turn cleanup failed: cleanup failed once/);
    dsh.startTurn('fail-once-session', 2);
    await dsh.call('js', 'fail-once-session', { code: 'second' });
    const list = entries();
    assert.deepEqual(list.map(entry => entry.name), ['js', 'turn_ended', 'turn_ended', 'js']);
    assert.equal(list[2].args.turn_id, list[0].meta['x-codex-turn-metadata'].turn_id);
    assert.equal(list[2].args.hook_event_name, 'Stop');

    dsh.startTurn('fail-session', 1);
    await dsh.call('js', 'fail-session', { code: 'first' });
    dsh.endTurn('fail-session', 1);
    dsh.startTurn('fail-session', 2);
    await assert.rejects(dsh.call('js', 'fail-session', { code: 'blocked' }), /still finishing the previous turn/);
    assert.equal(entries().filter(entry => entry.args?.code === 'blocked').length, 0);
  });
});

test('DSH asks native-app approvals through its question card and maps every choice', async () => {
  const asked = [];
  let answer;
  const questions = { async ask(request) { asked.push(request); return answer(request); } };
  await withPlugin({ questions }, async (dsh) => {
    dsh.startTurn('approval-session', 1);
    const run = async (code = 'approval-native') => JSON.parse((await dsh.call('js', 'approval-session', { code })).content[0].text);
    const choose = (selected, custom) => () => ({ answers: [{ id: 'lcu-app-approval', selected, ...(custom ? { custom } : {}) }] });
    answer = choose(['Allow once']);
    assert.deepEqual(await run(), { action: 'accept', content: {} });
    answer = choose(['Allow for this session']);
    assert.deepEqual(await run(), { action: 'accept', content: {}, _meta: { persist: 'session' } });
    answer = choose(['Always allow']);
    assert.deepEqual(await run(), { action: 'accept', content: {}, _meta: { persist: 'always' } });
    answer = choose(['Decline']);
    assert.deepEqual(await run(), { action: 'decline' });
    answer = choose(['Allow once'], 'but only for a minute');
    assert.deepEqual(await run(), { action: 'cancel' });
    answer = choose(['Allow once', 'Decline']);
    assert.deepEqual(await run(), { action: 'cancel' });
    answer = choose(['Always allow']);
    assert.deepEqual(await run('approval-native-session-only'), { action: 'cancel' });
    for (const code of ['ASK_CANCELLED', 'ASK_ABORTED', 'NO_PROVIDER', 'DELEGATED_CALLER', 'CALLER_NOT_LIVE']) {
      answer = () => { throw Object.assign(new Error(code), { name: 'UserQuestionError', code }); };
      assert.deepEqual(await run(), { action: 'cancel' }, code);
    }
    const [request] = asked;
    assert.equal(request.agent.session.id, 'approval-session');
    assert.ok(request.signal instanceof AbortSignal);
    assert.deepEqual(request.questions, [{ id: 'lcu-app-approval', question: 'Allow Computer Use to use "LCU Fixture App"?',
      detail: 'Application: dev.lcu.NativeFixture.generated',
      options: [{ label: 'Allow once' }, { label: 'Allow for this session' }, { label: 'Always allow' }, { label: 'Decline' }] }]);
    assert.deepEqual(asked.find(item => item.questions[0].options.length === 3).questions[0].options.map(option => option.label),
      ['Allow once', 'Allow for this session', 'Decline']);

    // Other empty forms get Allow/Decline; forms with fields are cancelled without asking.
    asked.length = 0;
    answer = choose(['Allow']);
    assert.equal((await dsh.call('js', 'approval-session', { code: 'approval-other' })).content[0].text, 'accept');
    answer = choose(['Decline']);
    assert.equal((await dsh.call('js', 'approval-session', { code: 'approval-other' })).content[0].text, 'decline');
    assert.deepEqual(asked.map(item => item.questions[0].options.map(option => option.label)), [['Allow', 'Decline'], ['Allow', 'Decline']]);
    assert.equal((await dsh.call('js', 'approval-session', { code: 'approval-form' })).content[0].text, 'cancel');
    assert.equal(asked.length, 2);
  });
});

test('DSH fails approvals closed without a question service or with calls of two agents in flight', async () => {
  await withPlugin({}, async (dsh) => {
    dsh.startTurn('headless-session', 1);
    const result = await dsh.call('js', 'headless-session', { code: 'approval-native' });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'cancel' });
  });
  const asked = [];
  const questions = { async ask(request) { asked.push(request); return { answers: [{ id: 'lcu-app-approval', selected: ['Allow once'] }] }; } };
  await withPlugin({ questions }, async (dsh, entries, until) => {
    dsh.startTurn('busy-session', 1);
    dsh.startTurn('other-session', 1);
    const controller = new AbortController();
    const pending = dsh.call('js', 'busy-session', { code: 'stop-pending' }, { signal: controller.signal });
    await until(list => list.some(entry => entry.args?.code === 'stop-pending'));
    const result = await dsh.call('js', 'other-session', { code: 'approval-native' });
    assert.deepEqual(JSON.parse(result.content[0].text), { action: 'cancel' });
    assert.equal(asked.length, 0);
    controller.abort();
    await assert.rejects(pending);
  });
});

test('DSH starts the runtime with its environment minus DSH and credential variables', async () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin', HOME: '/h', LCU_LOG_DIR: '/l', DSH_HOME: '/d', DSH_PROFILE: 'desktop',
    DEEPSEEK_API_KEY: 'k', OPENROUTER_API_KEY: 'k', GITHUB_TOKEN: 't', db_password: 'p', CLIENT_SECRET: 's', EMPTY: undefined }),
  { PATH: '/bin', HOME: '/h', LCU_LOG_DIR: '/l' });
  const saved = { DSH_PROFILE: process.env.DSH_PROFILE, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  process.env.DSH_PROFILE = 'desktop';
  process.env.DEEPSEEK_API_KEY = 'secret';
  const seen = [];
  try {
    const createClient = options => {
      seen.push(options);
      return { connect: async () => {}, instructions: 'guide', publicTools: () => [], close: async () => {} };
    };
    const dsh = host();
    await apply(dsh.ctx, { command: ['/opt/lcu/current/bin/lcu', '--chrome'] }, { createMcpToolDefinition, createClient });
    await dsh.dispose();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(seen[0].adapter, 'dsh');
  if (process.env.LCU_MCP_COMMAND === undefined) assert.deepEqual(seen[0].command, ['/opt/lcu/current/bin/lcu', '--chrome']);
  assert.equal(seen[0].env.DSH_PROFILE, undefined);
  assert.equal(seen[0].env.DEEPSEEK_API_KEY, undefined);
  assert.equal(seen[0].env.PATH, process.env.PATH);
});
