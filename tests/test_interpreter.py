import os
import shutil
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT)]
from lcu import interpreter

OLD = (3, 9, 6, 'final', 0)
CURRENT = (3, 12, 0, 'final', 0)


def _fake_python(directory, name, version):
    path = Path(directory) / name
    path.write_text(f'#!/bin/sh\n[ "$1" = -c ] && exit {0 if version >= (3, 12) else 1}\nexit 0\n')
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class InterpreterTests(unittest.TestCase):
    def test_current_interpreter_is_kept(self):
        calls = []
        interpreter.ensure('/x/lcu', ['a'], version=CURRENT, execv=lambda *args: calls.append(args))
        self.assertEqual(calls, [])

    def test_too_old_interpreter_reexecs_a_newer_one_found_on_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = _fake_python(tmp, 'python3', (3, 9))
            new = _fake_python(tmp, 'python3.12', (3, 12))
            calls = []
            with patch.dict(os.environ, {'PATH': tmp}):
                os.environ.pop('LCU_PYTHON', None)
                interpreter.ensure('/x/lcu', ['--chrome'], version=OLD, execv=lambda *args: calls.append(args),
                                   extra_dirs=())
            self.assertEqual(calls, [(str(new), [str(new), '-B', '/x/lcu', '--chrome'])])
            self.assertNotEqual(str(old), calls[0][0])

    def test_lcu_python_override_is_preferred(self):
        with tempfile.TemporaryDirectory() as tmp:
            chosen = _fake_python(tmp, 'mypython', (3, 13))
            _fake_python(tmp, 'python3.12', (3, 12))
            calls = []
            with patch.dict(os.environ, {'PATH': tmp, 'LCU_PYTHON': str(chosen)}):
                interpreter.ensure('/x/lcu', [], version=OLD, execv=lambda *args: calls.append(args), extra_dirs=())
            self.assertEqual(calls[0][0], str(chosen))

    def test_no_suitable_interpreter_names_requirement_and_interpreter_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            _fake_python(tmp, 'python3', (3, 9))
            with patch.dict(os.environ, {'PATH': tmp}):
                os.environ.pop('LCU_PYTHON', None)
                with self.assertRaises(ValueError) as caught:
                    interpreter.ensure('/x/lcu', [], version=OLD, execv=lambda *args: None, extra_dirs=())
        message = str(caught.exception)
        self.assertIn('Python 3.12 or newer', message)
        self.assertIn('3.9.6', message)
        self.assertIn(sys.executable, message)
        self.assertIn('LCU_PYTHON', message)

    def test_launchers_check_the_interpreter_before_importing_the_runtime(self):
        for name, runtime in (('lcu', 'lcu.runtime'), ('lcu-session', 'lcu.session')):
            source = (ROOT / 'bin' / name).read_text()
            self.assertLess(source.index('interpreter.ensure'), source.index(f'from {runtime} import'))

    def test_installer_shell_script_selects_python_312(self):
        with tempfile.TemporaryDirectory() as tmp:
            _fake_python(tmp, 'python3', (3, 9))
            for tool in ('uname', 'dirname'):
                (Path(tmp) / tool).symlink_to(shutil.which(tool))
            result = subprocess.run([shutil.which('bash'), str(ROOT / 'scripts/install.sh'), '--help'],
                                    env={'PATH': tmp, 'HOME': tmp},
                                    capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Python 3.12 or newer', result.stderr)


if __name__ == '__main__':
    unittest.main()
