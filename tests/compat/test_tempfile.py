"""lcu/compat/tempfile.mjs against tempfile.mkstemp / mkdtemp (name shape, modes)."""
import os
import re
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import NodeTestCase, require_node, run_node


class TempfileTests(NodeTestCase):
    def test_names_and_modes_have_the_shape_python_produces(self):
        require_node()
        with tempfile.TemporaryDirectory() as directory:
            got = run_node('''
                const t = await import(COMPAT + 'tempfile.mjs');
                const fs = await import('node:fs');
                const a = t.mkstemp({ prefix: '.x.', suffix: '.s', dir: input });
                fs.closeSync(a.fd);
                const b = t.mkdtemp({ prefix: '.d-', dir: input });
                emit({ a: a.path, am: fs.statSync(a.path).mode & 0o7777, b, bm: fs.statSync(b).mode & 0o7777 });''',
                           directory)
            fd, path = tempfile.mkstemp(prefix='.x.', suffix='.s', dir=directory)
            os.close(fd)
            directory_made = tempfile.mkdtemp(prefix='.d-', dir=directory)
            shape = re.compile(r'^\.x\.[a-z0-9_]{8}\.s$')
            self.assertRegex(os.path.basename(got['a']), shape)
            self.assertRegex(os.path.basename(path), shape)
            self.assertRegex(os.path.basename(got['b']), r'^\.d-[a-z0-9_]{8}$')
            self.assertEqual(os.path.dirname(got['a']), directory)
            self.assertEqual(got['am'], stat.S_IMODE(os.stat(path).st_mode))
            self.assertEqual(got['bm'], stat.S_IMODE(os.stat(directory_made).st_mode))


if __name__ == '__main__':
    unittest.main()
