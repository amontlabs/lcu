// Where LCU's management commands write their output. Tests replace `out` and `err` to read it.
export const terminal = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Print lines to standard output. */
export const say = (...lines) => terminal.out(`${lines.join('\n')}\n`);
/** Print lines to standard error. */
export const warn = (...lines) => terminal.err(`${lines.join('\n')}\n`);
