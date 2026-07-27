#!/usr/bin/env python3
"""Run one command with a wall-clock timeout and capture stdout/stderr."""

from __future__ import annotations

import os
import signal
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 6 or sys.argv[4] != "--":
        print("usage: exec_timeout.py SECONDS STDOUT STDERR -- COMMAND...", file=sys.stderr)
        return 2
    timeout = float(sys.argv[1])
    stdout_path, stderr_path = sys.argv[2], sys.argv[3]
    command = sys.argv[5:]
    with open(stdout_path, "wb") as stdout, open(stderr_path, "wb") as stderr:
        process = subprocess.Popen(
            command,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
            env=os.environ.copy(),
        )
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return 124


if __name__ == "__main__":
    raise SystemExit(main())
