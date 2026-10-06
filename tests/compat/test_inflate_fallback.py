"""The documented-API inflate fallback (lcu/compat/inflate.mjs "bounded one-shot fallback").

The undocumented zlib handle is the primary path; when it is absent the readers use zlib.inflateRawSync with a
bound. LCU_TEST_INFLATE_FALLBACK=1 forces that path in the archive runners (tests/compat/inflate_mode.mjs).
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402
from test_zip import bomb_zip, tar_with_bomb_tail  # noqa: E402

BOUNDED_RUNNER = S.ROOT / 'tests/compat/run_bounded.mjs'
ENV = {**os.environ, 'LCU_TEST_INFLATE_FALLBACK': '1'}


class FallbackCorpora(unittest.TestCase):
    def failures(self, env):
        done = subprocess.run([sys.executable, '-m', 'unittest', '-b', 'tests.compat.test_zip', 'tests.compat.test_tar'],
                              cwd=S.ROOT, env=env, capture_output=True, text=True, timeout=600)
        self.assertRegex(done.stderr, r'Ran \d+ tests', done.stderr[-2000:])
        return done.returncode, sorted(set(re.findall(r'^(?:FAIL|ERROR): (\S+) \(', done.stderr, re.M)))

    def test_review_corpora_give_identical_results_and_errors(self):
        # the whole ZIP and tar differential suites (CPython oracle) on the handle path and on the fallback path; the
        # only tests skipped on the fallback are the ones that measure zlib read windows (test_zip.FALLBACK). The
        # failing set must be the same on both (empty wherever the oracle is CPython 3.12.10, the project's reference;
        # other Python patch levels differ in a few tarfile/zipfile details, on both paths alike).
        if S.NODE is None:
            self.skipTest('node >= 22 not available')
        plain = self.failures({**os.environ, 'LCU_TEST_INFLATE_FALLBACK': '0'})
        fallback = self.failures(ENV)
        self.assertEqual(fallback, plain)
        if sys.version_info[:3] >= (3, 12, 10):
            self.assertEqual(fallback, (0, []))


class FallbackBounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def run_bounded(self, kind, blob, **env):
        archive = self.base / f'a.{kind}'
        archive.write_bytes(blob)
        dest = Path(tempfile.mkdtemp(dir=self.base, prefix=f'{kind}-out-'))
        spec = self.base / 'spec.json'
        spec.write_text(json.dumps({'kind': kind, 'archive': str(archive), 'dest': str(dest)}))
        done = subprocess.run([S.NODE, str(BOUNDED_RUNNER), str(spec)], env={**ENV, **env}, capture_output=True,
                              text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertTrue(result['fallback'], 'the fallback path was not the one exercised')
        return result, dest

    def test_zip_declaring_one_byte_allocates_about_one_byte(self):
        result, dest = self.run_bounded('zip', bomb_zip())  # a 32 MiB stream behind a 1 byte declaration
        self.assertTrue(result['ok'], result)
        self.assertEqual((dest / 'bomb').read_bytes(), b'\0')
        self.assertLessEqual(result['peak'], 1 + 1 + 2048, result)  # declared size + 1 (+ slack), never 32 MiB

    def test_zip_with_a_larger_declared_size_stops_at_that_size(self):
        result, dest = self.run_bounded('zip', bomb_zip(file_size=100000, declared=b'\0' * 100000))
        self.assertTrue(result['ok'], result)
        self.assertEqual(len((dest / 'bomb').read_bytes()), 100000)
        self.assertLessEqual(result['peak'], 100000 + 1 + 2048, result)

    def test_tar_stream_is_bounded_by_the_output_limit(self):
        blob = tar_with_bomb_tail()  # 32 MiB of zeros behind the end-of-archive blocks
        limit = 4 << 20
        result, dest = self.run_bounded('tar', blob, LCU_TEST_INFLATE_MAX_OUTPUT=str(limit))
        self.assertTrue(result['ok'], result)  # CPython never reads the tail either
        self.assertEqual((dest / 'f').read_bytes(), b'hello')
        self.assertLessEqual(result['peak'], limit, result)

    def test_tar_default_bound_holds_the_whole_small_tail(self):
        result, dest = self.run_bounded('tar', tar_with_bomb_tail())
        self.assertTrue(result['ok'], result)
        self.assertEqual((dest / 'f').read_bytes(), b'hello')
        self.assertLessEqual(result['peak'], 256 << 20, result)


if __name__ == '__main__':
    unittest.main()
