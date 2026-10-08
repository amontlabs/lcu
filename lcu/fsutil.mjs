// Small filesystem and quoting helpers shared by the LCU modules.

const { lstatSync, readFileSync, realpathSync, statSync } = process.getBuiltinModule('node:fs');
const { resolve, sep } = process.getBuiltinModule('node:path');

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** `lstat`, or null when the path cannot be read. */
export const lstat = (path) => { try { return lstatSync(path); } catch { return null; } };
/** A regular file or directory, following symbolic links. */
export const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
export const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** A regular file that is not itself a symbolic link. */
export const isRegular = (path) => { try { return lstatSync(path).isFile(); } catch { return false; } };
export const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
/** The resolved real path, or the absolute path when it does not exist. */
export const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** `path` is `root` or below it (both already resolved). */
export const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** One POSIX shell word, quoted only when it needs to be. */
export const shellQuote = (arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : quoteAlways(arg));
/** One POSIX shell word, always single-quoted (for generated scripts). */
export const quoteAlways = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;
