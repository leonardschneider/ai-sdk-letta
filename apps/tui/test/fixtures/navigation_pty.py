"""Offline actual PTY: slash interception, overlays, filtering, cancellation, switch."""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 140, 0, 0))
process = subprocess.Popen(['node', '--conditions=ai-sdk-letta-source', '--import', 'tsx', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'navigation.ts')], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
buffer = ''

def wait_for(text, timeout=12):
    global buffer
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                buffer += os.read(master, 65536).decode('utf-8', errors='replace')
            except OSError:
                break
        plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', buffer)
        if text in plain:
            return plain
        if process.poll() is not None:
            break
    raise AssertionError('Missing ' + text + ': ' + buffer[-7000:])

def send(value):
    global buffer
    buffer = ''
    os.write(master, value)
    time.sleep(0.12)

def command(text):
    send(text.encode())
    wait_for(text)
    send(b'\r')

try:
    wait_for('ORIGINALRESTORED')
    command('/resume')
    wait_for('Resume')
    wait_for('Original conversation')
    send(b'Planning')
    wait_for('1 results')
    send(b'\x1b')
    wait_for('ORIGINALRESTORED')
    command('fresh normal input')
    wait_for('LIVEONLYREPLY')
    command('/resume')
    wait_for('Resume')
    send(b'\x1b')
    # Back preserves current-process live history, not just restored startup rows.
    wait_for('LIVEONLYREPLY')
    command('/search')
    wait_for('Search current agent')
    send(b'needle')
    send(b'\r')
    wait_for('ORIGINALCONTEXT')
    wait_for('PLANNINGCONTEXT')
    send(b'\x1b[B')
    send(b'\r')
    wait_for('PLANNINGRESTORED')
    command('/search needle')
    wait_for('ORIGINALCONTEXT')
    send(b'\x1b')
    wait_for('PLANNINGRESTORED')
    command('/resume Original')
    wait_for('1 results')
    send(b'\r')
    wait_for('ORIGINALRESTORED')
    send(b'\x03')
    wait_for('SENT=["default:fresh normal input"]')
    wait_for('VISITS=["default","local-conv-2","default"]')
    process.wait(timeout=10)
    assert process.returncode == 0
    print('PASS real PTY navigation: /resume filter/back, live history preserved, /search prompt/snippets/arrow selection, in-process switch, no command replay.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
