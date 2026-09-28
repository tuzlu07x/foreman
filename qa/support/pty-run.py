"""Run a command in a pseudo-terminal for the QA suite (docs/qa.md).

The macOS stand-in for util-linux `script -qfec CMD /dev/null`, which the
suite uses on Linux. Python 3's standard library only (python3 ships with
the Xcode Command Line Tools), so QA needs no native npm dependency.

    python3 -I pty-run.py --cols 120 --rows 40 -- CMD [ARG...]

- CMD runs in a new session on the pty's slave side, sized COLS x ROWS
  before it starts (what `stty cols 120 rows 40` does on Linux).
- This process's stdin (the test's pipe: keystrokes) is copied into the
  pty; everything the pty shows is copied to stdout, unbuffered.
- SIGTERM, SIGINT and SIGHUP are forwarded to CMD.
- The exit code is CMD's (128 + N when signal N killed it), as `script -e`
  passes it through.
"""

import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

# After CMD exits, how long to keep reading what it left in the pty.
DRAIN_SECONDS = 0.5


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except InterruptedError:
            continue
        data = data[n:]


def exit_code(status):
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


def main():
    parser = argparse.ArgumentParser(description="run a command in a pty")
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    opts = parser.parse_args()
    argv = opts.command[1:] if opts.command[:1] == ["--"] else opts.command
    if not argv:
        parser.error("no command given")

    pid, master = pty.fork()
    if pid == 0:
        # The child: stdin/stdout/stderr are the pty's slave side.
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", opts.rows, opts.cols, 0, 0))
            os.execvp(argv[0], argv)
        except OSError as err:
            os.write(2, ("pty-run: cannot run %s: %s\n" % (argv[0], err)).encode())
        os._exit(127)

    def forward(signum, _frame):
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)
    # The test may stop reading our stdout before we are done.
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    stdin_open = True
    stdout_open = True
    status = None
    drain_until = None
    while True:
        if status is None:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = st
                # Grandchildren may keep the slave open: don't wait for EOF.
                drain_until = time.monotonic() + DRAIN_SECONDS
        if status is not None and time.monotonic() >= drain_until:
            break
        timeout = 0.1 if status is None else max(0.0, drain_until - time.monotonic())
        watch = [master] + ([0] if stdin_open and status is None else [])
        readable, _, _ = select.select(watch, [], [], timeout)
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as err:
                # macOS and Linux report a closed slave as EIO.
                if err.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            if stdout_open:
                try:
                    write_all(1, data)
                except OSError:
                    stdout_open = False
        elif status is not None:
            break
        if 0 in readable:
            data = os.read(0, 65536)
            if data:
                try:
                    write_all(master, data)
                except OSError:
                    stdin_open = False
            else:
                stdin_open = False

    if status is None:
        _, status = os.waitpid(pid, 0)
    sys.exit(exit_code(status))


if __name__ == "__main__":
    main()
