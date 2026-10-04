import json
from pathlib import Path
import shutil
import tempfile
import unittest

from lcu import claude_mod

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / 'adapters/claude-mod/lcu-approve'


class ClaudeModTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / 'home'
        self.home.mkdir()

    def test_shipped_mod_is_a_function_hook_plugin_for_the_lcu_server(self):
        manifest = json.loads((MOD / '.claude-plugin/plugin.json').read_text())
        self.assertEqual(manifest['name'], claude_mod.NAME)
        self.assertEqual(json.loads((MOD / 'hooks/hooks.json').read_text()), {'modules': ['./register.tsx']})
        source = (MOD / 'hooks/register.tsx').read_text()
        self.assertIn("const SERVER = 'lcu'", source)
        for event in ("'classic.Elicitation'", "'tool.call'", "'tool.check'", "'ui.render'"):
            self.assertIn(event, source)
        for label in ('Allow this conversation', 'Always allow', 'Deny'):
            self.assertIn(label, source)

    def test_user_scope_install_is_idempotent_and_omits_the_mod_tests(self):
        target = claude_mod.install(self.home, ROOT)
        self.assertEqual(target, self.home / '.claude/skills/lcu-approve')
        files = {path.relative_to(target).as_posix() for path in target.rglob('*') if path.is_file()}
        self.assertEqual(files, {'.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx'})
        before = {path: path.read_bytes() for path in target.rglob('*') if path.is_file()}
        claude_mod.install(self.home, ROOT)
        self.assertEqual({path: path.read_bytes() for path in target.rglob('*') if path.is_file()}, before)

    def test_project_scope_installs_under_the_project_and_not_the_home(self):
        project = Path(self.temporary.name) / 'project'
        project.mkdir()
        target = claude_mod.install(self.home, ROOT, project=project)
        self.assertEqual(target, project / '.claude/skills/lcu-approve')
        self.assertFalse((self.home / '.claude').exists())

    def test_reinstall_replaces_changed_files_and_drops_files_a_release_no_longer_ships(self):
        target = claude_mod.install(self.home, ROOT)
        (target / 'hooks/register.tsx').write_text('old')
        (target / 'hooks/old.tsx').write_text('stale')
        claude_mod.install(self.home, ROOT)
        self.assertEqual((target / 'hooks/register.tsx').read_bytes(), (MOD / 'hooks/register.tsx').read_bytes())
        self.assertFalse((target / 'hooks/old.tsx').exists())

    def test_a_foreign_plugin_with_the_same_folder_name_is_refused_and_kept(self):
        target = self.home / '.claude/skills/lcu-approve'
        (target / '.claude-plugin').mkdir(parents=True)
        (target / '.claude-plugin/plugin.json').write_text('{"name": "mine"}')
        with self.assertRaisesRegex(ValueError, 'not the LCU mod'):
            claude_mod.install(self.home, ROOT)
        with self.assertRaisesRegex(ValueError, 'not the LCU mod'):
            claude_mod.remove(self.home)
        self.assertEqual(json.loads((target / '.claude-plugin/plugin.json').read_text()), {'name': 'mine'})

    def test_remove_deletes_only_the_mod(self):
        skills = self.home / '.claude/skills'
        (skills / 'other').mkdir(parents=True)
        (skills / 'other/SKILL.md').write_text('keep')
        claude_mod.install(self.home, ROOT)
        self.assertTrue(claude_mod.remove(self.home))
        self.assertFalse((skills / 'lcu-approve').exists())
        self.assertEqual((skills / 'other/SKILL.md').read_text(), 'keep')
        self.assertFalse(claude_mod.remove(self.home))

    def test_missing_mod_in_a_release_names_the_fix(self):
        empty = Path(self.temporary.name) / 'release'
        empty.mkdir()
        with self.assertRaisesRegex(ValueError, 'Reinstall LCU'):
            claude_mod.install(self.home, empty)


if __name__ == '__main__':
    unittest.main()
