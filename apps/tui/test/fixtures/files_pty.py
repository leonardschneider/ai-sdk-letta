"""Offline real-PTY regression: dropped PDF and CSV paths become [File N: name] markers,
Backspace removes one, an unsupported file shows a notice, and exactly the new turn is
sent as text plus the "Attached:" note (no file content). Restored turns show [File: name]."""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

here = os.path.dirname(os.path.abspath(__file__))
work = tempfile.mkdtemp(prefix='ai-sdk-letta-tui-files-')
pdf = os.path.join(work, 'Quarterly Report.pdf')
shutil.copy(os.path.join(here, '..', '..', '..', '..', 'packages', 'ai-sdk-letta', 'test', 'fixtures', 'quarterly-report.pdf'), pdf)
csv = os.path.join(work, 'team.csv')
with open(csv, 'w') as f:
    f.write('name,role\nAna,Lead\n')
binary = os.path.join(work, 'tool.txt')
with open(binary, 'wb') as f:
    f.write(b'\x7fELF\x00\x00\x00\x00')
root = os.path.join(work, 'attachments')

env = dict(os.environ, ATTACHMENTS_ROOT=root)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
process = subprocess.Popen(['node', '--conditions=ai-sdk-letta-source', '--import', 'tsx', os.path.join(here, 'files.ts')], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env=env)
os.close(slave)
buffer = ''
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')

def plain():
    return ansi.sub('', buffer)

def pump(seconds=0.15):
    global buffer
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.02)[0]:
            try:
                buffer += os.read(master, 65536).decode('utf-8', errors='replace')
            except OSError:
                return

def wait_for(text, timeout=15, since=0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if text in plain()[since:]:
            return
        if process.poll() is not None:
            pump(1)
            if text in plain()[since:]:
                return
            break
        pump(0.1)
    raise AssertionError('Missing ' + repr(text) + ': ' + plain()[-5000:])

def mark():
    return len(plain())

def input_line():
    # The input box is the last "│ > ..." line drawn (frames are cursor-addressed, not newline-separated).
    parts = plain().split('│ > ')
    return parts[-1].split('│')[0] if len(parts) > 1 else ''

try:
    wait_for('OLDANSWER')
    wait_for('[File: old-notes.md] OLDQUESTION')
    wait_for('drop a file to attach it')
    os.write(master, b'Budget? ')
    wait_for('> Budget?')
    # 1. Drop a shell-escaped PDF path (as macOS terminals do).
    at = mark()
    os.write(master, pdf.replace(' ', '\\ ').encode())
    wait_for('[File 1: Quarterly Report.pdf]', since=at)
    wait_for('1 file attached', since=at)
    # 2. Drop a quoted CSV path.
    at = mark()
    os.write(master, ("'" + csv + "'").encode())
    wait_for('[File 2: team.csv]', since=at)
    wait_for('2 files attached', since=at)
    # 3. Backspace right after a marker removes the whole attachment.
    at = mark()
    os.write(master, b'\x7f')
    pump(0.4)
    wait_for('1 file attached', since=at)
    assert '[File 2' not in input_line(), input_line()
    # 4. An unsupported (binary) file shows a notice and is not attached.
    at = mark()
    os.write(master, binary.encode())
    wait_for('Unsupported file', since=at)
    assert '[File 2' not in input_line(), input_line()
    # 5. Drop the CSV again; it is [File 2] again.
    at = mark()
    os.write(master, csv.encode())
    wait_for('[File 2: team.csv]', since=at)
    os.write(master, b' thanks')
    pump(0.3)
    at = mark()
    os.write(master, b'\r')
    wait_for('REPLY stored=Quarterly Report.pdf|team.csv', since=at, timeout=30)
    # The sent turn shows labels with names, not numbered markers.
    assert '[File: Quarterly Report.pdf] [File: team.csv] Budget? thanks' in plain()[at:], plain()[at:][-2000:]
    time.sleep(0.2)
    os.write(master, b'\x03')
    wait_for('SENT=')
    process.wait(timeout=10)
    sent = json.loads(plain()[plain().index('SENT=') + 5:].split('\n')[0].strip())
    assert sent == ['Budget? thanks\n\nAttached: Quarterly Report.pdf (PDF, 5 pages, 3 KB)\nAttached: team.csv (CSV, 2 lines, 19 bytes)'], sent
    assert 'OLDQUESTION' not in json.dumps(sent), 'restored history must never be replayed'
    # Stored in the conversation's folder of the agent's git-backed resources.
    assert os.path.exists(os.path.join(root, 'agent-local-fixture', 'files', 'Conversation fixture', 'Quarterly Report.pdf'))
    assert process.returncode == 0
    print('PASS actual PTY files: dropped escaped/quoted PDF and CSV paths become [File N: name], Backspace removes one, unsupported files show a notice, the turn sends only the note, files are stored, restored [File: name] never replayed.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
    shutil.rmtree(work, ignore_errors=True)
