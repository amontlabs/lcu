// Fake original Chrome native host ("extension-host" / "ChatGPT for Chrome") behind LCU's relay.
// Records argv, cwd and every native-messaging frame it receives (length-prefixed, little-endian uint32), then acts
// per $RT_HOST (JSON):
//   echo: true            reply with each received frame unchanged
//   replies: [{json|text|b64|fill}]   frames to send once stdin is at EOF (or right away with `early: true`)
//   header: n             write a bare 4-byte length header n (then exit)
//   partial: n            write a header announcing n bytes but only n/2 of them
//   exit: n               exit status; noRead: true never reads stdin
import { appendFileSync, readSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';

const cfg = JSON.parse(process.env.RT_HOST || '{}');
const log = (entry) => appendFileSync(process.env.LCU_BB_LOG, JSON.stringify(entry) + '\n');
const writeAll = (buffer) => { let o = 0; while (o < buffer.length) { try { o += writeSync(1, buffer, o); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } };
const frame = (payload) => { const h = Buffer.alloc(4); h.writeUInt32LE(payload.length); return Buffer.concat([h, payload]); };
const describe = (payload) => {
  const text = payload.toString('utf8');
  const valid = Buffer.from(text, 'utf8').equals(payload);
  if (payload.length > 2048) return { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
  return valid ? { bytes: payload.length, text } : { bytes: payload.length, hex: payload.toString('hex') };
};
function body(reply) {
  if (reply.json !== undefined) return Buffer.from(JSON.stringify(reply.json));
  if (reply.text !== undefined) return Buffer.from(reply.text);
  if (reply.b64 !== undefined) return Buffer.from(reply.b64, 'base64');
  return Buffer.alloc(reply.fill, 'b');
}

log({ tool: 'extension-host', argv: process.argv.slice(2), cwd: process.cwd() });
if (cfg.rawHex !== undefined) { writeAll(Buffer.from(cfg.rawHex, 'hex')); process.exit(cfg.exit || 0); }
if (cfg.header !== undefined) { const h = Buffer.alloc(4); h.writeUInt32LE(cfg.header); writeAll(h); process.exit(cfg.exit || 0); }
if (cfg.partial !== undefined) {
  const h = Buffer.alloc(4); h.writeUInt32LE(cfg.partial); writeAll(Buffer.concat([h, Buffer.alloc(cfg.partial >> 1, 'p')]));
  process.exit(cfg.exit || 0);
}
if (cfg.early) for (const reply of cfg.replies || []) writeAll(frame(body(reply)));
if (!cfg.noRead) {
  let pending = Buffer.alloc(0);
  const chunk = Buffer.alloc(1 << 20);
  for (;;) {
    let count;
    try { count = readSync(0, chunk, 0, chunk.length, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; }
    if (count === 0) break;
    pending = Buffer.concat([pending, chunk.subarray(0, count)]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const size = pending.readUInt32LE(0);
      const payload = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      log({ tool: 'extension-host:frame', ...describe(payload) });
      if (cfg.echo) writeAll(frame(payload));
    }
  }
  log({ tool: 'extension-host:eof', leftoverBytes: pending.length });
}
if (!cfg.early) for (const reply of cfg.replies || []) writeAll(frame(body(reply)));
process.exitCode = cfg.exit || 0;
