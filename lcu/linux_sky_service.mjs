// Forward the original Sky service unchanged, except for window-targeted input that the
// original Linux engine delivers with XSendEvent to toolkits that ignore it (GTK 4: press_key,
// clicks, scroll, drag and pointer moves; Qt: scroll). For those windows only, the same action is
// issued through the engine's own desktop-level call (XTEST) after the engine's own activate_window,
// with window-relative coordinates converted to desktop coordinates. No input is implemented here,
// and no key state is kept: key_down and key_up always go to the original service unchanged.
// A window is translated only when the X server itself says which local process owns it (the
// X-Resource extension, SO_PEERCRED on the server side) and that process is the one _NET_WM_PID
// names, in this PID namespace; anything else is left to the original service. That identity is
// trusted only after the helper proved that the X server runs in this PID namespace: the listening
// process of the display's local socket is found through /proc and must share this process's PID
// namespace link (a TCP display, an unidentifiable server or another namespace fails closed), and the
// server's record of the helper's own client must equal getpid(). Every call that can change focus or
// input state (translated or not: activate_window, desktop-level and window-targeted input of any kind,
// pass-through fallbacks) runs through one queue, so nothing interleaves between a translated request's
// final focus check and its input. Read-only calls bypass the queue. Each original call made from the
// queue is bounded (a translated drag, click hold or key hold adds time for its input, up to a cap); on a
// timeout the buttons and keys that translated call itself pressed are released with XTEST, then the
// trusted worker (and with it the original engine process) is stopped so a late call cannot deliver
// input, and the call fails. If the target cannot be focused, the point is outside the target, the X
// server reports another window (a notification, a tooltip, an override-redirect popup) under a
// desktop-level pointer action's first point, another client holds an active pointer grab, or the target
// owns a modal dialog and the input is a pointer action, a translated call fails with an explicit error
// and sends nothing.
import {pathToFileURL} from 'node:url';
import {execFile} from './compat/spawn.mjs';
import {readFile, readlink, readdir} from 'node:fs/promises';
import {hostname} from 'node:os';

const TOOLKIT_TTL_MS = 10_000;
const ACTIVATE_DEADLINE_MS = 1500;
const ACTIVATE_POLL_MS = 40;
const XPROP_TIMEOUT_MS = 3000;
const XRES_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_TOOLKITS = 'gtk4,qt-scroll';
// Windows of these runtimes handle XSendEvent themselves even if they map a GTK 4 library
// (Chromium and Electron mmap icudtl.dat; Firefox is libxul).
const NOT_GTK4 = [/\/icudtl\.dat/, /\/libxul\.so/, /\/libffmpeg\.so/];

// Questions only the X server (and the kernel) can answer, asked through minimal ctypes use of libX11,
// libXRes and libXtst (Debian/Ubuntu packages libxres1 and libxtst6). Every failure prints nothing, which
// means "unknown".
//   socket: prints 1 when the X server behind $DISPLAY provably runs in this PID namespace, else 0. Only a
//     local display qualifies (:N, unix:N). The listening socket is found in /proc/net/unix (the abstract
//     name @/tmp/.X11-unix/XN and the file /tmp/.X11-unix/XN), every process holding it is found through
//     /proc/*/fd (only processes this one can read), and each must have the same /proc/<pid>/ns/pid link as
//     this process. A TCP or remote display, an unreadable holder or no holder at all is 0. A process listed
//     in this /proc is in this PID namespace or one below it, so a server in another namespace is never found.
//   xres WINDOW: only the second half of pid, for tests: the process id without the socket proof, which
//     is what LCU trusted before 0.8.7 (see the regression test in tests/linux_xres_namespace.py).
//   pid WINDOW: the local process the X server attributes to the window's client: XResQueryClientIds
//     with XRES_CLIENT_ID_PID_MASK (X-Resource 1.2) returns the SO_PEERCRED process id of the connection
//     and nothing for a client on another machine. Asked only when the socket proof above holds, and then
//     also only when the server's record of the helper's own client (a 1x1 window it creates and never
//     maps) equals os.getpid(): an additional condition, no longer the only proof, because equal numbers
//     in distinct PID namespaces prove nothing.
//   guard WINDOW [X Y]: one JSON line. buttons and keys are the pointer buttons (1-5) and key codes the X
//     server reports pressed now (XQueryPointer, XQueryKeymap); modifiers lists the modifier key codes. With a
//     root point it also reports grab and owner. grab is the result of a brief XGrabPointer on the root with no
//     event mask, undone at once (0 free; 1 another client holds an active pointer grab, such as a popup menu
//     or a drag in progress; 4 frozen; anything else is not usable): the grab changes nothing on the
//     desktop, but pointer events arriving during that round trip (well under a millisecond) are not
//     delivered to anyone. owner is true when the deepest mapped window the X server finds at root point
//     (X, Y) is WINDOW or one of its descendants (the chain from the root down passes through WINDOW, so a
//     window-manager frame above it is fine), false when it is any other window, such as an overlay.
//     XTranslateCoordinates only reads; it moves nothing and honors input shapes.
//   release BUTTONS KEYS: comma-separated lists; releases each with XTEST (XTestFakeButtonEvent,
//     XTestFakeKeyEvent), prints 1 on success. LCU calls it only for what a timed-out call itself pressed.
export const XRES_HELPER_SCRIPT = `
import ctypes, json, os, sys

def x_server_in_this_namespace():
    name = os.environ.get('DISPLAY', '')
    if name.startswith('unix:'):
        name = name[4:]
    if not name.startswith(':'):
        return False  # TCP, a remote host or no display
    number = name[1:].split('.')[0]
    if not (number.isascii() and number.isdigit()):
        return False
    names = {'/tmp/.X11-unix/X' + number, '@/tmp/.X11-unix/X' + number}
    inodes = set()
    with open('/proc/net/unix') as table:
        next(table)
        for line in table:
            fields = line.split()
            if len(fields) >= 8 and fields[7] in names and int(fields[3], 16) & 0x10000:  # __SO_ACCEPTCON
                inodes.add(fields[6])
    if not inodes:
        return False
    mine = os.readlink('/proc/self/ns/pid')
    holders = {}
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            descriptors = os.listdir('/proc/%s/fd' % entry)
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                target = os.readlink('/proc/%s/fd/%s' % (entry, descriptor))
            except OSError:
                continue
            if target.startswith('socket:[') and target[8:-1] in inodes:
                holders.setdefault(target[8:-1], set()).add(entry)
    if set(holders) != inodes:
        return False  # a listener whose process cannot be identified
    for pids in holders.values():
        for pid in pids:
            try:
                if os.readlink('/proc/%s/ns/pid' % pid) != mine:
                    return False
            except OSError:
                return False
    return True

mode = sys.argv[1]
if mode == 'socket':
    try:
        print(1 if x_server_in_this_namespace() else 0)
    except Exception:
        print(0)
    sys.exit(0)

class Spec(ctypes.Structure):
    _fields_ = [('client', ctypes.c_ulong), ('mask', ctypes.c_uint)]
class Value(ctypes.Structure):
    _fields_ = [('spec', Spec), ('length', ctypes.c_long), ('value', ctypes.c_void_p)]
class ModifierMap(ctypes.Structure):
    _fields_ = [('per_modifier', ctypes.c_int), ('codes', ctypes.POINTER(ctypes.c_ubyte))]
x11 = ctypes.CDLL('libX11.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XCreateSimpleWindow.restype = ctypes.c_ulong
x11.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                    ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XTranslateCoordinates.restype = ctypes.c_int
x11.XTranslateCoordinates.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                      ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)]
x11.XQueryPointer.restype = ctypes.c_int
x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                              ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                              ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
x11.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_char * 32]
x11.XGetModifierMapping.restype = ctypes.POINTER(ModifierMap)
x11.XGetModifierMapping.argtypes = [ctypes.c_void_p]
x11.XFreeModifiermap.argtypes = [ctypes.POINTER(ModifierMap)]
x11.XGrabPointer.restype = ctypes.c_int
x11.XGrabPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_uint, ctypes.c_int, ctypes.c_int,
                             ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
x11.XUngrabPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong]

if mode == 'pid':
    try:
        if not x_server_in_this_namespace():
            sys.exit(1)
    except Exception:
        sys.exit(1)
display = x11.XOpenDisplay(None)
if not display:
    sys.exit(1)
root = x11.XDefaultRootWindow(display)

def pressed():
    mask = ctypes.c_uint()
    a, b, c, d = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int()
    e, f = ctypes.c_int(), ctypes.c_int()
    if not x11.XQueryPointer(display, root, ctypes.byref(a), ctypes.byref(b), ctypes.byref(c), ctypes.byref(d),
                             ctypes.byref(e), ctypes.byref(f), ctypes.byref(mask)):
        sys.exit(1)
    buttons = [number for number in range(1, 6) if mask.value & (1 << (7 + number))]
    keymap = (ctypes.c_char * 32)()
    x11.XQueryKeymap(display, keymap)
    keys = [byte * 8 + bit for byte in range(32) for bit in range(8) if keymap[byte][0] & (1 << bit)]
    table = x11.XGetModifierMapping(display)
    if not table:
        sys.exit(1)
    count = 8 * table.contents.per_modifier
    modifiers = sorted({table.contents.codes[i] for i in range(count)} - {0})
    x11.XFreeModifiermap(table)
    return buttons, keys, modifiers

if mode == 'guard':
    buttons, keys, modifiers = pressed()
    answer = {'buttons': buttons, 'keys': keys, 'modifiers': modifiers, 'grab': None, 'owner': None}
    if len(sys.argv) > 4:
        target, px, py = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
        grab = x11.XGrabPointer(display, root, 0, 0, 1, 1, 0, 0, 0)  # GrabModeAsync twice, CurrentTime
        if grab == 0:
            x11.XUngrabPointer(display, 0)
        x11.XSync(display, 0)
        answer['grab'] = grab
        chain, current = [], root
        while len(chain) < 64:
            dx, dy, child = ctypes.c_int(), ctypes.c_int(), ctypes.c_ulong()
            if not x11.XTranslateCoordinates(display, root, current, px, py, ctypes.byref(dx), ctypes.byref(dy), ctypes.byref(child)):
                sys.exit(1)
            if child.value == 0:
                break
            current = child.value
            chain.append(current)
        else:
            sys.exit(1)
        answer['owner'] = target in chain
    print(json.dumps(answer))
    sys.exit(0)

if mode == 'release':
    xtst = ctypes.CDLL('libXtst.so.6')
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    for number in [int(item) for item in sys.argv[2].split(',') if item]:
        xtst.XTestFakeButtonEvent(display, number, 0, 0)
    for code in [int(item) for item in sys.argv[3].split(',') if item]:
        xtst.XTestFakeKeyEvent(display, code, 0, 0)
    x11.XFlush(display)
    x11.XSync(display, 0)
    print(1)
    sys.exit(0)

xres = ctypes.CDLL('libXRes.so.1')
xres.XResQueryExtension.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
xres.XResQueryVersion.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
xres.XResQueryClientIds.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.POINTER(Spec),
                                    ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.POINTER(Value))]
xres.XResGetClientPid.argtypes = [ctypes.POINTER(Value)]
xres.XResGetClientPid.restype = ctypes.c_int
xres.XResClientIdsDestroy.argtypes = [ctypes.c_long, ctypes.POINTER(Value)]
a, b = ctypes.c_int(), ctypes.c_int()
if not xres.XResQueryExtension(display, ctypes.byref(a), ctypes.byref(b)):
    sys.exit(1)
if not xres.XResQueryVersion(display, ctypes.byref(a), ctypes.byref(b)) or (a.value, b.value) < (1, 2):
    sys.exit(1)

def client_pid(xid):
    spec = Spec(xid, 1 << 1)
    count = ctypes.c_long()
    values = ctypes.POINTER(Value)()
    if xres.XResQueryClientIds(display, 1, ctypes.byref(spec), ctypes.byref(count), ctypes.byref(values)) != 0:  # Success is 0
        return None
    pids = {xres.XResGetClientPid(ctypes.byref(values[i])) for i in range(count.value)}
    xres.XResClientIdsDestroy(count, values)
    pids.discard(-1)
    return pids.pop() if len(pids) == 1 else None

if mode in ('pid', 'xres'):
    own = x11.XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0)
    x11.XFlush(display)
    if client_pid(own) != os.getpid():  # the server numbers processes differently (or lies)
        sys.exit(1)
    pid = client_pid(int(sys.argv[2]))
    if pid:
        print(pid)
`;

// Replaceable by tests only.
export const deps = {
  readFile: path => readFile(path, 'utf8'),
  readLink: path => readlink(path),
  hostname: () => hostname(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  xprop: args => new Promise((resolve, reject) => {
    execFile('xprop', args, {timeout: XPROP_TIMEOUT_MS, env: {...process.env, LC_ALL: 'C'}, maxBuffer: 1 << 16},
      (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  }),
  // The X server's process id for the window's client, only when the server shares this PID namespace; else null.
  xresPid: async windowId => {
    const pid = Number(await xHelper(['pid', String(windowId)]));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  },
  // The X input state and, with a root point, the pointer grab and the window at the point (see the helper's
  // "guard" question); null when unknown.
  guard: async (windowId, point) => {
    const args = ['guard', String(windowId)];
    if (point) args.push(String(point.x), String(point.y));
    try {
      const answer = JSON.parse(await xHelper(args));
      const numbers = value => Array.isArray(value) && value.every(Number.isInteger);
      return numbers(answer.buttons) && numbers(answer.keys) && numbers(answer.modifiers) ? answer : null;
    } catch {
      return null;
    }
  },
  // Releases buttons and key codes with XTEST; true when the helper reports success.
  releaseHeld: async (buttons, keys) => await xHelper(['release', buttons.join(','), keys.join(',')]) === '1',
  // Ends the original engine processes (sky_linux_*, children of this worker) so that a call that did not answer
  // cannot act when it resumes: SIGTERM, then SIGCONT because a stopped process acts on a pending signal only once
  // continued. Waits briefly for them to be gone. Not every original transport kills its child when the worker exits.
  stopEngines: async () => {
    const parents = new Map();
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
        parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
      } catch { /* exited */ }
    }
    const below = new Set([process.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, parent] of parents) if (below.has(parent) && !below.has(pid)) { below.add(pid); grew = true; }
    }
    below.delete(process.pid);
    const engines = [];
    for (const pid of below) {
      try {
        const argv0 = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0];
        if (argv0.slice(argv0.lastIndexOf('/') + 1).startsWith('sky_linux_')) engines.push(pid);
      } catch { /* exited */ }
    }
    for (const pid of engines) { try { process.kill(pid, 'SIGTERM'); process.kill(pid, 'SIGCONT'); } catch { /* gone */ } }
    const gone = async pid => {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat[stat.lastIndexOf(')') + 2] === 'Z';
      } catch { return true; }
    };
    for (let round = 0; round < 20; round++) {
      if ((await Promise.all(engines.map(gone))).every(Boolean)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  },
  // Stops this trusted worker, and with it the original engine process, so that no timed-out call can act late.
  // node_repl reports the exit and starts a fresh worker for the next request.
  restartWorker: () => { setImmediate(() => process.exit(70)); },
};

function xHelper(args) {
  return new Promise(resolve => {
    execFile('python3', ['-c', XRES_HELPER_SCRIPT, ...args], {timeout: XRES_TIMEOUT_MS, maxBuffer: 1 << 12},
      (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
}

let original;
let queue = Promise.resolve();
let stopped = false;
const toolkitByPid = new Map();
const PASS = Symbol('pass');

// Atomic chords are translated; key_down and key_up never are (the original engine owns held keys).
const KEY_METHODS = new Set(['press_key']);
// Calls that neither move focus nor change input state; everything else (including unknown methods) is queued.
const READ_ONLY_METHODS = new Set(['list_windows', 'list_apps', 'get_screenshot', 'get_window_state']);
const POINTER_METHODS = new Set(['click', 'scroll', 'drag', 'move']);

class Rejection extends Error {}

export function resetForTests() {
  original = undefined;
  queue = Promise.resolve();
  stopped = false;
  toolkitByPid.clear();
}

function enabledToolkits(env) {
  const raw = env.LCU_LINUX_INPUT_TOOLKITS ?? DEFAULT_TOOLKITS;
  return new Set(raw.split(',').map(item => item.trim()).filter(Boolean));
}

function disabled(env) {
  return ['off', '0', 'false', 'no'].includes(String(env.LCU_LINUX_INPUT_TRANSLATION ?? '').trim().toLowerCase());
}

function xprop(args) {
  return deps.xprop(args);
}

function cardinals(output, name) {
  const match = new RegExp(`^${name}\\([A-Z_]+\\)\\s*=\\s*(.*)$`, 'm').exec(output);
  return match ? match[1].split(',').map(item => item.trim()).filter(Boolean) : null;
}

function sameHost(machine) {
  if (typeof machine !== 'string' || !machine) return false;
  const normalize = name => String(name).trim().toLowerCase().replace(/\.$/, '');
  return normalize(machine) === normalize(deps.hostname());
}

async function windowProperties(id) {
  const output = await xprop(['-id', String(id), '_NET_WM_PID', 'WM_CLIENT_MACHINE', 'WM_TRANSIENT_FOR', '_NET_WM_STATE']);
  const pid = Number(cardinals(output, '_NET_WM_PID')?.[0]);
  const parent = /^WM_TRANSIENT_FOR\(WINDOW\):\s*window id #\s*(0x[0-9a-f]+)/im.exec(output)?.[1] ?? null;
  const state = cardinals(output, '_NET_WM_STATE') ?? [];
  const machine = /^WM_CLIENT_MACHINE\([A-Z_]+\)\s*=\s*"(.*)"\s*$/m.exec(output)?.[1] ?? null;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    machine,
    transientFor: parent ? Number.parseInt(parent, 16) : null,
    hidden: state.includes('_NET_WM_STATE_HIDDEN'),
  };
}

async function screenSize() {
  try {
    const values = cardinals(await xprop(['-root', '_NET_DESKTOP_GEOMETRY']), '_NET_DESKTOP_GEOMETRY');
    const [width, height] = (values ?? []).map(Number);
    return width > 0 && height > 0 ? {width, height} : null;
  } catch {
    return null;
  }
}

// Field 22 of /proc/<pid>/stat (process start time in clock ticks); the command name may contain
// spaces and parentheses, so fields are counted after the last closing parenthesis.
async function processStart(pid) {
  try {
    const stat = await deps.readFile(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch {
    return null;
  }
}

// _NET_WM_PID is the client's own claim, in the client's PID namespace and on the client's machine (EWMH).
// It identifies a local process only when the X server's record agrees (see classify) and this process
// shares the process's PID namespace, so a window from another namespace is never classified. Any
// failure to read either namespace link means "not shared".
async function sharesPidNamespace(pid) {
  let theirs;
  try { theirs = await deps.readLink(`/proc/${pid}/ns/pid`); } catch { return false; }
  try { return theirs === await deps.readLink('/proc/self/ns/pid'); } catch { return false; }
}

async function detectToolkit(pid) {
  const start = await processStart(pid);
  if (!start) return null; // an exited process, another account or another PID namespace
  const cached = toolkitByPid.get(pid);
  if (cached && cached.start === start && Date.now() - cached.at < TOOLKIT_TTL_MS) return cached.toolkit;
  toolkitByPid.delete(pid);
  if (!await sharesPidNamespace(pid)) return null;
  let toolkit = null;
  try {
    const maps = await deps.readFile(`/proc/${pid}/maps`);
    if (/\/libgtk-4\.so/.test(maps) && !NOT_GTK4.some(pattern => pattern.test(maps))) toolkit = 'gtk4';
    else if (/\/libQt[56]Core\.so/.test(maps)) toolkit = 'qt';
  } catch {
    return null;
  }
  if (await processStart(pid) !== start) return null; // the id was reused while it was being read
  toolkitByPid.set(pid, {toolkit, start, at: Date.now()});
  return toolkit;
}

// The toolkit is trusted only if the X server's own record of the window's client (a local process id
// from SO_PEERCRED, absent for remote clients, and only asked of a server proven to share this PID
// namespace) equals _NET_WM_PID. Otherwise the window may belong to a process in another PID namespace
// (Flatpak, containers) whose advertised id collides with an unrelated local process, or to a remote
// client, and the request is left to the original service. `wanted` is checked before the X helper is
// started, so an untranslated request (a Qt key, a Chromium window, a hidden window) never pays for it.
async function classify(id, wanted) {
  const properties = await windowProperties(id);
  if (!properties.pid || !sameHost(properties.machine)) return {...properties, toolkit: null};
  const toolkit = await detectToolkit(properties.pid);
  if (!toolkit || !wanted(toolkit, properties)) return {...properties, toolkit: null};
  let authoritative = null;
  try { authoritative = await deps.xresPid(id); } catch { /* unknown */ }
  return {...properties, toolkit: authoritative === properties.pid ? toolkit : null};
}

// Every call the queue makes to the original service is bounded. A call that does not answer in time is
// not merely abandoned (it could still deliver its input later, in the middle of a later request): the
// worker is stopped, which ends the original engine process, and the queue refuses everything after it.
// Before that, whatever a translated call itself pressed (buttons, modifiers) is released: the call may
// have pressed them and never reach its release. `options.limitMs` is the budget of a call whose duration
// follows from its input (see translatedBudgetMs); `options.held` describes what the call could press.
function callTimeoutMs(env) {
  const value = Number(env.LCU_LINUX_INPUT_CALL_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? value : CALL_TIMEOUT_MS;
}

// The time a translated call may take: the base bound (30 s) plus what its input implies, never more than
// the hard cap (5 minutes, or the base if that is larger). A drag adds 20 ms per path point and 2 ms per
// pixel of path length; a click adds its hold duration for every click; a key chord adds its hold duration.
// Anything else keeps the base bound.
export const DRAG_POINT_MS = 20;
export const DRAG_PIXEL_MS = 2;
export const BUDGET_CAP_MS = 300_000;
export function translatedBudgetMs(method, input, base) {
  let extra = 0;
  if (method === 'drag' && Array.isArray(input.path)) {
    let length = 0;
    for (let index = 1; index < input.path.length; index++) {
      length += Math.hypot(input.path[index].x - input.path[index - 1].x, input.path[index].y - input.path[index - 1].y);
    }
    extra = DRAG_POINT_MS * input.path.length + DRAG_PIXEL_MS * Math.ceil(length);
  } else if (method === 'click' && finite(input.duration) && input.duration > 0) {
    extra = input.duration * Math.max(1, finite(input.click_count) ? Math.floor(input.click_count) : 1);
  } else if (method === 'press_key' && finite(input.duration) && input.duration > 0) {
    extra = input.duration;
  }
  return Math.min(base + extra, Math.max(base, BUDGET_CAP_MS));
}

const BUTTON_NUMBERS = {left: 1, l: 1, middle: 2, m: 2, right: 3, r: 3};

// What a translated call could leave pressed: the pointer buttons its action uses (a click's button, the
// left button for a drag, the wheel buttons for a scroll; none for a move), and any key it holds (the
// chord of a key press, or the `key` chord held during a pointer action).
function heldBy(method, input, before) {
  const keyboard = KEY_METHODS.has(method);
  let buttons = [];
  if (method === 'click') buttons = [BUTTON_NUMBERS[String(input.mouse_button ?? 'left').toLowerCase()] ?? 1];
  else if (method === 'drag') buttons = [1];
  else if (method === 'scroll') buttons = [4, 5];
  return {before, buttons, keys: keyboard || typeof input.key === 'string'};
}

// Releases, with XTEST, the buttons and keys the call pressed: pressed now, not pressed when the action
// started, and of a kind the call could press (modifiers only count when no key was part of the action).
async function releaseHeld(held) {
  const now = await deps.guard(0, null);
  if (!now) return;
  const buttons = now.buttons.filter(button => held.buttons.includes(button) && !held.before.buttons.includes(button));
  const keys = held.keys ? now.keys.filter(key => !held.before.keys.includes(key)) : [];
  if (buttons.length || keys.length) await deps.releaseHeld(buttons, keys);
}

function callOriginal(service, request, env, options = {}) {
  if (stopped) throw new Rejection(RESTARTING);
  const limit = options.limitMs ?? callTimeoutMs(env);
  let timer;
  let timedOut = false;
  // After the timeout fired, the outcome of the abandoned call (an engine ended by LCU fails it) is not reported:
  // the caller hears of the timeout only once the engine is ended and the release is done.
  const never = new Promise(() => {});
  const call = Promise.resolve().then(() => service.handleRpc(request)).then(value => timedOut ? never : value, async error => {
    if (timedOut) return never;
    // A call that failed by itself may also have left something pressed.
    if (options.held) { try { await releaseHeld(options.held); } catch { /* best effort */ } }
    throw error;
  });
  const expired = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      stopped = true;
      timedOut = true;
      // First end the engine (it may be stopped rather than hung, and resume), then release what it pressed.
      try { await deps.stopEngines(); } catch { /* best effort */ }
      if (options.held) { try { await releaseHeld(options.held); } catch { /* the worker stops either way */ } }
      try { deps.restartWorker(); } catch { /* the call is refused either way */ }
      reject(new Rejection(`The original Linux input service did not answer "${request.method ?? request.type}" within ` +
        `${Math.round(limit / 1000)} s. LCU stopped it so that the call cannot act later` +
        `${options.held ? ' and released the buttons and keys it had pressed' : ''}; it restarts on the next request. ` +
        'Check the desktop state and repeat the action.'));
    }, limit);
  });
  return Promise.race([call, expired]).finally(() => clearTimeout(timer));
}

const RESTARTING = 'The original Linux input service is restarting after a call that did not answer, so this call was ' +
  'not sent. Repeat the action.';

function listWindows(service, env) {
  return callOriginal(service, {type: 'execute', method: 'list_windows', args: []}, env);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function applies(toolkit, method, toolkits) {
  if (toolkit === 'gtk4') return toolkits.has('gtk4');
  if (toolkit === 'qt') return method === 'scroll' && toolkits.has('qt-scroll');
  return false;
}

function pointsOf(method, input, window) {
  if (method === 'drag') {
    return Array.isArray(input.path) && input.path.length >= 2 &&
      input.path.every(point => point && finite(point.x) && finite(point.y)) ? input.path : null;
  }
  if (method === 'click' || method === 'move') {
    return finite(input.x) && finite(input.y) && input.element_id == null ? [{x: input.x, y: input.y}] : null;
  }
  if (method === 'scroll') {
    if (input.element_id != null) return null;
    if (finite(input.x) && finite(input.y)) return [{x: input.x, y: input.y}];
    if (input.x == null && input.y == null) return [{x: Math.floor(window.width / 2), y: Math.floor(window.height / 2)}];
    return null;
  }
  return [];
}

// The first point of a pointer action (the only point of a click, scroll or move, the start of a
// drag) must lie in the target's client rectangle as it is now; a stale point would otherwise land
// on whatever application is at that place on the desktop. Drag end points may leave the target.
function requireInside(method, points, window) {
  if (!POINTER_METHODS.has(method)) return;
  const point = points[0];
  if (point.x >= 0 && point.y >= 0 && point.x < window.width && point.y < window.height) return;
  throw new Rejection(`The point (${point.x}, ${point.y}) is outside the target window's current bounds ` +
    `(${window.width}x${window.height} at ${window.x},${window.y}), so no input was sent. The window may have moved or ` +
    'been resized; read its current state and repeat the action with coordinates inside it.');
}

function outsideScreen(method, input, screen) {
  if (!screen || !POINTER_METHODS.has(method)) return false;
  return (method === 'drag' ? input.path : [input]).some(point =>
    point.x < 0 || point.y < 0 || point.x >= screen.width || point.y >= screen.height);
}

function desktopInput(method, input, window, points) {
  const {window: _window, ...rest} = input;
  if (method === 'drag') {
    return {...rest, path: points.map(point => ({x: window.x + point.x, y: window.y + point.y}))};
  }
  if (POINTER_METHODS.has(method)) {
    return {...rest, x: window.x + points[0].x, y: window.y + points[0].y};
  }
  return rest;
}

async function modalChild(target, windows) {
  const dialogs = windows.filter(window => window.modal && window.id !== target.id);
  const owned = new Set([target.id]);
  const found = [];
  // A dialog may be transient for another dialog of the same window; follow the chain.
  for (let round = 0; round < 4 && found.length < dialogs.length; round++) {
    for (const dialog of dialogs) {
      if (owned.has(dialog.id)) continue;
      let properties;
      try { properties = await windowProperties(dialog.id); } catch { continue; }
      if (properties.transientFor !== null && owned.has(properties.transientFor)) {
        owned.add(dialog.id);
        found.push(dialog);
      }
    }
  }
  return found.find(window => window.focused) ?? found.at(-1) ?? null;
}

async function waitForFocus(service, id, env) {
  const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
  for (;;) {
    const windows = await listWindows(service, env);
    if ((Array.isArray(windows) ? windows.find(window => window.id === id) : null)?.focused) return;
    if (Date.now() >= deadline) {
      throw new Rejection('LCU could not give keyboard focus to the target window, so its window-targeted input was not sent. ' +
        'Try activating the window and repeating the action.');
    }
    await deps.sleep(ACTIVATE_POLL_MS);
  }
}

// Runs inside the serialized queue: the window list, the modal state and the focus are read for this
// request only after every earlier queued call (translated or not) has finished.
async function translate(service, request, env) {
  const {method} = request;
  const input = request.args[0];
  const target = input.window;
  const keyboard = KEY_METHODS.has(method);

  let plan;
  try {
    const toolkits = enabledToolkits(env);
    const classified = await classify(target.id, (toolkit, properties) => applies(toolkit, method, toolkits) && !properties.hidden);
    if (!classified.toolkit) return PASS;
    const windows = await listWindows(service, env);
    const current = Array.isArray(windows) ? windows.find(window => window.id === target.id) : null;
    if (!current) return PASS; // the original service reports its normal error
    const points = pointsOf(method, input, current);
    if (points === null) return PASS;
    const dialog = classified.toolkit === 'gtk4' ? await modalChild(current, windows) : null;
    if (dialog && !keyboard) {
      // The dialog's toolkit grab discards pointer input for its parent, and the parent's coordinates do
      // not describe the dialog; refuse rather than guess a position.
      throw new Rejection(`The window "${current.title}" has a modal dialog "${dialog.title}" (id ${dialog.id}) that grabs ` +
        'pointer input, so no input was sent. Target the dialog window explicitly with coordinates relative to it.');
    }
    requireInside(method, points, current);
    plan = {points, focus: dialog ?? current, screen: await screenSize()};
  } catch (error) {
    if (error instanceof Rejection) throw error;
    return PASS; // classification is best effort; never block the original behavior
  }

  const {points, focus, screen} = plan;
  if (!focus.focused) {
    await callOriginal(service, {type: 'execute', method: 'activate_window', args: [{window: focus}]}, env);
    await waitForFocus(service, focus.id, env);
  }
  // Read the geometry and the focus again immediately before sending: windows move, CSD shadows differ,
  // and anything else may have taken the focus since.
  const windows = await listWindows(service, env);
  const current = Array.isArray(windows) ? windows.find(window => window.id === target.id) : null;
  if (!current) throw new Rejection('The target window disappeared before its input could be sent.');
  if (!(Array.isArray(windows) ? windows.find(window => window.id === focus.id) : null)?.focused) {
    throw new Rejection('The keyboard focus left the target window before its input could be sent, so nothing was sent. ' +
      'Repeat the action.');
  }
  requireInside(method, points, current);
  const converted = desktopInput(method, input, current, points);
  if (outsideScreen(method, converted, screen)) return PASS; // an off-screen target keeps the original error

  const before = await requireClear(target.id, method, POINTER_METHODS.has(method) ? (method === 'drag' ? converted.path[0] : converted) : null);
  return callOriginal(service, {type: 'execute', method, args: [converted]}, env, {
    limitMs: translatedBudgetMs(method, converted, callTimeoutMs(env)),
    held: heldBy(method, converted, before),
  });
}

// XTEST follows normal pointer routing, so the desktop-level action lands on whatever window the X server
// finds at the point, or goes to a client holding an active pointer grab. Immediately before sending, ask the
// X server (one helper call, nothing is moved or sent): which buttons and keys are down now (the starting
// state of this call, see heldBy), and for a pointer action whether another client holds an active pointer
// grab (a popup menu, a drag in progress: the click would go to it whatever the window chain says) and
// whether the target or one of its descendants is the window at the point (a notification, a tooltip or an
// override-redirect popup can cover a target that is focused and in bounds). Anything but a free pointer and
// the target at the point, or no answer at all, fails the call with an error and sends nothing.
async function requireClear(id, method, point) {
  let state = null;
  try { state = await deps.guard(id, point && {x: Math.round(point.x), y: Math.round(point.y)}); } catch { /* unknown */ }
  if (!state) {
    throw new Rejection(point
      ? `LCU could not confirm with the X server that the target window is the one at the point (${point.x}, ${point.y}) ` +
        'and that no pointer grab is active, so no input was sent.'
      : 'LCU could not read the X server\'s input state, so no input was sent.');
  }
  if (!point) return state;
  if (state.grab === 1 || state.grab === 4) {
    throw new Rejection('Another application holds an active pointer grab (a popup menu, a drag in progress or a similar ' +
      'popup), so a click would go to it instead of the target and no input was sent. Close it or wait, then repeat the action.');
  }
  if (state.grab !== 0) {
    throw new Rejection('LCU could not tell whether another application holds an active pointer grab, so no input was sent.');
  }
  if (state.owner === true) return state;
  throw new Rejection(state.owner === false
    ? `Another window covers the point (${point.x}, ${point.y}) of the target window on the desktop (a notification, tooltip or ` +
      'popup), so no input was sent. Dismiss or wait for it, then repeat the action.'
    : `LCU could not confirm with the X server that the target window is the one at the point (${point.x}, ${point.y}), ` +
      'so no input was sent.');
}

function candidate(request) {
  if (request?.type !== 'execute' || typeof request.method !== 'string' ||
      !(KEY_METHODS.has(request.method) || POINTER_METHODS.has(request.method))) return false;
  const input = Array.isArray(request.args) && request.args.length === 1 ? request.args[0] : null;
  if (!input || !input.window || !Number.isInteger(input.window.id)) return false;
  return !KEY_METHODS.has(request.method) || typeof input.key === 'string';
}

function readOnly(request) {
  return request?.type === 'execute' && READ_ONLY_METHODS.has(request.method);
}

export async function handleRpc(request) {
  const env = globalThis.nodeRepl?.env ?? process.env;
  original ??= import(pathToFileURL(env.LCU_LINUX_SKY_SERVICE_PATH).href);
  const service = await original;
  if (disabled(env) || readOnly(request)) return service.handleRpc(request);
  // One input or focus-changing call at a time, translated or not: planning, activation, the final focus
  // check and the input of a translated request must not interleave with any other such call, including
  // activate_window, desktop-level input and the fallbacks below.
  const run = queue.then(async () => {
    if (stopped) throw new Rejection(RESTARTING);
    if (candidate(request)) {
      const result = await translate(service, request, env);
      if (result !== PASS) return result;
    }
    return callOriginal(service, request, env);
  });
  queue = run.catch(() => {});
  return run;
}
