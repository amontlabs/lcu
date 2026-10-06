"""lcu/compat/subprocess.mjs run(): execve-format refusal and text-mode newlines, against CPython's subprocess."""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import NodeTestCase, run_node

NODE_RUN = """
const m = await import(COMPAT + 'subprocess.mjs');
emit(input.map((argv) => {
  try {
    const r = m.run(argv, { capture: true, stdin: 'devnull', errors: 'replace' });
    return { ok: [r.returncode, r.stdout, r.stderr] };
  } catch (e) { return { error: e.message }; }
}));
"""


def py_run(argv):
    try:
        r = subprocess.run(argv, capture_output=True, stdin=subprocess.DEVNULL, text=True, encoding='utf-8',
                           errors='replace')
        return {'ok': [r.returncode, r.stdout, r.stderr]}
    except OSError as exc:
        return {'error': str(exc)}


class SubprocessFormatTests(NodeTestCase):
    def test_exec_format_and_newlines_match_python(self):
        with tempfile.TemporaryDirectory() as raw:
            root = os.path.realpath(raw)
            scripts = {
                'noshebang': f"touch '{root}/ran'\n",
                'crlf': "#!/bin/sh\nprintf 'a\\r\\nb\\rc\\n'\nprintf 'e\\r\\n' >&2\nexit 3\n",
                'empty': '',
            }
            for name, body in scripts.items():
                path = os.path.join(root, name)
                with open(path, 'w') as stream:
                    stream.write(body)
                os.chmod(path, 0o755)
            cases = [[os.path.join(root, 'noshebang')], [os.path.join(root, 'crlf')], [os.path.join(root, 'empty')]]
            expected = [py_run(case) for case in cases]
            self.assertFalse(os.path.exists(os.path.join(root, 'ran')))
            got = run_node(NODE_RUN, cases)
            self.assertEqual(got, expected)
            self.assertFalse(os.path.exists(os.path.join(root, 'ran')))
            self.assertEqual(expected[0], {'error': f"[Errno 8] Exec format error: '{root}/noshebang'"})


if __name__ == '__main__':
    unittest.main()
