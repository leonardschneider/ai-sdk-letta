"""Offline real-PTY regression: restored scrollback, inert tool card, no replay."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))
process = subprocess.Popen(['node', '--conditions=ai-sdk-letta-source', '--import', 'tsx', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'history.ts')], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
buffer = ''

def wait_for(text, timeout=15):
    global buffer
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536).decode('utf-8', errors='replace')
            except OSError:
                break
            buffer += data
        plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', buffer)
        if text in plain:
            return plain
        if process.poll() is not None:
            break
    raise AssertionError('Missing ' + text + ': ' + re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', buffer)[:6500])

def pump(seconds=0.15):
    global buffer
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.02)[0]:
            buffer += os.read(master, 65536).decode('utf-8', errors='replace')

try:
    wait_for('OLDCARDINPUT')
    assert '\x1b[?1049h' in buffer, 'Must render inside alternate-screen TUI'
    assert 'RESTOREDROW29' in wait_for('RESTOREDROW29')
    assert 'SENT=' not in buffer and 'LIVEREPLYONLY' not in buffer
    # The oldest text was not initially visible. Exercise TUI-owned scrollback.
    assert 'RESTOREDROW00' not in buffer
    for _ in range(8):
        os.write(master, b'\x1b[5~')
        pump()
    wait_for('RESTOREDROW00')
    for _ in range(8):
        os.write(master, b'\x1b[6~')
        pump()
    os.write(master, b'fresh user turn')
    wait_for('fresh user turn')
    os.write(master, b'\r')
    wait_for('LIVEREPLYONLY')
    time.sleep(0.2)
    os.write(master, b'\x03')
    wait_for('SENT=["fresh user turn"]')
    process.wait(timeout=10)
    assert process.returncode == 0
    print('PASS real PTY: restored latest text + inert tool card; PgUp reaches oldest text; exactly one fresh user input; no replay/model call on read-only startup.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
