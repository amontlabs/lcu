import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Live Claude CLI lifecycle check with a scripted local provider, disposable HOME, and fake MCP upstream.
// Usage: LCU_CLAUDE_LIVE_TEST=1 node tests/claude_hooks.mjs /absolute/path/to/claude
if (process.env.LCU_CLAUDE_LIVE_TEST !== '1' || !process.argv[2] || process.platform === 'win32') {
  throw new Error('Opt in with LCU_CLAUDE_LIVE_TEST=1 and supply a POSIX Claude CLI path');
}
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = realpathSync(mkdtempSync('/tmp/lcu-claude-hooks-live-'));
const cli = process.argv[2];
console.log(`Evidence: ${root}`);
const { install } = await import(pathToFileURL(join(repo, 'lcu/claude_visibility.mjs')));
console.log(spawnSync(cli, ['--version'], { encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'version-config') } }).stdout.trim());
for (const name of ['absent', 'connected']) {
  const directory = join(root, name);
  for (const part of ['home', 'config', 'cwd']) mkdirSync(join(directory, part), { recursive: true });
  const settingsPath = install(join(directory, 'home'), { root: repo, node: process.execPath });
  const settings = JSON.parse(readFileSync(settingsPath));
  if (name === 'connected') {
    settings.permissions.allow = ['mcp__lcu__js'];
    writeFileSync(settingsPath, JSON.stringify(settings));
  }
  const env = { ...process.env, HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
    CLAUDE_CONFIG_DIR: join(directory, 'config'), LCU_FIXTURE_LOG: join(directory, 'upstream.jsonl'),
    LCU_LOG_DIR: join(directory, 'diagnostics'), LCU_NO_UPDATE_CHECK: '1' };
  for (const key of Object.keys(env)) {
    if ((key.startsWith('CLAUDE_') && key !== 'CLAUDE_CONFIG_DIR') || key.startsWith('ANTHROPIC_')) delete env[key];
  }
  const provider = spawn(process.execPath, [join(repo, 'tests/claude_fake_api.mjs'), join(directory, 'port'),
    join(directory, 'provider.jsonl'), name === 'connected' ? 'mcp__lcu__js' : '__not_a_tool__', '{"code":"issue64-live"}'],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let providerError = '';
  provider.stderr.on('data', chunk => { providerError += chunk; });
  try {
    for (let i = 0; i < 100 && !existsSync(join(directory, 'port')); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!existsSync(join(directory, 'port'))) throw new Error(providerError);
    env.ANTHROPIC_API_KEY = 'issue64-dummy-not-a-credential';
    env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + readFileSync(join(directory, 'port'), 'utf8').trim();
    const mcp = { mcpServers: { lcu: name === 'absent' ? { command: '/usr/bin/false', args: [] } :
      { command: process.execPath, args: [join(repo, 'adapters/claude.mjs'), process.execPath,
        join(repo, 'adapters/test/claude-fixture.mjs')] } } };
    writeFileSync(join(directory, 'mcp.json'), JSON.stringify(mcp));
    const args = ['-p', 'say hi', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--settings', settingsPath, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', join(directory, 'mcp.json'),
      '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--no-chrome'];
    const child = spawn(cli, args, { cwd: join(directory, 'cwd'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timers = [setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 60000),
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 65000)];
    const exit = await new Promise((resolve, reject) => {
      child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal }));
    });
    timers.forEach(clearTimeout);
    writeFileSync(join(directory, 'stdout.jsonl'), stdout);
    writeFileSync(join(directory, 'stderr.txt'), stderr);
    const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const record = { name, cli, args, pid: child.pid, ...exit,
      hooks: events.filter(event => event.subtype === 'hook_response'),
      errors: events.filter(event => event.key === 'stop-hook-error'),
      result: events.filter(event => event.type === 'result'),
      upstream: existsSync(env.LCU_FIXTURE_LOG) ? readFileSync(env.LCU_FIXTURE_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [] };
    writeFileSync(join(directory, 'result.json'), JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ name, ...exit, hooks: record.hooks.map(h => ({ event: h.hook_event, exit: h.exit_code })),
      stopHookErrors: record.errors.length, upstream: record.upstream }));
    if (exit.code !== 0 || record.errors.length || !record.hooks.length || record.hooks.some(h => h.exit_code !== 0 || h.stderr)) throw new Error(`${name} lifecycle failed`);
    if (name === 'connected' && (!record.upstream.some(e => e.type === 'tool-call' && e.name === 'js') ||
      !record.upstream.some(e => e.type === 'turn-ended' && e.args.hook_event_name === 'Stop'))) throw new Error('Connected lifecycle missing');
  } finally { provider.kill('SIGTERM'); }
}
