const { config, record } = require('./fake-config.cjs');
const cfg = config().extension || { installed: true, enabled: true, selectedProfileDirectory: 'Default' };
record({ tool: 'chrome-check-extension-installed', argv: process.argv.slice(2), cwd: process.cwd() });
if (cfg.stderr) process.stderr.write(cfg.stderr);
if (cfg.raw !== undefined) process.stdout.write(cfg.raw); else if (!cfg.none) process.stdout.write(JSON.stringify(cfg) + '\n');
process.exitCode = cfg.exit || 0;
