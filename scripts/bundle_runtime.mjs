// Install-time half of scripts/bundle.py: VERSION, architecture, inventory and verify.
// (`seal` stays a release-build step in scripts/bundle.py; lcu/compat/hash.mjs reproduces both halves byte for
// byte and is covered by tests/compat/test_hash.py.) Paths are absolute strings; inventory() returns a Map.
import { architecture, inventory as hashInventory, verify as hashVerify } from '../lcu/compat/hash.mjs';

export const VERSION = '0.9.7';

export { architecture };

/** bundle.inventory(root, target) */
export function inventory(root, target = 'linux') {
  return hashInventory(root, target);
}

/** bundle.verify(root, arch, target): returns the manifest Map. */
export function verify(root, arch, target = 'linux') {
  return hashVerify(root, VERSION, arch, target);
}
