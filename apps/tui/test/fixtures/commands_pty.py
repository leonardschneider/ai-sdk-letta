"""Offline real-PTY regression: run_command cards read "Ran `command`" with the exit code on the
right, show the command and the first lines of output verbatim (no Markdown), and say how many
lines are hidden."""
import fcntl, os, pty, re, select, signal, struct, subprocess, termios, time

here = os.path.dirname(os.path.abspath(__file__))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 120, 0, 0))
process = subprocess.Popen(['node', '--conditions=ai-sdk-letta-source', '--import', 'tsx', os.path.join(here, 'commands.ts')], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
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

def wait_for(text, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if text in plain():
            return
        if process.poll() is not None:
            break
        pump(0.1)
    raise AssertionError('Missing ' + repr(text) + ': ' + plain()[-4000:])

try:
    wait_for('Input')
    os.write(master, b'go')
    wait_for('> go')
    pump(0.3)
    os.write(master, b'\r')
    wait_for('DONE_REPLY')
    pump(0.5)
    text = plain()
    assert "Ran `python3 - <<'PY'…`" in text, text[-3000:]
    assert 'exit 0 · 42 ms' in text
    assert "$ python3 - <<'PY'" in text
    assert 'sample_std_units 34.6777' in text, 'output is shown verbatim, underscores intact'
    assert '… 5 more lines' in text
    assert 'row_7' in text and 'row_8' not in text
    assert 'Ran `ls missing-folder`' in text and 'exit 2 · 5 ms' in text
    assert 'Tool · run_command' not in text
    os.write(master, b'\x03')
    process.wait(timeout=10)
    print('PASS actual PTY commands: run_command cards show "Ran `cmd`", the exit code, the command and verbatim, capped output.')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    os.close(master)
