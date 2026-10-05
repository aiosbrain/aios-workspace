"""Run one command under a real PTY of a given width; print {"code", "output"} as JSON.

Usage: pty-run.py COLS CWD -- CMD [ARGS...]   (environment is inherited from the caller)
Standard library only, like terminal-pty.py; no native Node PTY addon is required.
"""
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time

cols, cwd = int(sys.argv[1]), sys.argv[2]
argv = sys.argv[sys.argv.index("--") + 1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, cols, 0, 0))
proc = subprocess.Popen(argv, cwd=cwd, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
data = bytearray()
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    if select.select([master], [], [], 0.1)[0]:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        data.extend(chunk)
    elif proc.poll() is not None:
        break
try:
    proc.wait(timeout=max(0.5, deadline - time.monotonic()))
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait()
finally:
    os.close(master)
print(json.dumps({"code": proc.returncode, "output": data.decode("utf-8", "replace")}))
