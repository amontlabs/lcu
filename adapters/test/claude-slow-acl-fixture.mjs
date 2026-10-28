// Exercise the real ACL subprocess lifecycle without requiring Windows PowerShell.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaudeBridge } from '../claude.mjs';

const [command, ...args] = process.argv.slice(2);
await runClaudeBridge({ command, args, lifecycleOptions: {
  runAcl(file, args, options, callback) {
    const child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, callback);
    writeFileSync(join(process.env.HOME, 'acl-pid'), String(child.pid));
    return child;
  },
} });
