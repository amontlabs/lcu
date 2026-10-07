"""Supervise the original macOS client turn-ended command for one MCP process."""
import calendar
import signal
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
from queue import Empty, Queue
from threading import Condition, Event, Lock, Thread
from uuid import uuid4


SKY_SERVICE_NAME = 'SkyComputerUseService'
# `ps` reports the start time in whole seconds and the file time has sub-second
# precision, so a change this close to the start is never read as an update.
STALE_MARGIN_SECONDS = 2
_MONTHS = {name: number for number, name in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}


def parse_process_start(fields):
    """UTC epoch seconds from the five `ps lstart` fields, or None when malformed."""
    try:
        _, month, day, clock, year = fields
        hour, minute, second = (int(part) for part in clock.split(':'))
        month, day, year = _MONTHS[month], int(day), int(year)
        if not (1 <= day <= 31 and 0 <= hour <= 23 and 0 <= minute <= 59 and
                0 <= second <= 60 and 1970 <= year <= 9999):
            return None
        # `ps` is run with TZ=UTC, so there is no local-time ambiguity at DST changes.
        return float(calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0)))
    except (KeyError, ValueError, OverflowError):
        return None


def parse_process_table(text):
    """Return running Sky services from `ps -axo pid=,uid=,lstart=,comm=` output.

    Lines that name the service but cannot be parsed are counted, not guessed at.
    """
    services, unparsed = [], 0
    for line in text.splitlines():
        if SKY_SERVICE_NAME not in line:
            continue
        # pid, uid, then lstart as `Wed Oct  7 00:34:53 2026`, then the executable path
        # (which may contain spaces).
        fields = line.split(None, 7)
        started = parse_process_start(fields[2:7]) if len(fields) == 8 else None
        path = fields[7].strip() if len(fields) == 8 else ''
        if (started is None or not fields[0].isdigit() or not fields[1].isdigit() or
                not os.path.isabs(path) or os.path.basename(path) != SKY_SERVICE_NAME):
            unparsed += 1
            continue
        services.append({'pid': int(fields[0]), 'uid': int(fields[1]), 'path': path, 'started': started})
    return services, unparsed


def bundle_replaced_at(executable, stat=os.stat):
    """When the service bundle on disk was last replaced, or None when that is unknown.

    This is the oldest inode change time (ctime) among the executable, the bundle
    Info.plist and its code-signature seal. An app update replaces the whole bundle:
    observed live, all 167 files had the update time as ctime while their mtimes
    (build time) and creation times were days to months older, so neither of those
    can detect it. Requiring all three to have changed keeps one metadata change
    (chmod, an extended attribute) on a single file from reading as an update, so
    when any of them is missing or unreadable the answer is None, not a guess.
    Starting the service does not change ctime.
    """
    try:
        contents = Path(executable).parents[1]
        return min(stat(path).st_ctime for path in (
            executable, contents / 'Info.plist', contents / '_CodeSignature' / 'CodeResources'))
    except (OSError, IndexError):
        return None


def _ps_environment():
    """English month names and UTC times; UTF-8 so `ps` does not escape non-ASCII paths."""
    environment = {key: value for key, value in os.environ.items() if key != 'LC_ALL'}
    environment.update(LC_TIME='C', LC_CTYPE='UTF-8', TZ='UTC')
    return environment


def diagnose_sky_services(*, run=subprocess.run, stat=os.stat):
    """List running Sky services and flag those older than their bundle. Kills nothing."""
    result = run(['ps', '-axo', 'pid=,uid=,lstart=,comm='], stdin=subprocess.DEVNULL,
                 capture_output=True, timeout=2, check=False,
                 encoding='utf-8', errors='replace', env=_ps_environment())
    if result.returncode != 0:
        raise ValueError(f'ps exited with status {result.returncode}.')
    found, unparsed = parse_process_table(result.stdout)
    services = []
    for service in found:
        replaced = bundle_replaced_at(service['path'], stat)
        services.append({
            **service, 'bundle_replaced': replaced, 'bundle_missing': replaced is None,
            'stale': replaced is not None and replaced > service['started'] + STALE_MARGIN_SECONDS})
    stale = sorted(service['pid'] for service in services if service['stale'])
    diagnosis = {'services': services, 'stale': stale, 'unparsed': unparsed}
    return diagnosis


def diagnose_response():
    try:
        return {'ok': True, **diagnose_sky_services()}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)[:512]}


class SingleFlight:
    """Run `work` once at a time; callers arriving meanwhile share the running call's result."""

    def __init__(self, work, wait_seconds=5, unfinished='The Computer Use service diagnosis did not finish.'):
        self.work, self.wait_seconds, self.unfinished = work, wait_seconds, unfinished
        self.lock = Lock()
        self.current = None

    def __call__(self):
        with self.lock:
            flight = self.current
            leader = flight is None
            if leader:
                flight = self.current = {'done': Event(), 'result': None}
        if leader:
            try:
                flight['result'] = self.work()
            finally:
                with self.lock:
                    self.current = None
                flight['done'].set()
        else:
            flight['done'].wait(self.wait_seconds)
        return flight['result'] or {'ok': False, 'error': self.unfinished}


shared_diagnosis = SingleFlight(diagnose_response)


# Recovery. A Computer Use service whose bundle was replaced while it ran keeps the socket
# lock and rejects every client. When, and only when, every check below agrees that one
# service is that stale holder, it is asked to quit (SIGTERM) so the original client can
# start a current one. Every step is bounded; any doubt means no action.
CODESIGN_TIMEOUT_SECONDS = 4
LSOF_TIMEOUT_SECONDS = 3
# Observations older than this are not acted on, so a slow machine cannot turn a stale
# reading into a signal after the requester has already given up (it waits 15 s).
PRE_SIGNAL_BUDGET_SECONDS = 9
PEER_LOCK_WAIT_SECONDS = 4
TERMINATE_WAIT_SECONDS = 3
TERMINATE_POLL_SECONDS = 0.1
RECOVERY_WAIT_SECONDS = 16
# What `codesign --verify <pid>` prints when the code that is running is not the code now on
# disk (errSecCSStaticCodeChanged). A healthy service prints `dynamically valid`, `valid on
# disk` and exits 0. Any other failure (a vanished pid, a usage error, a broken seal) does
# not prove that the running service is stale, so it is not enough.
SIGNATURE_MISMATCH_MARKERS = ('the code on disk does not match what is running',)
SERVICE_EXECUTABLE = Path('Contents/MacOS') / SKY_SERVICE_NAME


def verify_service_signature(pid, *, run=subprocess.run):
    """'valid', 'invalid' (the running code differs from the code on disk) or 'unknown'.

    `codesign --verify <pid>` validates the running code against its signature on disk, so
    a bundle replaced under a running process fails it, and a healthy service passes.
    """
    try:
        result = run(['codesign', '--verify', '--strict', str(pid)], stdin=subprocess.DEVNULL,
                     capture_output=True, timeout=CODESIGN_TIMEOUT_SECONDS, check=False,
                     encoding='utf-8', errors='replace', env=_ps_environment())
    except (OSError, subprocess.SubprocessError):
        return 'unknown'
    if result.returncode == 0:
        return 'valid'
    detail = f'{result.stderr or ""} {result.stdout or ""}'.lower()
    if result.returncode == 1 and any(marker in detail for marker in SIGNATURE_MISMATCH_MARKERS):
        return 'invalid'
    return 'unknown'


def lock_holders(lock_path, *, run=subprocess.run):
    """The complete set of pids with the service's socket lock file open, or None when unsure.

    Only a clean answer counts: pids and no diagnostics, or no pids, no diagnostics and
    lsof's "nothing found" status. A warning, an error status or odd output is unknown.
    """
    if not lock_path or not os.path.isabs(lock_path):
        return None
    try:
        result = run(['lsof', '-t', '--', lock_path], stdin=subprocess.DEVNULL, capture_output=True,
                     timeout=LSOF_TIMEOUT_SECONDS, check=False, encoding='utf-8', errors='replace')
    except (OSError, subprocess.SubprocessError):
        return None
    lines = (result.stdout or '').split()
    clean = (not (result.stderr or '').strip() and all(line.isdigit() for line in lines) and
             (result.returncode == 0 and lines or result.returncode == 1 and not lines))
    return {int(line) for line in lines} if clean else None


def executable_path(pid):
    """The executable path the kernel reports for a pid (proc_pidpath), or None.

    `ps` shows argv[0], which a process can choose; this is the file actually running.
    """
    if sys.platform != 'darwin' or type(pid) is not int or pid <= 1:
        return None
    try:
        import ctypes
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        buffer = ctypes.create_string_buffer(4096)
        size = libproc.proc_pidpath(ctypes.c_int(pid), buffer, ctypes.c_uint32(len(buffer)))
        return os.fsdecode(buffer.value) if size > 0 else None
    except (OSError, AttributeError, ValueError):
        return None


class PeerLock:
    """Exclusion between the LCU hosts of this account (one per MCP connection).

    An advisory flock on a file in the account's private temporary directory. Another host
    recovering at the same time makes this one wait (bounded); `waited` tells it so.
    """

    def __init__(self, path=None, wait_seconds=PEER_LOCK_WAIT_SECONDS, sleep=time.sleep, monotonic=time.monotonic):
        self.path = path or os.path.join(tempfile.gettempdir(), f'lcu-stale-service-recovery-{os.getuid()}.lock')
        self.wait_seconds, self.sleep, self.monotonic = wait_seconds, sleep, monotonic
        self.descriptor, self.acquired, self.waited = None, False, False

    def __enter__(self):
        try:
            import fcntl
            descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        except (OSError, ImportError):
            return self
        deadline = self.monotonic() + self.wait_seconds
        try:
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.descriptor, self.acquired = descriptor, True
                    return self
                except BlockingIOError:
                    self.waited = True
                    if self.monotonic() >= deadline:
                        break
                    self.sleep(0.05)
        except OSError:
            pass
        os.close(descriptor)
        return self

    def __exit__(self, *exc):
        if self.descriptor is not None:
            try:
                os.close(self.descriptor)  # closing releases the flock
            finally:
                self.descriptor = None
        return False


def known_service_executables(environment=None, realpath=os.path.realpath):
    """Executables of the two bundles LCU may stop a service from: the one it launches and the app's copy."""
    environment = os.environ if environment is None else environment
    bundles = [environment.get('SKY_CUA_SERVICE_PATH')]
    codex_home = environment.get('CODEX_HOME')
    if codex_home:
        bundles.append(os.path.join(codex_home, 'computer-use', 'Codex Computer Use.app'))
    return {realpath(os.path.join(bundle, SERVICE_EXECUTABLE))
            for bundle in bundles if bundle and os.path.isabs(bundle)}


def _process_exists(pid):
    """Existence probe with signal 0 (never delivers anything); pid must be a single process."""
    if type(pid) is not int or pid <= 1:
        raise ValueError('refusing to probe a non-process id')
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


class _NoPeerLock:
    acquired, waited = True, False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def recover_stale_service(*, lock_path, executables, uid=None, diagnose=diagnose_sky_services,
                          verify=verify_service_signature, holders=lock_holders,
                          kernel_path=executable_path, kill=os.kill, exists=_process_exists,
                          realpath=os.path.realpath, sleep=time.sleep, monotonic=time.monotonic,
                          exclusive=_NoPeerLock, log=None):
    """Quit the one Computer Use service that is provably stale and holds the connection.

    Every one of these must hold, otherwise nothing is signaled:
    - the process listing is complete, and exactly one running service started before its
      bundle was replaced (ctime);
    - it is a single process (pid > 1, not this one), owned by the current user, named
      exactly SkyComputerUseService, and the executable the kernel reports for it is the
      one in a known bundle;
    - it is the only process holding the socket lock file;
    - `codesign --verify` rejects the running code as different from the code on disk.
    Then the process, lock and executable are read again, and the checks must still agree
    exactly (pid, owner, start time, path), within the pre-signal time budget. The signal is
    SIGTERM to that one pid, never a group, never SIGKILL: a service that ignores it is left
    alone. Only one LCU host per account does this at a time. Returns the reason when it
    did nothing.
    """
    def nothing(reason):
        return {'ok': True, 'recovered': False, 'reason': reason}

    uid = os.getuid() if uid is None else uid
    started = monotonic()

    def candidate():
        """The single stale service that passes every identity check, or the reason there is none."""
        diagnosis = diagnose()
        if diagnosis.get('unparsed'):
            return None, 'the process listing was incomplete'
        stale = [service for service in diagnosis['services'] if service['stale']]
        if not stale:
            return None, 'no stale service'
        if len(stale) != 1:
            return None, 'more than one stale service'
        service = stale[0]
        pid = service['pid']
        if type(pid) is not int or pid <= 1 or pid == os.getpid():
            return None, 'not a single service process'
        if service['uid'] != uid:
            return None, 'the stale service belongs to another user'
        if os.path.basename(service['path']) != SKY_SERVICE_NAME or realpath(service['path']) not in executables:
            return None, 'the stale service is not in a known Computer Use bundle'
        actual = kernel_path(pid)
        if not actual or realpath(actual) != realpath(service['path']) or realpath(actual) not in executables:
            return None, 'the kernel does not report the known executable for the stale service'
        if holders(lock_path) != {pid}:
            return None, 'the stale service is not the only holder of the socket lock'
        return service, None

    try:
        with exclusive() as peer:
            if not peer.acquired:
                return nothing('another LCU process is recovering')
            service, reason = candidate()
            if service is None:
                if peer.waited and reason == 'no stale service':
                    # Another LCU process was recovering while this one waited for it.
                    return {'ok': True, 'recovered': True, 'reason': 'recovered by another LCU process'}
                return nothing(reason)
            pid = service['pid']
            if verify(pid) != 'invalid':
                return nothing('the running service passes signature verification, or it could not be checked')
            # Read everything again, then signal at once: a recycled pid, a replaced service or
            # a lock that changed hand during the slower checks must not be signaled.
            again, reason = candidate()
            if again is None or (again['pid'], again['uid'], again['started'], again['path']) != (
                    pid, service['uid'], service['started'], service['path']):
                return nothing('the service changed while it was being checked')
            if monotonic() - started > PRE_SIGNAL_BUDGET_SECONDS:
                return nothing('the checks took too long to act on')
            kill(pid, signal.SIGTERM)
    except Exception as exc:
        return nothing(f'check failed: {str(exc)[:200]}')
    try:
        deadline = monotonic() + TERMINATE_WAIT_SECONDS
        while exists(pid):
            if monotonic() >= deadline:
                return nothing(f'pid {pid} did not exit within {TERMINATE_WAIT_SECONDS} seconds of SIGTERM')
            sleep(TERMINATE_POLL_SECONDS)
    except Exception as exc:
        return nothing(f'could not confirm that pid {pid} exited: {str(exc)[:200]}')
    elapsed_ms = int((monotonic() - started) * 1000)
    if log:
        log(f'LCU macOS stopped stale Computer Use service pid {pid} ({service["path"]}) '
            f'after {elapsed_ms} ms; its bundle was replaced while it was running')
    return {'ok': True, 'recovered': True, 'pid': pid, 'path': service['path'], 'elapsed_ms': elapsed_ms}


def recover_response():
    if sys.platform != 'darwin':
        return {'ok': True, 'recovered': False, 'reason': 'not macOS'}
    return recover_stale_service(
        lock_path=os.environ.get('LCU_MAC_SERVICE_LOCK'), executables=known_service_executables(),
        exclusive=PeerLock, log=lambda line: print(line, file=sys.stderr, flush=True))


shared_recovery = SingleFlight(recover_response, wait_seconds=RECOVERY_WAIT_SECONDS,
                               unfinished='The Computer Use service recovery did not finish.')


def answer_diagnose(connection, flight=None):
    """Send a flight's result (the diagnosis by default) on a private duplicate, then close it."""
    flight = flight or shared_diagnosis
    with connection:
        try:
            connection.settimeout(3)
            connection.sendall((json.dumps(flight(), separators=(',', ':')) + '\n').encode())
        except OSError:
            pass


def turn_ended_payload(session_id, turn_id):
    return json.dumps({
        'type': 'agent-turn-complete',
        'thread-id': session_id,
        'turn-id': turn_id,
    }, separators=(',', ':'))


def start_original_host(*, python, client: Path, entry: Path, env: dict[str, str],
                        control_address: str | None = None):
    """Start a private Unix-socket bridge and wait for its readiness record."""
    if not client.is_file() or not os.access(client, os.X_OK) or not entry.is_file():
        raise ValueError('The selected original macOS computer-use client is incomplete.')
    socket_dir = '/private/tmp' if Path('/private/tmp').is_dir() else None
    temporary = tempfile.TemporaryDirectory(prefix='lcu-ml-', dir=socket_dir)
    address = str(Path(temporary.name) / 'lifetime.sock')
    command = [str(python), '-B', str(entry), 'serve', address, str(client)]
    if control_address:
        command.append(control_address)
    process = subprocess.Popen(command,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               env=env)
    ready = Queue(maxsize=1)
    Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
    try:
        line = ready.get(timeout=5)
        state = json.loads(line)
        if state != {'ready': True, 'socket': address}:
            raise ValueError('Original macOS lifecycle host reported an invalid socket.')
        return process, temporary, address
    except (Empty, ValueError, json.JSONDecodeError) as exc:
        stop_original_host(process, temporary, require_success=False)
        raise ValueError('Original macOS lifecycle host failed to become ready.') from exc


def stop_original_host(process, temporary, *, require_success=True):
    """Dispose only the lifetime host owned by this LCU MCP connection."""
    if process.stdin and not process.stdin.closed:
        process.stdin.close()
    try:
        try:
            status = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            status = process.wait(timeout=2)
    finally:
        if process.stdout:
            process.stdout.close()
        temporary.cleanup()
    if require_success and status != 0:
        raise ValueError(f'Original macOS lifecycle host exited with status {status}.')


class LineReader:
    def __init__(self, connection):
        self.connection = connection
        self.buffer = bytearray()

    def read(self, limit=4096):
        while b'\n' not in self.buffer:
            if len(self.buffer) > limit:
                raise ValueError('Invalid macOS control request size or framing.')
            part = self.connection.recv(min(1024, limit + 1 - len(self.buffer)))
            if not part:
                raise ValueError('macOS control connection closed before a complete request.')
            self.buffer.extend(part)
        newline = self.buffer.index(b'\n')
        if newline > limit:
            raise ValueError('Invalid macOS control request size or framing.')
        line = bytes(self.buffer[:newline])
        del self.buffer[:newline + 1]
        return json.loads(line)


class TrustedControlBridge:
    """Route human control through the original trusted Sky service."""

    def __init__(self):
        self.changed = Condition()
        self.service = None
        self.active = {}
        self.pending = {}

    def serve(self, address, ready=None):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bound = False
        try:
            server.bind(address)
            bound = True
            os.chmod(address, 0o600)
            server.listen(8)
            if ready:
                ready.put(None)
        except Exception as exc:
            if ready:
                ready.put(exc)
            server.close()
            if bound:
                Path(address).unlink(missing_ok=True)
            if ready:
                return
            raise
        try:
            while True:
                connection, _ = server.accept()
                Thread(target=self.handle, args=(connection,), daemon=True).start()
        finally:
            server.close()
            Path(address).unlink(missing_ok=True)

    def handle(self, connection):
        with connection:
            try:
                connection.settimeout(3)
                reader = LineReader(connection)
                request = reader.read()
                if isinstance(request, dict) and request.get('type') == 'service':
                    self._serve_service(connection, reader)
                    return
                connection.settimeout(43)
                response = self._request(request)
            except Exception as exc:
                response = {'ok': False, 'error': str(exc)[:512]}
            try:
                connection.sendall((json.dumps(response, separators=(',', ':')) + '\n').encode())
            except OSError:
                pass

    def _serve_service(self, connection, reader):
        connection.settimeout(None)
        with self.changed:
            if self.service is not None:
                raise ValueError('A trusted macOS control service is already connected.')
            self.service = connection
            self.changed.notify_all()
        try:
            while True:
                message = reader.read(limit=65536)
                if not isinstance(message, dict):
                    raise ValueError('Invalid trusted macOS control message.')
                kind = message.get('type')
                if kind == 'context':
                    token = message.get('token')
                    session_id = message.get('session_id')
                    turn_id = message.get('turn_id')
                    if (not isinstance(token, str) or not token or
                            not isinstance(session_id, str) or not session_id.strip() or
                            not isinstance(turn_id, str) or not turn_id.strip()):
                        raise ValueError('Trusted macOS control context is missing IDs.')
                    with self.changed:
                        app = message.get('app')
                        if app is not None and (not isinstance(app, str) or not app.strip()):
                            raise ValueError('Trusted macOS control context has an invalid app ID.')
                        self.active[token] = (session_id, turn_id, app)
                        self.changed.notify_all()
                elif kind == 'context-ended':
                    token = message.get('token')
                    with self.changed:
                        self.active.pop(token, None)
                        self.changed.notify_all()
                elif kind == 'result':
                    request_id = message.get('request_id')
                    with self.changed:
                        waiter = self.pending.get(request_id)
                        if waiter is not None:
                            waiter['response'] = message.get('response')
                            waiter['ready'] = True
                            self.changed.notify_all()
                else:
                    raise ValueError('Unknown trusted macOS control message.')
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            with self.changed:
                if self.service is connection:
                    self.service = None
                    self.active.clear()
                    for waiter in self.pending.values():
                        waiter['response'] = {'ok': False,
                                              'error': 'Trusted macOS control service disconnected.'}
                        waiter['ready'] = True
                self.changed.notify_all()

    def _request(self, request):
        if not isinstance(request, dict) or request.get('type') not in ('status', 'stop'):
            raise ValueError('Unsupported macOS control request.')
        session_id, turn_id = request.get('session_id'), request.get('turn_id')
        if (not isinstance(session_id, str) or not session_id.strip() or
                not isinstance(turn_id, str) or not turn_id.strip()):
            raise ValueError('Real macOS control session and turn IDs are required.')
        app = request.get('app')
        if request.get('type') == 'stop' and (not isinstance(app, str) or not app.strip()):
            raise ValueError('An application bundle ID is required to stop computer use.')
        deadline = time.monotonic() + 40
        with self.changed:
            while self.service is None and time.monotonic() < deadline:
                self.changed.wait(deadline - time.monotonic())
            if self.service is None:
                raise ValueError('Trusted macOS control service is not connected.')
            contexts = [active for active in self.active.values()
                        if active[0] == session_id and active[1] == turn_id]
            if not contexts:
                raise ValueError('The requested session and turn are not active in the trusted runtime.')
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                raise ValueError('Original macOS control request timed out.')
            request_id = str(uuid4())
            waiter = {'ready': False, 'response': None}
            self.pending[request_id] = waiter
            message = {'type': request['type'], 'request_id': request_id,
                       'session_id': session_id, 'turn_id': turn_id,
                       'deadline_unix_ms': int(time.time() * 1000 + remaining_ms)}
            if app is not None:
                message['app'] = app
            try:
                self.service.sendall((json.dumps(message, separators=(',', ':')) + '\n').encode())
            except OSError as exc:
                self.pending.pop(request_id, None)
                raise ValueError('Trusted macOS control service is unavailable.') from exc
            while not waiter['ready'] and time.monotonic() < deadline:
                self.changed.wait(deadline - time.monotonic())
            self.pending.pop(request_id, None)
            if not waiter['ready']:
                raise ValueError('Original macOS control request timed out.')
            response = waiter['response']
            if not isinstance(response, dict):
                raise ValueError('Trusted macOS control service returned an invalid response.')
            return response


def serve(address, client, control_address=None):
    """Accept bounded cleanup IDs and optional trusted-service control routing."""
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(address)
    os.chmod(address, 0o600)
    server.listen(8)
    bridge = TrustedControlBridge() if control_address else None
    if bridge:
        bridge_ready = Queue(maxsize=1)
        Thread(target=bridge.serve, args=(control_address, bridge_ready), daemon=True).start()
        try:
            failure = bridge_ready.get(timeout=5)
        except Empty as exc:
            failure = exc
        if failure is not None:
            print(f'LCU macOS user control unavailable: {str(failure)[:256]}',
                  file=sys.stderr, flush=True)
            bridge = None
    print(json.dumps({'ready': True, 'socket': address}), flush=True)
    try:
        while True:
            readable, _, _ = select.select([server, sys.stdin], [], [])
            if sys.stdin in readable and not sys.stdin.readline():
                break
            if server not in readable:
                continue
            connection, _ = server.accept()
            with connection:
                connection.settimeout(3)
                try:
                    request = LineReader(connection).read()
                    if isinstance(request, dict) and request.get('type') == 'diagnose':
                        # Read-only: list Sky services and report; never signal them. It runs on
                        # its own thread so a slow `ps` cannot hold up turn-ended cleanup.
                        Thread(target=answer_diagnose, args=(connection.dup(),), daemon=True).start()
                        continue
                    if isinstance(request, dict) and request.get('type') == 'recover':
                        # Also off the accept loop: it waits on codesign, lsof and the service's exit.
                        Thread(target=answer_diagnose, args=(connection.dup(), shared_recovery),
                               daemon=True).start()
                        continue
                    session_id = request.get('session_id') if isinstance(request, dict) else None
                    turn_id = request.get('turn_id') if isinstance(request, dict) else None
                    if (not isinstance(session_id, str) or not session_id.strip() or
                            not isinstance(turn_id, str) or not turn_id.strip()):
                        raise ValueError('Original macOS turn IDs are missing.')
                    payload = turn_ended_payload(session_id, turn_id)
                    result = subprocess.run([client, 'turn-ended', payload],
                                            stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            timeout=3, check=False)
                    if result.returncode != 0:
                        raise RuntimeError(f'Original turn-ended command exited with status {result.returncode}.')
                    response = {'notified': True}
                except Exception as exc:
                    response = {'notified': False, 'error': str(exc)[:512]}
                    print(f'LCU macOS turn cleanup failed: {response["error"]}', file=sys.stderr, flush=True)
                try:
                    connection.sendall((json.dumps(response, separators=(',', ':')) + '\n').encode())
                except OSError:
                    # A disconnected hook client must not terminate the host.
                    continue
    finally:
        server.close()
        Path(address).unlink(missing_ok=True)


if __name__ == '__main__' and len(sys.argv) in (4, 5) and sys.argv[1] == 'serve':
    serve(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) == 5 else None)
