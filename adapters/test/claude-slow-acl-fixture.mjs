// Exercise real asynchronous ACL startup and cancellation on every platform.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runClaudeBridge } from '../claude.mjs';

const [command, ...args] = process.argv.slice(2);
await runClaudeBridge({ command, args,
  lifecycleWaitMs: Number(process.env.LCU_TEST_LIFECYCLE_WAIT_MS || 250),
  lifecycleOptions: {
    runAcl(file, args, options, callback) {
      const mode = process.env.LCU_TEST_ACL;
      const script = mode === 'fail' ? 'process.exit(7)' :
        `const { existsSync } = require('node:fs');
         setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 20);`;
      const child = execFile(process.execPath, ['-e', script, join(process.env.HOME, 'acl-release')],
        { ...options, ...(mode === 'timeout' ? { timeout: 50 } : {}) }, callback);
      writeFileSync(join(process.env.HOME, 'acl-pid'), String(child.pid));
      return child;
    },
  },
});
