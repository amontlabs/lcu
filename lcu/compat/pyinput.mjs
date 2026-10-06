// The read half of Python's input(): one line from stdin, interruptible by SIGINT.
//
//   read_line(before, { interrupted, eof })  -> Promise<string>
//
// `before()` runs after the SIGINT listener is installed and before stdin is read (it writes the prompt and flushes
// stdout, the way input() does). A Ctrl-C while the line is awaited rejects with `interrupted()` (the caller's
// KeyboardInterrupt), exactly where CPython's blocking read raises KeyboardInterrupt; the caller's `finally` blocks
// run and lcu/entry.mjs then prints the traceback and ends the process by SIGINT.
//
// Why not readSync: libuv installs its signal handlers with SA_RESTART, so a synchronous read on a terminal is
// restarted after Ctrl-C and a JavaScript listener never runs while it blocks; without a listener the default action
// kills the process before any diagnostic or cleanup. The read is therefore asynchronous on process.stdin, and the
// SIGINT listener exists only while a line is awaited. Bytes after the line stay buffered for the next prompt (like
// sys.stdin's buffer). EOF before any byte is `eof()` (EOFError); a final line without a newline is returned.
const pending = { buffer: Buffer.alloc(0), ended: false };

export function read_line(before = () => {}, { interrupted, eof }) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let attached = false;
    const finish = () => {
      if (!attached) return;
      attached = false;
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      process.off('SIGINT', onSigint);
      stdin.pause();
    };
    const take = () => {
      const at = pending.buffer.indexOf(0x0a);
      if (at >= 0) {
        const line = pending.buffer.subarray(0, at);
        pending.buffer = pending.buffer.subarray(at + 1);
        finish();
        resolve(line.toString('utf8'));
        return true;
      }
      if (pending.ended) {
        const rest = pending.buffer;
        pending.buffer = Buffer.alloc(0);
        finish();
        if (rest.length) resolve(rest.toString('utf8'));
        else reject(eof());
        return true;
      }
      return false;
    };
    function onData(chunk) {
      pending.buffer = Buffer.concat([pending.buffer, chunk]);
      take();
    }
    function onEnd() {
      pending.ended = true;
      take();
    }
    function onError(error) {
      finish();
      reject(error);
    }
    function onSigint() {
      finish();
      reject(interrupted());
    }
    attached = true;
    process.on('SIGINT', onSigint);
    try {
      before();
    } catch (error) {
      finish();
      reject(error);
      return;
    }
    if (take()) return;
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}
