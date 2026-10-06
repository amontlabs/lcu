// Port of tests/test_app_layout.py (every case).
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { locate_codex_tools } from '../../lcu/app_layout.mjs';
import { rejectsWith, tempDir } from './runtime_support.mjs';

describe('CodexApplicationLayoutTests', () => {
  let temporary;
  let resources;
  beforeEach(() => {
    temporary = tempDir();
    resources = join(temporary.path, 'Resources');
    mkdirSync(resources);
  });
  afterEach(() => temporary.cleanup());

  const addPair = (relative, suffix = '') => {
    const cli = join(resources, relative, `codex${suffix}`);
    const host = join(resources, relative, `codex-code-mode-host${suffix}`);
    mkdirSync(join(cli, '..'), { recursive: true });
    writeFileSync(cli, 'original Codex CLI');
    writeFileSync(host, 'original code-mode host');
    return [cli, host];
  };

  it('test_resolves_legacy_and_relocated_original_pairs', () => {
    for (const relative of ['.', 'codex-cli/bin']) {
      const inner = tempDir();
      try {
        resources = join(inner.path, 'Resources');
        mkdirSync(resources, { recursive: true });
        const [cli, host] = addPair(relative);
        const selected = locate_codex_tools(resources);
        assert.deepEqual([selected.cli, selected.code_mode_host], [cli, host], relative);
      } finally {
        inner.cleanup();
      }
    }
  });

  it('test_resolves_windows_executables', () => {
    const [cli, host] = addPair('codex-cli/bin', '.exe');
    const selected = locate_codex_tools(resources, { windows: true });
    assert.deepEqual([selected.cli, selected.code_mode_host], [cli, host]);
  });

  it('test_rejects_partial_and_symlinked_layouts', async () => {
    const [cli] = addPair('codex-cli/bin');
    unlinkSync(join(resources, 'codex-cli/bin/codex-code-mode-host'));
    const [legacy] = addPair('.');
    unlinkSync(legacy);
    await rejectsWith(assert, () => locate_codex_tools(resources), 'ValueError', /complete original Codex CLI layout/);

    const external = join(temporary.path, 'external-codex');
    writeFileSync(external, 'outside app');
    unlinkSync(cli);
    symlinkSync(external, cli);
    writeFileSync(join(resources, 'codex-cli/bin/codex-code-mode-host'), 'host');
    await rejectsWith(assert, () => locate_codex_tools(resources), 'ValueError', /complete original Codex CLI layout/);
  });

  it('test_rejects_ambiguous_complete_layouts', async () => {
    addPair('.');
    addPair('codex-cli/bin');
    await rejectsWith(assert, () => locate_codex_tools(resources), 'ValueError', /Ambiguous original Codex CLI layout/);
  });

  it('a symlinked intermediate directory is rejected (Path.relative_to(root).parts walk)', async () => {
    const real = join(temporary.path, 'real-bin');
    mkdirSync(real);
    writeFileSync(join(real, 'codex'), 'x');
    writeFileSync(join(real, 'codex-code-mode-host'), 'x');
    mkdirSync(join(resources, 'codex-cli'));
    symlinkSync(real, join(resources, 'codex-cli/bin'));
    await rejectsWith(assert, () => locate_codex_tools(resources), 'ValueError', /complete original Codex CLI layout/);
  });

  it('error text names the normalised resources path', async () => {
    await rejectsWith(assert, () => locate_codex_tools(resources + '/'), 'ValueError',
      new RegExp(`layout in application resources: ${resources}$|layout: ${resources}$`));
  });
});
