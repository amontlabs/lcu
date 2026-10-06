// bytes.decode() (strict UTF-8) with CPython 3.12's UnicodeDecodeError text, e.g.
// "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte".
// A leading BOM is kept (U+FEFF), as bytes.decode('utf-8') keeps it. Encoded surrogates (ED A0..BF xx)
// are errors, as in CPython's strict mode (pyjson's decoder allows them: it models surrogatepass).
import { UnicodeDecodeError } from './pyjson.mjs';

const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Python `data.decode()` for a Buffer/Uint8Array; throws UnicodeDecodeError exactly as CPython does. */
export function decode(data) {
  const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
  try {
    return fatal.decode(bytes);
  } catch {
    throw failure(bytes);
  }
}

function failure(bytes) {
  const n = bytes.length;
  const cont = (b) => (b & 0xc0) === 0x80;
  const err = (start, end, reason) => new UnicodeDecodeError('utf-8', start, end, reason, bytes);
  for (let i = 0; i < n;) {
    const b0 = bytes[i];
    if (b0 < 0x80) { i += 1; continue; }
    if (b0 < 0xc2 || b0 > 0xf4) return err(i, i + 1, 'invalid start byte');
    const need = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
    // Validate continuation bytes one at a time, the way CPython reports the first bad one.
    for (let k = 1; k < need; k++) {
      if (i + k >= n) return err(i, n, 'unexpected end of data');
      const b = bytes[i + k];
      let ok = cont(b);
      if (ok && k === 1) {
        if (b0 === 0xe0 && b < 0xa0) ok = false;
        else if (b0 === 0xed && b >= 0xa0) ok = false;
        else if (b0 === 0xf0 && b < 0x90) ok = false;
        else if (b0 === 0xf4 && b >= 0x90) ok = false;
      }
      if (!ok) return err(i, i + k, 'invalid continuation byte');
    }
    i += need;
  }
  // The strict decoder rejected input this scan accepts: report generically at the end.
  return err(0, 1, 'invalid start byte');
}
