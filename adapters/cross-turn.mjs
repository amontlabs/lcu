import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where `lcu cross-turn` records the setting: beside setup.json, in lcu/setup.mjs's state directory. */
export function crossTurnSettingPath(home = homedir(), platform = process.platform) {
  return platform === 'win32'
    ? join(home, 'AppData', 'Local', 'LCU', 'cross-turn.json')
    : join(home, '.local', 'state', 'lcu', 'cross-turn.json');
}

/** Whether cross-turn Computer Use is on. Anything but a regular file with `enabled: true` is off; never throws. */
export function crossTurnEnabled(path = crossTurnSettingPath()) {
  try {
    if (!lstatSync(path).isFile()) return false;
    const setting = JSON.parse(readFileSync(path, 'utf8'));
    return setting !== null && typeof setting === 'object' && !Array.isArray(setting) && setting.enabled === true;
  } catch {
    return false;
  }
}
