// A separate Claude-shaped parent for routing tests: its relay and hooks are direct child processes.
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { registryDirectory } from '../../lcu/claude_lifecycle.mjs';

const client = new Client({ name: 'lcu-routing-fixture', version: '1' });
const relay = fileURLToPath(new URL('../claude.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./claude-fixture.mjs', import.meta.url));
await client.connect(new StdioClientTransport({ command: process.execPath, args: [relay, process.execPath, fixture],
  env: process.env, stderr: 'inherit' }));
// MCP serves before optional lifecycle publication. Routing tests require both.
const directory = registryDirectory();
const deadline = Date.now() + 35_000;
while (!existsSync(directory) ||
       !readdirSync(directory).some(name => name.startsWith(`${process.pid}-`) && name.endsWith('.json'))) {
  if (Date.now() >= deadline) throw new Error('Lifecycle registration did not become ready');
  await new Promise(resolve => setTimeout(resolve, 20));
}
process.send({ ready: true });
process.on('message', async ({ id, action, hook, params }) => {
  try {
    let result;
    if (action === 'hook') {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../lcu/claude_hook.mjs', import.meta.url))],
        { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdin.end(JSON.stringify(hook));
      const code = await new Promise(resolve => child.on('close', resolve));
      result = { code, stdout, stderr };
    } else if (action === 'tool') result = await client.callTool(params);
    else if (action === 'close') await client.close();
    process.send({ id, result }, () => { if (action === 'close') process.disconnect(); });
  } catch (error) { process.send({ id, error: error.message }); }
});
