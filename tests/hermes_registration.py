"""Verify the generated Hermes plugin through the installed Hermes plugin loader.

Set HERMES_PYTHON to the interpreter that runs Hermes to also render its system prompt sections.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys

from lcu_node import call

ROOT = Path(__file__).resolve().parents[1]
TEMP_PARENT = "/private/tmp" if sys.platform == "darwin" else "/tmp" if os.name == "posix" else None


def main() -> None:
    hermes = os.environ.get("HERMES_BIN") or shutil.which("hermes")
    if not hermes:
        raise SystemExit("Set HERMES_BIN or add an installed Hermes CLI to PATH.")
    node = Path(shutil.which("node") or "").resolve()
    if not node.is_file():
        raise SystemExit("Node is required for the original LCU MCP SDK bridge.")

    with tempfile.TemporaryDirectory(prefix="lcu-hermes-registration-", dir=TEMP_PARENT) as temporary:
        root = Path(temporary)
        home = root / "home"
        hermes_home = root / "hermes"
        for directory in (home, hermes_home):
            directory.mkdir(parents=True, exist_ok=True)
        env = {
            "PATH": os.pathsep.join([str(Path(hermes).resolve().parent), str(node.parent), "/usr/bin", "/bin"]),
            "HOME": str(home),
            "HERMES_HOME": str(hermes_home),
        }
        call("harness_setup", "configureHermes", home, [str(node), str(ROOT / "adapters/test/mcp-fixture.mjs")],
             node, ROOT, {"scope": "user", "env": env})
        command = [hermes, "plugins", "doctor", "lcu-cua", "--ci"]
        result = subprocess.run(command, cwd=home, env=env, text=True, capture_output=True, timeout=90)
        output = result.stdout + result.stderr
        if result.returncode != 0:
            raise SystemExit(f"Hermes plugin doctor failed ({result.returncode}):\n{output}")
        expected = "registrations: 2 tool(s), 2 hook(s)"
        if expected not in output or "registration passed" not in output:
            raise SystemExit(f"Hermes plugin doctor did not confirm expected registrations:\n{output}")
        print(f"Hermes native plugin loader passed: {expected}")
        hermes_python = os.environ.get("HERMES_PYTHON")
        if hermes_python:
            # Render the session prompt sections with Hermes' own code; the doctor does not list them.
            script = (
                "import json\n"
                "from hermes_cli.plugins import render_system_prompt_sections\n"
                "sections = render_system_prompt_sections({'session_id': 'lcu-registration'})\n"
                "print(json.dumps([[item.id, item.content] for item in sections]))\n"
            )
            result = subprocess.run([hermes_python, "-c", script], cwd=home, env=env, text=True,
                                    capture_output=True, timeout=90)
            if result.returncode != 0:
                raise SystemExit(f"Hermes prompt section rendering failed ({result.returncode}):\n{result.stderr}")
            sections = dict(json.loads(result.stdout.strip().splitlines()[-1]))
            content = sections.get("lcu-cua.instructions", "")
            if "Original CUA initialization guide." not in content or "inputSchema" in content:
                raise SystemExit(f"Hermes did not render the LCU instructions section:\n{result.stdout}")
            print(f"Hermes rendered system prompt section lcu-cua.instructions ({len(content)} characters)")
        print(f"Isolated HERMES_HOME: {hermes_home}")


if __name__ == "__main__":
    main()
