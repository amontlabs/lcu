// Plain data and parsers for the panes. Nothing here touches `$`: the engine follows `$` only into functions
// declared in the hooks module itself, so every call that needs it is in register.tsx.

export type AppRow = {
  name: string
  bundleId: string
  installed: boolean
  risk: string
  blocked: boolean
}

export type SessionRow = { name: string; bundleId: string; risk?: string }

export type AppsData = { always: AppRow[]; session: SessionRow[] }

export const DEFAULT_LCU = '.local/share/lcu/current/bin/lcu'
export const CONFIG_FILE = 'lcu.json'
export const ICON_PIXELS = '64'
export const ICON_TTL_MS = 6 * 60 * 60 * 1000
export const BUNDLE_ID = /^[A-Za-z0-9._-]+$/

export const ok = (run: { exitCode: number }) => run.exitCode === 0

// The quoted strings of `allowed = [...]` in a session file's `[apps]` table.
export function parseAllowed(toml: string): string[] {
  const section = toml.split(/^\s*\[/m).find(part => part.startsWith('apps]'))
  const list = section?.match(/^\s*allowed\s*=\s*\[([\s\S]*?)\]/m)
  if (!list) return []
  return [...list[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(m => m[1] ?? m[2])
}


export const firstLine = (text: string) => String(text ?? '').trim().split('\n').filter(Boolean).pop() ?? ''

// The runtime's risk warning names its own agent; the person is using Claude, so say what it means.
export const plainWarning = (text: string) =>
  text
    .replace(/Allowing ChatGPT to use this app/g, 'Allowing computer use to control this app')
    .replace(/monitor ChatGPT while it uses this app/g, 'monitor the agent while it uses this app')
    .replace(/ChatGPT/g, 'the agent')

// Whether the terminal draws the picture of an Image (the kitty graphics protocol: kitty, Ghostty); elsewhere
// the Image would leave blank cells before the app's name.
export const drawsImages = (vars: Record<string, string | undefined>) =>
  !vars.TMUX && (Boolean(vars.KITTY_WINDOW_ID || vars.GHOSTTY_RESOURCES_DIR) || vars.TERM === 'xterm-kitty' || vars.TERM_PROGRAM === 'ghostty')
