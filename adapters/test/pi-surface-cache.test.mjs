import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import piExtension from '../pi/index.ts';

// These tests start the runtime only through a command that counts its own starts, and keep the
// surface cache in a temporary home. The test preload turns the cache off for the other test files.
const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
const countingHost = [process.execPath, '--input-type=module', '-e',
  `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.LCU_TEST_SPAWN_LOG, 'x');
await import(${JSON.stringify(new URL('./mcp-fixture.mjs', import.meta.url).href)});`];
const posix = process.platform !== 'win32';

function cacheFile(home) {
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'LCU', 'cache', 'pi-surfaces.json');
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'lcu', 'pi-surfaces.json');
  return join(home, '.cache', 'lcu', 'pi-surfaces.json');
}

const memory = () => globalThis[Symbol.for('lcu.pi.surfaces')];

/** Run `body` with a temporary home, an empty in-memory cache and the counting host. */
async function withCache(body, { command = countingHost } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'lcu-pi-surface-'));
  const names = ['HOME', 'USERPROFILE', 'XDG_CACHE_HOME', 'LOCALAPPDATA', 'LCU_MCP_COMMAND', 'LCU_TEST_SPAWN_LOG',
    'LCU_FIXTURE_LOG', 'LCU_SURFACE_CACHE', 'LCU_DIAGNOSTIC_LOG', 'LCU_LOG_DIR'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, '.cache'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    LCU_MCP_COMMAND: JSON.stringify(typeof command === 'function' ? command(home) : command),
    LCU_TEST_SPAWN_LOG: join(home, 'spawns'), LCU_FIXTURE_LOG: join(home, 'mcp.jsonl'),
  });
  delete process.env.LCU_SURFACE_CACHE;
  memory()?.clear();
  const sessions = [];
  const spawns = () => {
    try { return readFileSync(join(home, 'spawns'), 'utf8').length; } catch { return 0; }
  };
  try {
    await body({ home, spawns, session: (...args) => { const made = session(...args); sessions.push(made); return made; } });
  } finally {
    for (const made of sessions) await made.handlers.get('session_shutdown')?.();
    memory()?.clear();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function session(extension = piExtension, options = undefined) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notes = [];
  const registrations = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerTool(tool) { tools.set(tool.name, tool); registrations.push(tool.name); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = { sessionManager: { getSessionId: () => 'surface-session' }, model: { id: 'surface-model' }, hasUI: true,
    ui: { notify(message, type) { notes.push({ message, type }); }, async select() { return undefined; } } };
  const loaded = extension(pi, options);
  const prompt = async (append = 'Existing append') => {
    const systemPromptOptions = { appendSystemPrompt: append };
    assert.equal(await handlers.get('before_agent_start')({ systemPrompt: 'Pi', systemPromptOptions }, ctx), undefined);
    return systemPromptOptions.appendSystemPrompt;
  };
  // What Pi sends the provider for each registered tool.
  const definitions = () => JSON.stringify([...tools.values()].map(tool => ({
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
  })));
  return { handlers, tools, commands, notes, registrations, ctx, loaded, prompt, definitions };
}

test('a second Pi session in the same process starts no host before its first LCU tool call', async () => {
  await withCache(async ({ spawns, session }) => {
    const first = session();
    const firstPrompt = await first.prompt();
    assert.equal(spawns(), 1, 'an unknown surface connects in before_agent_start, as before');
    assert.match(firstPrompt, /^Existing append\n\nOriginal CUA initialization guide/);
    await first.handlers.get('session_shutdown')();

    // Pi may load the extension module again for another session or subagent; the surface is per process.
    const { default: secondCopy } = await import('../pi/index.ts?second-module-copy');
    const second = session(secondCopy);
    const secondPrompt = await second.prompt();
    assert.equal(spawns(), 1, 'a known surface must not start a host in before_agent_start');
    assert.equal(secondPrompt, firstPrompt, 'instructions must be byte-identical to a live connect');
    assert.equal(second.definitions(), first.definitions(), 'tool definitions must be byte-identical to a live connect');
    assert.deepEqual(second.registrations, ['js', 'js_reset']);
    const options = { appendSystemPrompt: secondPrompt };
    await second.handlers.get('before_agent_start')({ systemPrompt: 'Pi', systemPromptOptions: options }, second.ctx);
    assert.equal(options.appendSystemPrompt, secondPrompt, 'the instructions are appended once');

    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js').execute('surface-call', { code: 'first' }, undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'first');
    assert.equal(spawns(), 2, 'the first LCU tool call starts the host');
    assert.deepEqual(second.registrations, ['js', 'js_reset'], 'an unchanged surface is not registered again');
    await second.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, second.ctx);
    assert.equal(second.notes.length, 0);
  });
});

test('Pi uses the cache file in a fresh process and starts the host only for a tool call', async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const firstPrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    memory().clear(); // a fresh process: only the file remains

    const second = session();
    assert.equal(await second.prompt(), firstPrompt);
    assert.equal(second.definitions(), first.definitions());
    assert.equal(spawns(), 1);
    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js_reset').execute('surface-reset', {}, undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'js_reset');
    assert.equal(spawns(), 2);

    const record = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    assert.deepEqual(Object.keys(record), ['format', 'entries']);
    const entries = Object.values(record.entries);
    assert.equal(entries.length, 1);
    assert.deepEqual(Object.keys(entries[0]), ['tools', 'instructions']);
    assert.deepEqual(entries[0].tools.map(tool => Object.keys(tool)), [
      ['name', 'description', 'inputSchema'], ['name', 'description', 'inputSchema']]);
    assert.equal(readFileSync(cacheFile(home), 'utf8').includes(home), false,
      'the file keeps no command, path or environment value');
    if (posix) {
      assert.equal(statSync(cacheFile(home)).mode & 0o777, 0o600);
      assert.equal(statSync(join(cacheFile(home), '..')).mode & 0o777, 0o700);
    }
  });
});

test('Pi connects in before_agent_start when no surface is known, or when the cache is turned off', async () => {
  await withCache(async ({ spawns, session }) => {
    const first = session();
    assert.match(await first.prompt(), /Original CUA initialization guide/);
    assert.equal(spawns(), 1);
    assert.deepEqual(first.registrations, ['js', 'js_reset']);
    await first.handlers.get('session_shutdown')();

    process.env.LCU_SURFACE_CACHE = '0';
    const second = session();
    assert.match(await second.prompt(), /Original CUA initialization guide/);
    assert.equal(spawns(), 2, 'LCU_SURFACE_CACHE=0 connects in every session');
  });
});

test('Pi replaces a cached surface that the host no longer reports and logs only metadata', async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const livePrompt = await first.prompt();
    const liveDefinitions = first.definitions();
    await first.handlers.get('session_shutdown')();
    const record = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    const [key] = Object.keys(record.entries);
    record.entries[key].tools[0].description = 'Stale JS description.';
    record.entries[key].instructions = 'Stale guide.';
    writeFileSync(cacheFile(home), JSON.stringify(record));
    memory().clear();
    const logs = join(home, 'logs');
    delete process.env.LCU_DIAGNOSTIC_LOG;
    process.env.LCU_LOG_DIR = logs;

    const second = session();
    assert.equal(await second.prompt(), 'Existing append\n\nStale guide.');
    assert.equal(second.tools.get('js').description, 'Stale JS description.');
    assert.equal(spawns(), 1);
    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js').execute('surface-changed', { code: 'still served' },
      undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'still served');
    assert.equal(spawns(), 2);
    assert.equal(second.definitions(), liveDefinitions, 'the live tools replace the stale ones');
    assert.equal(await second.prompt(), livePrompt, 'the next turn uses the live instructions');

    const stored = JSON.parse(readFileSync(cacheFile(home), 'utf8')).entries[key];
    assert.equal(stored.instructions, 'Original CUA initialization guide.');
    assert.equal(stored.tools[0].description, 'Original JS description.');
    memory().clear();
    const third = session();
    assert.equal(await third.prompt(), livePrompt);
    assert.equal(spawns(), 2);

    const [logName] = readdirSync(logs).filter(name => name.startsWith('pi-'));
    const text = readFileSync(join(logs, logName), 'utf8');
    const events = text.trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'surface_changed');
    assert.equal(events.length, 1);
    const { t: _time, ...event } = events[0];
    assert.deepEqual(event, { event: 'surface_changed', tools_changed: true, instructions_changed: true });
    assert.doesNotMatch(text, /Stale|Original JS description|initialization guide/);
  });
});

test('Pi treats a corrupt or malformed cache file as a miss', async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const livePrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    const [key] = Object.keys(JSON.parse(readFileSync(cacheFile(home), 'utf8')).entries);

    writeFileSync(cacheFile(home), '{"format":1,"entries":');
    memory().clear();
    const second = session();
    assert.equal(await second.prompt(), livePrompt);
    assert.equal(spawns(), 2, 'a corrupt file connects in before_agent_start');
    assert.ok(JSON.parse(readFileSync(cacheFile(home), 'utf8')).entries[key], 'the connect rewrites the file');
    await second.handlers.get('session_shutdown')();

    writeFileSync(cacheFile(home), JSON.stringify({ format: 1, entries: { [key]: { tools: 'js', instructions: 1 } } }));
    memory().clear();
    const third = session();
    assert.equal(await third.prompt(), livePrompt);
    assert.equal(spawns(), 3, 'a malformed entry connects in before_agent_start');
  });
});

test('Pi starts no host for agent_end or /lcu stop when no LCU tool ran', async () => {
  await withCache(async ({ spawns, session }) => {
    const first = session();
    await first.prompt();
    await first.handlers.get('session_shutdown')();

    const second = session();
    await second.prompt();
    await second.handlers.get('agent_start')({}, second.ctx);
    await second.commands.get('lcu').handler('stop', second.ctx);
    assert.deepEqual(second.notes, [{ message: 'No active Computer Use app is available to stop.', type: 'info' }]);
    await second.handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, second.ctx);
    await second.handlers.get('session_shutdown')();
    assert.equal(second.notes.length, 1, 'no cleanup warning');
    assert.equal(spawns(), 1);
  });
});

test('OMP registers a known surface at load without starting a host', async () => {
  await withCache(async ({ spawns, session }) => {
    const omp = { connectOnLoad: true, ompEssentialTools: true };
    const first = session(piExtension, omp);
    await first.loaded;
    assert.equal(spawns(), 1);
    await first.handlers.get('session_shutdown')();

    const second = session(piExtension, omp);
    await second.loaded;
    assert.equal(spawns(), 1, 'OMP must not start a host at load for a known surface');
    assert.deepEqual(second.registrations, ['js', 'js_reset']);
    assert.ok([...second.tools.values()].every(tool => tool.loadMode === 'essential'));
    assert.equal(second.definitions(), first.definitions());
    const prompt = await second.handlers.get('before_agent_start')({ systemPrompt: ['OMP rules'] }, second.ctx);
    assert.deepEqual(prompt.systemPrompt, ['OMP rules', 'Original CUA initialization guide.']);
    await second.handlers.get('agent_start')({}, second.ctx);
    const result = await second.tools.get('js').execute('omp-call', { code: 'omp' }, undefined, undefined, second.ctx);
    assert.equal(result.content[0].text, 'omp');
    assert.equal(spawns(), 2);
  });
});

test('Pi keys the surface on the app and CUA runtime versions of an installed release',
  { skip: !posix && 'the fake release launcher is a POSIX shell script' }, async () => {
  const release = home => {
    const root = join(home, 'release');
    const app = join(root, 'ChatGPT.app');
    const resources = process.platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(root, 'app', 'resources');
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(join(resources, 'cua_node'), { recursive: true });
    writeFileSync(join(root, 'bin', 'lcu'), `#!/bin/sh\nprintf x >> "$LCU_TEST_SPAWN_LOG"\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\n`);
    chmodSync(join(root, 'bin', 'lcu'), 0o755);
    writeFileSync(join(root, 'bundle.json'), '{"version":"0.0.0-test"}');
    writeFileSync(join(root, 'installation.json'), JSON.stringify(process.platform === 'darwin'
      ? { platform: 'darwin', app } : { platform: 'linux', app: join(root, 'app') }));
    writeFileSync(join(resources, 'app.asar'), 'asar');
    return [join(root, 'bin', 'lcu')];
  };
  const setVersions = (home, { app, runtime }) => {
    const root = join(home, 'release');
    const resources = process.platform === 'darwin'
      ? join(root, 'ChatGPT.app', 'Contents', 'Resources') : join(root, 'app', 'resources');
    writeFileSync(join(resources, 'cua_node', 'manifest.json'), JSON.stringify({ runtime_archive_version: runtime }));
    if (process.platform === 'darwin') {
      writeFileSync(join(root, 'ChatGPT.app', 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key>\n<string>${app}</string>\n<key>CFBundleVersion</key><string>1</string></dict></plist>`);
    }
  };
  await withCache(async ({ home, spawns, session }) => {
    setVersions(home, { app: '1.0', runtime: '0.0.1/a' });
    const first = session();
    const livePrompt = await first.prompt();
    assert.equal(spawns(), 1);
    const second = session();
    assert.equal(await second.prompt(), livePrompt);
    assert.equal(spawns(), 1, 'same release, app and runtime: known');

    setVersions(home, { app: '1.0', runtime: '0.0.2/b' });
    const third = session();
    assert.equal(await third.prompt(), livePrompt);
    assert.equal(spawns(), 2, 'a new CUA runtime version is a miss');

    if (process.platform === 'darwin') {
      setVersions(home, { app: '2.0', runtime: '0.0.2/b' });
      const fourth = session();
      await fourth.prompt();
      assert.equal(spawns(), 3, 'a new app version is a miss');
    }
    const before = spawns();
    const resources = process.platform === 'darwin'
      ? join(home, 'release', 'ChatGPT.app', 'Contents', 'Resources') : join(home, 'release', 'app', 'resources');
    rmSync(join(resources, 'cua_node', 'manifest.json'));
    await session().prompt();
    await session().prompt();
    assert.equal(spawns(), before + 2, 'a release whose runtime version cannot be read is never cached');
  }, { command: release });
});
