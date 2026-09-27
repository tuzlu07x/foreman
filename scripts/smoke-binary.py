#!/usr/bin/env python3
"""Smoke-test a standalone foreman binary on the machine that built it.

    python3 scripts/smoke-binary.py dist-binaries/foreman-<label>

Every check runs in a throwaway HOME, FOREMAN_HOME and XDG_CACHE_HOME, from
an empty working directory, so nothing in the checkout (or the runner's
node_modules) can stand in for a file missing from the binary. Node is only
used to run the MCP fixture server that `mcp tools` connects to.

Standard library only: `pty` drives the TUI and the demo, which need a
terminal, the same way on macOS and Linux.
"""

import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, "tests", "core", "mcp-hub", "fixtures", "demo-server.mjs")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]")

results = []


def check(name):
    def wrap(fn):
        def run(*args):
            started = time.monotonic()
            try:
                detail = fn(*args)
            except Exception as err:  # noqa: BLE001 - report every failure the same way
                results.append((name, False, f"{type(err).__name__}: {err}"))
                print(f"FAIL {name}: {err}", flush=True)
                return False
            took = time.monotonic() - started
            results.append((name, True, detail or ""))
            print(f"ok   {name} ({took:.1f}s){': ' + detail if detail else ''}", flush=True)
            return True

        return run

    return wrap


def run(binary, args, env, cwd, timeout=60, stdin=None):
    return subprocess.run(
        [binary, *args], env=env, cwd=cwd, input=stdin, capture_output=True, text=True, timeout=timeout
    )


def in_pty(binary, args, env, cwd, until, then_keys, timeout=60, rows=40, cols=120):
    """Run in a pseudo-terminal until `until` matches the screen text, type
    `then_keys`, and wait for the exit. Returns (exit code, screen text)."""
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execve(binary, [binary, *args], env)
    import fcntl
    import struct
    import termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    out = b""
    sent = False
    deadline = time.monotonic() + timeout
    status = None
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                out += chunk
            text = ANSI.sub("", out.decode("utf-8", "replace"))
            if not sent and re.search(until, text):
                time.sleep(1.0)  # let the first frames settle before typing
                os.write(fd, then_keys)
                sent = True
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
                break
        if status is None:
            # Drain, then give it a moment to exit after the keys.
            end = time.monotonic() + 10
            while time.monotonic() < end:
                done, st = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = st
                    break
                ready, _, _ = select.select([fd], [], [], 0.2)
                if ready:
                    try:
                        out += os.read(fd, 65536)
                    except OSError:
                        pass
    finally:
        if status is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)
    text = ANSI.sub("", out.decode("utf-8", "replace"))
    if status is None:
        raise RuntimeError(f"still running after {timeout}s (keys sent: {sent}); output tail:\n{text[-1500:]}")
    if not sent:
        raise RuntimeError(f"exited before showing {until!r}; output tail:\n{text[-1500:]}")
    return os.waitstatus_to_exitcode(status), text


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    binary = os.path.abspath(sys.argv[1])
    with open(os.path.join(REPO, "package.json")) as f:
        expected = json.load(f)["version"]

    work = tempfile.mkdtemp(prefix="foreman-smoke-")
    cwd = os.path.join(work, "cwd")
    home = os.path.join(work, "foreman-home")
    for d in (cwd, os.path.join(work, "home"), os.path.join(work, "cache")):
        os.makedirs(d)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.path.join(work, "home"),
        "FOREMAN_HOME": home,
        "XDG_CACHE_HOME": os.path.join(work, "cache"),
        "FOREMAN_NO_UPDATE_CHECK": "1",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }

    @check("binary is executable")
    def executable():
        if not os.access(binary, os.X_OK):
            raise RuntimeError(f"{binary} is not executable")
        return f"{os.path.getsize(binary) / 1024 / 1024:.1f} MB"

    @check("--version")
    def version():
        r = run(binary, ["--version"], env, cwd)
        if r.returncode != 0 or r.stdout.strip() != expected:
            raise RuntimeError(f"rc={r.returncode} stdout={r.stdout.strip()!r} (want {expected!r}) stderr={r.stderr[-500:]}")
        return r.stdout.strip()

    @check("init (better-sqlite3 + migrations)")
    def init():
        r = run(binary, ["init"], env, cwd)
        if r.returncode != 0:
            raise RuntimeError(f"rc={r.returncode} stderr={r.stderr[-1500:]}")
        if not os.path.exists(os.path.join(home, "foreman.db")):
            raise RuntimeError("no foreman.db after init")
        runtime = os.path.join(home, "cache", "runtime")
        dirs = os.listdir(runtime)
        if len(dirs) != 1 or not os.path.exists(os.path.join(runtime, dirs[0], "lib", "better_sqlite3.node")):
            raise RuntimeError(f"unexpected runtime dir contents: {dirs}")
        return f"runtime dir {dirs[0]}"

    @check("doctor --json")
    def doctor():
        r = run(binary, ["doctor", "--json"], env, cwd)
        report = json.loads(r.stdout)
        failed = [c.get("id") or c.get("name") for c in report["checks"] if c.get("status") == "fail"]
        if r.returncode not in (0, 1) or failed:
            raise RuntimeError(f"rc={r.returncode} failed checks={failed}")
        return f"rc={r.returncode}, {len(report['checks'])} checks, none failed"

    @check("mcp-stdio initialize + tools/list")
    def mcp_stdio():
        p = subprocess.Popen(
            [binary, "mcp-stdio", "--source", "claude-code"],
            env=env,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            send = lambda m: (p.stdin.write(json.dumps(m) + "\n"), p.stdin.flush())  # noqa: E731
            send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}}})
            send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            replies = {}
            deadline = time.monotonic() + 30
            while 2 not in replies and time.monotonic() < deadline:
                line = p.stdout.readline()
                if not line:
                    break
                msg = json.loads(line)
                if "id" in msg:
                    replies[msg["id"]] = msg
            if 1 not in replies or "result" not in replies[1]:
                raise RuntimeError(f"no initialize result: {replies.get(1)}")
            tools = replies.get(2, {}).get("result", {}).get("tools")
            if not tools:
                raise RuntimeError(f"no tools/list result: {replies.get(2)}")
            server = replies[1]["result"].get("serverInfo", {}).get("name")
            return f"server {server!r}, {len(tools)} tools"
        finally:
            p.stdin.close()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()

    @check("mcp tools --json (SDK client over stdio)")
    def mcp_tools():
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("node is needed to run the MCP fixture server")
        with open(os.path.join(home, "mcp.yaml"), "w") as f:
            f.write(f"servers:\n  demo:\n    command: {json.dumps(node)}\n    args: [{json.dumps(FIXTURE)}]\n")
        r = run(binary, ["mcp", "tools", "--json"], env, cwd)
        if r.returncode != 0:
            raise RuntimeError(f"rc={r.returncode} stderr={r.stderr[-1500:]}")
        data = json.loads(r.stdout)
        status = {s["name"]: s for s in data["servers"]}.get("demo", {})
        names = sorted(t["name"] for t in data["tools"] if t.get("server") == "demo")
        if status.get("source") == "unavailable" or "echo" not in names:
            raise RuntimeError(f"demo server status={status} tools={names}")
        os.remove(os.path.join(home, "mcp.yaml"))
        return f"source {status.get('source')}, tools {', '.join(names)}"

    @check("TUI: start --skip-setup, dashboard, quit on q")
    def tui():
        # The footer only renders once the dashboard has laid out (box
        # drawing and all, which needs a full-ICU Node).
        code, text = in_pty(binary, ["start", "--skip-setup"], env, cwd, until=r"q quit", then_keys=b"q")
        if code != 0 or "allowed" not in text:
            raise RuntimeError(f"exit code {code}; tail:\n{text[-1500:]}")
        return "dashboard rendered, exit 0"

    @check("demo: banner, TUI, quit on q (TTY)")
    def demo():
        # The demo re-runs the binary for init, seeding and the TUI, so
        # this also covers the binary starting itself. The exit code isn't
        # checked: quitting mid-demo can race the control channel against
        # the database closing (exit 7), which `node dist/cli/index.js demo`
        # does the same way; it isn't specific to the binary.
        code, text = in_pty(binary, ["demo"], env, cwd, until=r"Foreman demo(?s:.*)q quit", then_keys=b"q", timeout=120)
        if "demo cleaned up" not in text:
            raise RuntimeError(f"exit code {code}; tail:\n{text[-1500:]}")
        return f"banner, dashboard, cleaned up (exit {code})"

    checks = [executable, version, init, doctor, mcp_stdio, mcp_tools, tui, demo]
    try:
        for c in checks:
            c()
    finally:
        shutil.rmtree(work, ignore_errors=True)
    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
