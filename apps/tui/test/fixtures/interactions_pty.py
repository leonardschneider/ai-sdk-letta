"""Actual PTY approval/question interaction within an active provider stream."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 160, 0, 0))
process = subprocess.Popen(['node', '--conditions=ai-sdk-letta-source', '--import', 'tsx', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'interactions.ts')], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
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
            # The child may exit before its final output has been read (common
            # on Linux). Drain the PTY until EOF/EIO, then check once more.
            drain_deadline = time.monotonic() + 2
            while time.monotonic() < drain_deadline and select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk.decode('utf-8', errors='replace')
            plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', buffer)
            if text in plain:
                return plain
            break
    raise AssertionError('Missing ' + text + ': ' + buffer[-30000:])

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
    wait_for('Waiting for input')
    command('clarify')
    wait_for('Which audience should I use?')
    command('normal answer')
    wait_for('CLARIFICATION_ACCEPTED')
    command('deny')
    wait_for('APPROVAL_deny')
    send(b'n')
    wait_for('TURNDONE3')
    command('approve')
    wait_for('APPROVAL_approve')
    send(b'y')
    wait_for('TURNDONE4')
    command('question single')
    wait_for('QUESTION_question single')
    send(b'\x1b[B')
    send(b'\r')
    wait_for('TURNDONE5')
    command('question multi')
    wait_for('QUESTION_question multi')
    send(b' ')
    send(b'\x1b[B')
    send(b' ')
    send(b'f')
    send(b'custom answer')
    send(b'\r')
    wait_for('TURNDONE6')
    command('question free')
    wait_for('QUESTION_question free')
    send(b'free answer')
    send(b'\r')
    wait_for('TURNDONE7')
    command('question cancel')
    wait_for('QUESTION_question cancel')
    send(b'\x1b')
    wait_for('TURNDONE8')
    command('cancel approval')
    wait_for('APPROVAL_cancel approval')
    send(b'\x1b')
    wait_for('TURNDONE9')
    command('concurrent')
    wait_for('FIRST_CONCURRENT')
    send(b'yy')  # Remaining bytes belong to the first modal, never the next call.
    wait_for('SECOND_CONCURRENT')
    send(b'n')
    wait_for('TURNDONE10')
    command('abort approval')
    wait_for('APPROVAL_abort approval')
    send(b'\x03')
    wait_for('EXECUTIONS=2;')
    plain = wait_for('RESULTS=')
    assert 'SENT=["clarify","normal answer","deny","approve","question single","question multi","question free","question cancel","cancel approval","concurrent","abort approval"]' in plain, plain
    assert '"error":"user_denied"' in plain, plain
    assert '"selected":["two"]' in plain, plain
    assert '"selected":["one","two"],"text":"custom answer"' in plain, plain
    assert '"selected":[],"text":"free answer"' in plain, plain
    assert '"cancelled":true' in plain, plain
    assert '"error":"approval_cancelled"' in plain, plain
    process.wait(timeout=10)
    assert process.returncode == 0
    print('PASS actual PTY: in-stream approve/deny/cancel/abort, choices/free text/multiselect, ordinary clarification, no replay/double execution/answer leakage.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
