// Fake original Sky macOS client module (targets/mac/client.js): what macos_sky_service.mjs imports to ask the
// signed app for status, app policy and Stop. Every call is recorded; replies and failures come from $RT_SKY:
//   {"reply": {"<RequestType>": value}, "fail": {"<RequestType>": "message"}, "policy": {"<app>": {decision, target}}}
import { appendFileSync } from 'node:fs';

const cfg = JSON.parse(process.env.RT_SKY || '{}');
const record = (entry) => appendFileSync(process.env.LCU_BB_LOG, JSON.stringify(entry) + '\n');
const STATUS = {
  computerUse: { activeApplications: [{ bundleIdentifier: 'com.apple.TextEdit', id: 'app-textedit' },
    { bundleIdentifier: 'com.apple.Notes', id: 'app-notes' }] },
  computerHistory: [],
};

export class MacComputerUseClient {
  async request(type, payload, options) {
    record({ tool: 'sky-client:request', type, payload, options });
    if (cfg.fail?.[type]) throw Error(cfg.fail[type]);
    if (cfg.reply && type in cfg.reply) return cfg.reply[type];
    return type === 'ComputerUseIPCCodexStatusItemMenuStateRequest' ? STATUS : {};
  }

  async getAppPolicy(app, options) {
    record({ tool: 'sky-client:getAppPolicy', app, options });
    if (cfg.policy && app in cfg.policy) return cfg.policy[app];
    return { decision: 'allowed', target: { bundleIdentifier: app } };
  }
}
