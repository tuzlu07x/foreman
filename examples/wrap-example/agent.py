#!/usr/bin/env python3
"""
Minimal MCP-emitting agent for `foreman wrap` smoke testing.

The script doesn't actually do anything useful — it sends three fake tool
calls (one safe, one secret-shaped, one dangerous shell) so the wrap pipeline
exercises the allow / ask / deny paths and you can watch them in the
foreman activity panel.

Usage (after `foreman init`):
    foreman wrap --name py-agent -- python3 examples/wrap-example/agent.py
"""
from __future__ import annotations

import json
import sys
import time

CALLS = [
    {"name": "list_files", "arguments": {"path": "."}},
    {"name": "read_file",  "arguments": {"path": ".env"}},
    {"name": "shell_exec", "arguments": {"command": "rm -rf /tmp/foreman-demo"}},
]


def send(req_id: int, name: str, arguments: dict) -> None:
    """Emit an MCP `tools/call` request on stdout."""
    msg = {
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def read_response() -> dict | None:
    """Block on one line of stdin and parse it as JSON."""
    line = sys.stdin.readline()
    if not line:
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"(py-agent) bad response: {exc}\n")
        return None


def main() -> int:
    for i, call in enumerate(CALLS, start=1):
        send(i, call["name"], call["arguments"])
        resp = read_response()
        if resp is None:
            sys.stderr.write("(py-agent) stdin closed, exiting\n")
            return 1
        if "result" in resp:
            text = resp["result"]["content"][0]["text"]
            sys.stderr.write(f"(py-agent) #{i} {call['name']}: {text}\n")
        elif "error" in resp:
            sys.stderr.write(
                f"(py-agent) #{i} {call['name']}: DENIED — {resp['error']['message']}\n"
            )
        time.sleep(0.2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
