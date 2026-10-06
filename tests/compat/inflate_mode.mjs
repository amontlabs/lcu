// Imported first by the archive runners: LCU_TEST_INFLATE_FALLBACK=1 forces the documented zlib.inflateRawSync path
// (lcu/compat/inflate.mjs "bounded one-shot fallback") instead of the undocumented zlib handle.
import { inflateConfig } from '../../lcu/compat/inflate.mjs';

if (process.env.LCU_TEST_INFLATE_FALLBACK === '1') inflateConfig.forceFallback = true;
if (process.env.LCU_TEST_INFLATE_MAX_OUTPUT) inflateConfig.maxOutput = Number(process.env.LCU_TEST_INFLATE_MAX_OUTPUT);
