"""Offline real-PTY regression: Ctrl+V and dropped image paths become [Image N] markers,
Backspace removes a marker, the empty-clipboard case shows a notice, and exactly the
new turn (text + images) is sent. Restored image turns display as [Image]."""
import base64
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import zlib

def png(width, height, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

work = tempfile.mkdtemp(prefix='ai-sdk-letta-tui-images-')
dropped = os.path.join(work, 'My Photo (1).png')
with open(dropped, 'wb') as f:
    f.write(png(6, 6, (0, 0, 220)))
not_image = os.path.join(work, 'notes.txt')
with open(not_image, 'w') as f:
    f.write('hello')
mode_file = os.path.join(work, 'clipboard-mode')
with open(mode_file, 'w') as f:
    f.write('none')

env = dict(os.environ, FIXTURE_PNG_B64=base64.b64encode(png(4, 4, (220, 0, 0))).decode(), CLIPBOARD_MODE_FILE=mode_file)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
process = subprocess.Popen(['node', '--conditions=ai-sdk-letta-source', '--import', 'tsx', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'images.ts')], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env=env)
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
    global buffer
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
    # The input box is the last "> ..." line on screen.
    lines = [line for line in plain().split('\n') if line.startswith('│ > ')]
    return lines[-1] if lines else ''

try:
    wait_for('OLDANSWER')
    # Restored image turn renders as [Image] plus its text; nothing was sent.
    wait_for('[Image] OLDQUESTION')
    wait_for('Ctrl+V attaches an image')
    # 1. Ctrl+V with no image on the clipboard: gentle notice, nothing attached, no crash.
    at = mark()
    os.write(master, b'\x16')
    wait_for('No image on the clipboard', since=at)
    assert '[Image 1]' not in plain()[at:]
    # Typing clears the notice.
    os.write(master, b'Compare ')
    wait_for('> Compare', since=at)
    # 2. Ctrl+V with an image: marker appears.
    with open(mode_file, 'w') as f:
        f.write('png')
    at = mark()
    os.write(master, b'\x16')
    wait_for('[Image 1]', since=at)
    wait_for('1 image attached', since=at)
    # 3. Drop a shell-escaped path (as macOS terminals do): second marker.
    at = mark()
    escaped = dropped.replace(' ', '\\ ').replace('(', '\\(').replace(')', '\\)')
    os.write(master, (escaped + ' ').encode())
    wait_for('[Image 2]', since=at)
    wait_for('2 images attached', since=at)
    # 4. Backspace right after a marker removes the whole attachment.
    at = mark()
    os.write(master, b'\x7f')
    pump(0.4)
    wait_for('1 image attached', since=at)
    assert '[Image 2]' not in input_line(), input_line()
    # 5. Drop the same file again, quoted this time: it becomes [Image 2] again.
    at = mark()
    os.write(master, ("'" + dropped + "'").encode())
    wait_for('[Image 2]', since=at)
    # 6. A pasted non-image path stays text.
    at = mark()
    os.write(master, (' ' + not_image).encode())
    wait_for('ai-sdk-letta-tui-images-', since=at)
    pump(0.3)
    assert '[Image 3]' not in plain()[at:]
    # Remove the typed path again character by character.
    for _ in range(len(not_image) + 1):
        os.write(master, b'\x7f')
        pump(0.01)
    os.write(master, b' please')
    pump(0.3)
    at = mark()
    os.write(master, b'\r')
    wait_for('REPLY images=2', since=at, timeout=20)
    # The sent turn shows [Image] labels, not markers.
    assert '[Image] [Image] Compare' in plain()[at:], plain()[at:][-2000:]
    # 7. A text-only follow-up still works and sends a plain string.
    at = mark()
    os.write(master, b'text only')
    pump(0.2)
    os.write(master, b'\r')
    wait_for('REPLY images=0', since=at, timeout=20)
    time.sleep(0.2)
    os.write(master, b'\x03')
    wait_for('SENT=')
    process.wait(timeout=10)
    sent = plain()[plain().index('SENT='):].split('\n')[0]
    # Markers leave the text; the rest is sent as typed, then the images in order.
    assert sent.startswith('SENT=[["Compare please","<image/png:'), sent
    assert sent.count('<image/png:') == 2, sent
    assert sent.endswith(',"text only"]') or '"text only"]' in sent, sent
    assert 'OLDQUESTION' not in sent, 'restored history must never be replayed'
    assert process.returncode == 0
    print('PASS actual PTY images: Ctrl+V (empty and image), dropped escaped/quoted paths, Backspace removes a marker, non-image paths stay text, exactly the new turn sent with 2 images, restored [Image] never replayed.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
