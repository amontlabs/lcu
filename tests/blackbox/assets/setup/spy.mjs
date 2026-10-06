// Spy in front of the app's Node: logs what LCU launches with it (the add-mcp preflight/register children and
// the `skills` CLI), with the complete environment, then returns so the wrapper can exec the real Node.
// The inline `-e` script text is masked: it is an implementation detail, not behaviour.
import { log } from './recorder.mjs';

const HIDDEN = /^(LCU_BB_|PWD$|OLDPWD$|SHLVL$|_$|__CF_USER_TEXT_ENCODING$)/;
const argv = process.argv.slice(2);
const interesting = argv.includes('--input-type=module') || /skills\/bin\/cli\.mjs$/.test(argv[0] || '');
if (interesting) {
  const shown = argv.map((value, index) => (argv[index - 1] === '-e' ? '<inline script>' : value));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !HIDDEN.test(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  log({ tool: 'node-spy', argv: shown, cwd: process.cwd(), env });
}
