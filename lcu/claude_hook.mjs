// Claude exec-form hook entry: no app discovery, state writes, subprocesses or MCP startup.
import { deliverLifecycle } from './claude_lifecycle.mjs';
import { isMain, run } from './entry.mjs';

export async function main() {
  let input = '', bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) return 0;
  }
  let hook;
  try { hook = JSON.parse(input); } catch { return 0; }
  await deliverLifecycle(hook);
  return 0;
}

if (isMain(import.meta)) await run('LCU Claude hook', main);
