// Reads JSON lines {"hex": "<document bytes>"}; prints OK:<json attrs of the first Identity|null>, ERR:<reason>
// (ElementTree ParseError) or EXC:<Python class>:<message> per line.
import { createInterface } from 'node:readline';

import { parseAppxManifest } from '../../lcu/compat/appx_xml.mjs';

const oneLine = (text) => text.replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n');

for await (const line of createInterface({ input: process.stdin })) {
  if (!line) continue;
  const bytes = Buffer.from(JSON.parse(line).hex, 'hex');
  try {
    const { identity } = parseAppxManifest(bytes);
    console.log(`OK:${JSON.stringify(identity === null ? null : [...identity].sort())}`);
  } catch (error) {
    if (error.name === 'XmlParseError') console.log(`ERR:${oneLine(error.message)}`);
    else if (['LookupError', 'ValueError', 'UnicodeError', 'UnicodeDecodeError'].includes(error.name)) {
      console.log(`EXC:${error.name}:${oneLine(error.message)}`);
    } else console.log(`CRASH:${error.stack}`.replaceAll('\n', ' | '));
  }
}
