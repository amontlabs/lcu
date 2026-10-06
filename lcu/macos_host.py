"""Supervise the original macOS client turn-ended command for one MCP process."""
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
from threading import Condition, Thread
from uuid import uuid4


# The original helper starts the CUAService app and its XPC transport waits up
# to 5 s to connect, so a healthy run takes about 5.2 s. Allow for a slower launch.
# lcu/macos_sky_service.mjs derives its own wait from this value.
TURN_ENDED_CLI_TIMEOUT_SECONDS = 10
# Log successful runs only when they are close to the helper's own 5 s deadline.
TURN_ENDED_CLI_SLOW_SECONDS = 4.5
STDERR_LOG_BYTES = 512


def turn_ended_payload(session_id, turn_id):
    return json.dumps({
        'type': 'agent-turn-complete',
        'thread-id': session_id,
        'turn-id': turn_id,
    }, separators=(',', ':'))


def run_turn_ended(client, payload, timeout=TURN_ENDED_CLI_TIMEOUT_SECONDS):
    """Run the original turn-ended command; report slow or failed runs on stderr.

    The helper exits 0 even when it cannot reach the service (it only writes to
    os_log), so a zero status does not prove delivery.
    """
    started = time.monotonic()
    status = 'timeout'
    stderr = b''
    failure = None
    try:
        result = subprocess.run([client, 'turn-ended', payload], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
        status = result.returncode
        stderr = result.stderr or b''
        if status != 0:
            failure = RuntimeError(f'Original turn-ended command exited with status {status}.')
    except subprocess.TimeoutExpired as exc:
        stderr = exc.stderr or b''
        failure = RuntimeError(
            f'Original turn-ended command timed out after {timeout} seconds.')
    elapsed = time.monotonic() - started
    if failure is not None or elapsed >= TURN_ENDED_CLI_SLOW_SECONDS:
        text = bytes(stderr)[:STDERR_LOG_BYTES].decode('utf-8', 'replace').strip()
        print(f'LCU macOS turn-ended command: exit={status} elapsed={round(elapsed * 1000)} ms'
              f'{" stderr=" + repr(text) if text else ""}', file=sys.stderr, flush=True)
    if failure is not None:
        raise failure


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
                    session_id = request.get('session_id') if isinstance(request, dict) else None
                    turn_id = request.get('turn_id') if isinstance(request, dict) else None
                    if (not isinstance(session_id, str) or not session_id.strip() or
                            not isinstance(turn_id, str) or not turn_id.strip()):
                        raise ValueError('Original macOS turn IDs are missing.')
                    payload = turn_ended_payload(session_id, turn_id)
                    run_turn_ended(client, payload)
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
