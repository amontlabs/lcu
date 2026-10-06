const { config, record, defaultManifests } = require('./fake-config.cjs');
const cfg = config().manifest || { correct: true, manifestPath: null };
record({ tool: 'chrome-check-native-host-manifest', argv: process.argv.slice(2), cwd: process.cwd() });
if (cfg.stderr) process.stderr.write(cfg.stderr);
if (cfg.raw !== undefined) process.stdout.write(cfg.raw);
else if (!cfg.none) process.stdout.write(JSON.stringify({ ...cfg, manifestPath: cfg.manifestPath ?? defaultManifests()[0] }) + '\n');
process.exitCode = cfg.exit || 0;
