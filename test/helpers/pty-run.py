"""Run one command under a real PTY of a given width; print {"code", "output"} as JSON.

Usage: pty-run.py COLS CWD -- CMD [ARGS...]   (environment is inherited from the caller)
Standard library only, like terminal-pty.py; no native Node PTY addon is required.
"""
import fcntl, json, os, pty, select, struct, sys, termios, time

cols, cwd = int(sys.argv[1]), sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, cols, 0, 0))
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)
data = bytearray()
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    if not select.select([fd], [], [], 0.1)[0]:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    data.extend(chunk)
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "output": data.decode("utf-8", "replace")}))
