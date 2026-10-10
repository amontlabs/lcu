import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import piExtension from '../pi/index.ts';

// These tests start the runtime only through commands that record their own starts, and keep the
// surface cache in a temporary home. The test preload turns the cache off for the other test files.
// The cache is off on Windows, and the fake release launcher is a POSIX shell script.
const skip = process.platform === 'win32' && 'the surface cache is off on Windows; the fake release is a POSIX shell script';
const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
// A host that is not an LCU release: its versions cannot be read, so it is never cached.
const countingHost = [process.execPath, '--input-type=module', '-e',
  `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.LCU_TEST_SPAWN_LOG, 'n');
await import(${JSON.stringify(new URL('./mcp-fixture.mjs', import.meta.url).href)});`];

const sharedCache = home => process.platform === 'darwin' ? join(home, 'Library', 'Caches', 'lcu') : join(home, '.cache', 'lcu');
const cacheFile = home => join(sharedCache(home), 'pi-surfaces', 'surfaces.json');
const memory = () => globalThis[Symbol.for('lcu.pi.surfaces')];

/** Where a fake release keeps the app resources that hold the CUA manifest. */
const resources = root => process.platform === 'darwin'
  ? join(root, 'ChatGPT.app', 'Contents', 'Resources') : join(root, 'app', 'resources');

/** Set the app and CUA runtime versions a fake release reports. */
function setVersions(root, { app = '1.0', runtime = '0.0.1/a' } = {}) {
  writeFileSync(join(resources(root), 'cua_node', 'manifest.json'), JSON.stringify({ runtime_archive_version: runtime }));
  if (process.platform === 'darwin') {
    writeFileSync(join(root, 'ChatGPT.app', 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key>\n<string>${app}</string>\n<key>CFBundleVersion</key><string>1</string></dict></plist>`);
  }
}

/**
 * A fake installed release at `<home>/<name>`: `bin/lcu` records `name` in the spawn log and runs the
 * fixture host; `installation.json`, `bundle.json` and the app files give it readable versions.
 */
function release(home, name, versions) {
  const root = join(home, name);
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(resources(root), 'cua_node'), { recursive: true });
  writeFileSync(join(root, 'bin', 'lcu'), `#!/bin/sh\nprintf ${name} >> "$LCU_TEST_SPAWN_LOG"\n` +
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\n`);
  chmodSync(join(root, 'bin', 'lcu'), 0o755);
  writeFileSync(join(root, 'bundle.json'), `{"version":"0.0.0-${name}"}`);
  writeFileSync(join(root, 'installation.json'), JSON.stringify(process.platform === 'darwin'
    ? { platform: 'darwin', app: join(root, 'ChatGPT.app') } : { platform: 'linux', app: join(root, 'app') }));
  writeFileSync(join(resources(root), 'app.asar'), 'asar');
  setVersions(root, versions);
  return root;
}

/** Run `body` with a temporary home, an empty in-memory cache and a fake release `r` as the command. */
async function withCache(body, { command = home => [join(release(home, 'r'), 'bin', 'lcu')] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'lcu-pi-surface-'));
  const names = ['HOME', 'USERPROFILE', 'XDG_CACHE_HOME', 'LCU_MCP_COMMAND', 'LCU_TEST_SPAWN_LOG', 'PATH',
    'LCU_FIXTURE_LOG', 'LCU_SURFACE_CACHE', 'LCU_DIAGNOSTIC_LOG', 'LCU_LOG_DIR'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, '.cache'),
    LCU_MCP_COMMAND: JSON.stringify(typeof command === 'function' ? command(home) : command),
    LCU_TEST_SPAWN_LOG: join(home, 'spawns'), LCU_FIXTURE_LOG: join(home, 'mcp.jsonl'),
  });
  delete process.env.LCU_SURFACE_CACHE;
  memory()?.clear();
  const sessions = [];
  const started = () => {
    try { return readFileSync(join(home, 'spawns'), 'utf8'); } catch { return ''; }
  };
  try {
    await body({ home, started, spawns: () => started().length,
      session: (...args) => { const made = session(...args); sessions.push(made); return made; } });
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

test('a second Pi session in the same process starts no host before its first LCU tool call', { skip }, async () => {
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

test('Pi uses the cache file after the in-memory copy is cleared and starts the host only for a tool call', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const firstPrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    memory().clear(); // only the file remains

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
  });
});

test('Pi keeps its cache in its own directory and leaves the shared LCU cache directory mode unchanged', { skip }, async () => {
  await withCache(async ({ home, session }) => {
    mkdirSync(sharedCache(home), { recursive: true });
    chmodSync(sharedCache(home), 0o755);
    writeFileSync(join(sharedCache(home), 'update.json'), '{}');
    await session().prompt();
    assert.equal(statSync(sharedCache(home)).mode & 0o777, 0o755, 'the shared directory keeps its mode');
    assert.deepEqual(readdirSync(sharedCache(home)).sort(), ['pi-surfaces', 'update.json']);
    assert.equal(statSync(join(sharedCache(home), 'pi-surfaces')).mode & 0o777, 0o700);
    assert.equal(statSync(cacheFile(home)).mode & 0o777, 0o600);
  });
});

test('Pi connects in before_agent_start when no surface is known, or when the cache is turned off', { skip }, async () => {
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

test('Pi resolves a command name on PATH and misses when PATH selects another release', { skip }, async () => {
  await withCache(async ({ home, started, session }) => {
    const first = release(home, 'a', { app: '1.0', runtime: '0.0.1/a' });
    const other = release(home, 'b', { app: '2.0', runtime: '0.0.2/b' });
    const path = saved => `${join(saved, 'bin')}${delimiter}${process.env.PATH}`;

    process.env.PATH = path(first);
    const warm = session();
    const livePrompt = await warm.prompt();
    assert.equal(started(), 'a');
    await warm.handlers.get('session_shutdown')();
    const known = session();
    assert.equal(await known.prompt(), livePrompt);
    assert.equal(started(), 'a', 'the same release on PATH: known');
    assert.ok(existsSync(cacheFile(home)));

    // Another release earlier on PATH, as after an install that puts a newer `lcu` first.
    process.env.PATH = `${join(other, 'bin')}${delimiter}${path(first)}`;
    const moved = session();
    assert.equal(await moved.prompt(), livePrompt);
    assert.equal(started(), 'ab', 'PATH now selects another release: a miss that connects to that release');
  }, { command: ['lcu'] });
});

test('Pi never caches a command whose LCU release and versions cannot be identified', { skip }, async () => {
  for (const command of [countingHost, ['lcu-not-on-path']]) {
    await withCache(async ({ home, spawns, session }) => {
      const first = session();
      const second = session();
      if (command === countingHost) {
        await first.prompt();
        await first.handlers.get('session_shutdown')();
        await second.prompt();
        assert.equal(spawns(), 2, 'each session connects in before_agent_start');
      } else {
        await assert.rejects(first.prompt(), /ENOENT|spawn/);
        await assert.rejects(second.prompt(), /ENOENT|spawn/);
      }
      assert.equal(memory().size, 0, 'nothing is kept in memory');
      assert.equal(existsSync(sharedCache(home)), false, 'nothing is written to the cache directory');
    }, { command });
  }
});

test('Pi treats a corrupt cache file or an entry without exactly js and js_reset as a miss', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const first = session();
    const livePrompt = await first.prompt();
    await first.handlers.get('session_shutdown')();
    const valid = JSON.parse(readFileSync(cacheFile(home), 'utf8'));
    const [key] = Object.keys(valid.entries);
    const live = valid.entries[key];
    const [js, reset] = live.tools;
    const extra = { name: 'turn_ended', description: 'Internal.', inputSchema: { type: 'object' } };
    const variants = [
      ['corrupt JSON', '{"format":1,"entries":'],
      ['wrong types', { tools: 'js', instructions: 1 }],
      ['missing js_reset', { ...live, tools: [js] }],
      ['extra tool', { ...live, tools: [js, reset, extra] }],
      ['duplicate js', { ...live, tools: [js, js] }],
      ['schema not an object', { ...live, tools: [js, { ...reset, inputSchema: [] }] }],
      ['no instructions', { tools: live.tools }],
    ];
    let expected = 1;
    for (const [label, entry] of variants) {
      writeFileSync(cacheFile(home), typeof entry === 'string' ? entry
        : JSON.stringify({ format: 1, entries: { [key]: entry } }));
      memory().clear();
      const next = session();
      assert.equal(await next.prompt(), livePrompt, label);
      assert.equal(spawns(), ++expected, `${label}: connects in before_agent_start`);
      assert.deepEqual(next.registrations, ['js', 'js_reset'], label);
      assert.deepEqual(JSON.parse(readFileSync(cacheFile(home), 'utf8')).entries[key], live,
        `${label}: the connect rewrites the entry`);
      await next.handlers.get('session_shutdown')();
    }
  });
});

test('Pi replaces a cached surface that the host no longer reports and logs only metadata', { skip }, async () => {
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
    assert.equal(await second.prompt(), livePrompt, 'the next before_agent_start uses the live instructions');

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

test('Pi starts no host for agent_end or /lcu stop when no LCU tool ran', { skip }, async () => {
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

test('OMP still connects while its extension loads, even when Pi knows the surface', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const pi = session();
    await pi.prompt();
    await pi.handlers.get('session_shutdown')();
    const record = readFileSync(cacheFile(home), 'utf8');

    const omp = { connectOnLoad: true, ompEssentialTools: true };
    for (const expected of [2, 3]) {
      const made = session(piExtension, omp);
      await made.loaded;
      assert.equal(spawns(), expected, 'OMP connects at load in every session');
      assert.deepEqual(made.registrations, ['js', 'js_reset']);
      assert.ok([...made.tools.values()].every(tool => tool.loadMode === 'essential'));
      const prompt = await made.handlers.get('before_agent_start')({ systemPrompt: ['OMP rules'] }, made.ctx);
      assert.deepEqual(prompt.systemPrompt, ['OMP rules', 'Original CUA initialization guide.']);
      assert.equal(spawns(), expected);
      await made.handlers.get('session_shutdown')();
    }
    assert.equal(readFileSync(cacheFile(home), 'utf8'), record, 'OMP does not write the cache');
  });
});

test('Pi keys the surface on the app and CUA runtime versions of an installed release', { skip }, async () => {
  await withCache(async ({ home, spawns, session }) => {
    const root = join(home, 'r');
    const first = session();
    const livePrompt = await first.prompt();
    assert.equal(spawns(), 1);
    const second = session();
    assert.equal(await second.prompt(), livePrompt);
    assert.equal(spawns(), 1, 'same release, app and runtime: known');

    setVersions(root, { app: '1.0', runtime: '0.0.2/b' });
    const third = session();
    assert.equal(await third.prompt(), livePrompt);
    assert.equal(spawns(), 2, 'a new CUA runtime version is a miss');

    if (process.platform === 'darwin') {
      setVersions(root, { app: '2.0', runtime: '0.0.2/b' });
      await session().prompt();
      assert.equal(spawns(), 3, 'a new app version is a miss');
    }
    const before = spawns();
    rmSync(join(resources(root), 'cua_node', 'manifest.json'));
    await session().prompt();
    await session().prompt();
    assert.equal(spawns(), before + 2, 'a release whose runtime version cannot be read is never cached');
  });
});

test('Pi does not use or write the cache on Windows', { skip }, async () => {
  // Fakes the platform for the adapter's check; the host still starts as on this POSIX system.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  await withCache(async ({ home, spawns, session }) => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      for (const expected of [1, 2]) {
        const made = session();
        assert.match(await made.prompt(), /Original CUA initialization guide/);
        assert.equal(spawns(), expected, 'every session connects in before_agent_start');
        await made.handlers.get('session_shutdown')();
      }
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    assert.equal(memory().size, 0);
    assert.deepEqual(readdirSync(home).filter(name => !['mcp.jsonl', 'r', 'spawns'].includes(name)), [],
      'no cache directory is created');
  });
});
