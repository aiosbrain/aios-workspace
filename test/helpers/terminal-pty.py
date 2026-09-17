"""Drive the actual Ink runtime in a PTY; no third-party Python dependencies."""
import os, pty, select, subprocess, sys, time, fcntl, termios, struct, json, signal
node, fixture, scenario, width = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 80, 0, 0))
env = dict(os.environ, TERM='xterm-256color', AIOS_UI_TIER='rich')
env.pop('AIOS_UI_WIDTH', None)
env.pop('CI', None)
proc = subprocess.Popen([node, fixture, scenario], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
data = bytearray(); sent = False; resized = False; ready_at = None; deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if select.select([master], [], [], .05)[0]:
        try:
            chunk = os.read(master, 65536)
            if not chunk: break
            data.extend(chunk)
        except OSError: break
    if ready_at is None and b'Esc cancel' in data:
        ready_at = time.monotonic() + .5
    if not resized and ready_at and time.monotonic() >= ready_at:
        # Resize after startup effects; keep draining output while React commits.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, int(width), 0, 0))
        proc.send_signal(signal.SIGWINCH)
        resized = True
        ready_at = time.monotonic() + .25
    if resized and not sent and time.monotonic() >= ready_at:
        # Paste + Enter in one write deliberately exercises batched input events.
        inputs = {'secret': b'\x1b[200~fixture-secret-123\x1b[201~\r',
                  'confirm': b'\r', 'confirm-batch': b'\x1b[A\r',
                  'multi': b'\r', 'cancel': b'\x1b', 'interrupt': b'\x03',
                  'text': b'\x1b[200~Example\x1b[201~\r'}
        if scenario == "terminate":
            proc.send_signal(signal.SIGTERM)
        if scenario in inputs:
            os.write(master, inputs[scenario])
        sent = True
try:
    proc.wait(timeout=max(.5, deadline-time.monotonic()))
except subprocess.TimeoutExpired:
    proc.kill(); proc.wait(); raise RuntimeError('PTY did not exit: '+data.decode(errors='replace'))
finally:
    os.close(master)
print(json.dumps({'code': proc.returncode, 'output': data.decode(errors='replace')}))
