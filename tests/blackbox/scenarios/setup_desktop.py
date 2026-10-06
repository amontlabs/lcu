"""`lcu setup`: Chrome opt-in (original native-host install before registration, browser status after),
audio opt-in and the desktop-readiness step (--check-desktop, guided on a tty, deferred)."""
import json

import fixtures_setup as fs
from fixtures_setup import setup_scenario

EXTENSION_OK = json.dumps({'installed': True, 'enabled': True, 'selectedProfileDirectory': 'Default'})
MANIFEST_OK = json.dumps({'correct': True, 'manifestPath':
                          '/home/ubuntu/.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json'})


@setup_scenario('setup/chrome-install-and-status')
def _(sb):
    fs.place(sb)
    sb.fake('chrome-check-extension', default={'stdout': EXTENSION_OK})
    sb.fake('chrome-check-manifest', default={'stdout': MANIFEST_OK})
    fs.setup(sb, '--agent', 'codex', '--chrome', label='chrome opt-in')
    fs.setup(sb, '--agent', 'codex', label='chrome kept: host refreshed')


@setup_scenario('setup/chrome-status-variants')
def _(sb):
    fs.place(sb)
    sb.fake('chrome-check-extension', default={'stdout': json.dumps({'installed': True, 'enabled': False})})
    sb.fake('chrome-check-manifest', default={'stdout': 'not json'})
    fs.setup(sb, '--agent', 'claude-code', '--chrome', label='extension disabled, manifest unparseable')
    sb.fake('chrome-check-extension', default={'stderr': 'no chrome profile\n', 'exit': 1})
    sb.fake('chrome-check-manifest', default={})
    fs.setup(sb, '--agent', 'claude-code', label='extension check failed, manifest empty')


@setup_scenario('setup/chrome-install-failures')
def _(sb):
    fs.place(sb)
    sb.fake('chrome-install', mode='fail')
    fs.setup(sb, '--agent', 'codex', '--chrome', label='original installer fails')
    sb.fake('chrome-install', mode='none')
    fs.setup(sb, '--agent', 'codex', '--chrome', label='original installer writes no manifest')
    (sb.apps / 'chatgpt/resources/plugins/openai-bundled/plugins/chrome/scripts/installManifest.mjs').unlink()
    fs.setup(sb, '--agent', 'codex', '--chrome', label='upstream chrome plugin incomplete')
    fs.setup(sb, '--agent', 'codex', '--no-chrome', label='no-chrome after failures')


@setup_scenario('setup/audio-opt-in')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--agent', 'codex', '--agent', 'claude-code', '--audio', label='audio opt-in')
    fs.setup(sb, '--agent', 'codex', '--agent', 'claude-code', label='audio kept')


@setup_scenario('setup/check-desktop')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--agent', 'codex', '--check-desktop', label='required readiness (doctor in a container)')
    fs.setup(sb, '--agent', 'codex', '--check-desktop', '--session', 'discover', direct=False,
             label='required readiness through lcu-session')


@setup_scenario('setup/desktop-guided')
def _(sb):
    fs.place(sb)
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': 'y\n'}], '--agent', 'codex', '--session', 'direct',
                 '--no-chrome', label='guided readiness after a tty confirmation')
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': 'y\n'}], '--agent', 'codex', '--session', 'direct',
                 '--no-chrome', '--check-desktop', label='required readiness on a tty')
    fs.pty_setup(sb, [], '--agent', 'codex', '--session', 'direct', '--yes', label='--yes on a tty: deferred')
