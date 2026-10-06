// Shared by the fake "upstream" Chrome plugin scripts: scenario-controlled behaviour and call recording.
const fs = require('node:fs');
const path = require('node:path');
exports.config = () => {
  try { return JSON.parse(fs.readFileSync(process.env.LCU_BB_FAKE_BROWSER, 'utf8')); } catch { return {}; }
};
exports.record = (entry) => {
  if (process.env.LCU_BB_LOG) fs.appendFileSync(process.env.LCU_BB_LOG, JSON.stringify(entry) + '\n');
};
exports.NAME = 'com.openai.codexextension.json';
exports.arch = () => ({ arm64: 'arm64', x64: 'x64' }[process.arch] || process.arch);
exports.hostRelative = () => (process.platform === 'darwin'
  ? ['macos', exports.arch(), 'ChatGPT for Chrome'] : ['linux', exports.arch(), 'extension-host']);
// Where the upstream installer writes its manifests per platform (a subset of the real list).
exports.defaultManifests = () => {
  const home = process.env.HOME;
  if (process.platform === 'darwin') {
    return ['Google/Chrome', 'Microsoft Edge'].map((d) => path.join(home, 'Library/Application Support', d, 'NativeMessagingHosts', exports.NAME));
  }
  return ['google-chrome', 'chromium'].map((d) => path.join(home, '.config', d, 'NativeMessagingHosts', exports.NAME));
};
