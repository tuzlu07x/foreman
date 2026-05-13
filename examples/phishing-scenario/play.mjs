#!/usr/bin/env node
// Drives `foreman mcp-stdio` as if a Claude-Code-like client were
// stepping through the demo. Run it in one terminal while Foreman's
// TUI runs in another — the Activity / Approval flows light up in real
// time, exactly the way the asciinema cast captures.
//
//   node examples/phishing-scenario/play.mjs [--bin <path-to-foreman>]
//
// All beats and their timings match STORYBOARD.md.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const binArg = args.indexOf("--bin");
const FOREMAN_BIN = binArg !== -1 ? args[binArg + 1] : "foreman";

const SOURCE = "claude-code";

const child = spawn(FOREMAN_BIN, ["mcp-stdio", "--source", SOURCE], {
  stdio: ["pipe", "pipe", "inherit"],
});

child.stdout.setEncoding("utf-8");
child.stdout.on("data", (chunk) => {
  process.stdout.write(`← ${chunk}`);
});
child.on("exit", (code) => {
  console.log(`foreman mcp-stdio exited with code ${code ?? 0}`);
});

function send(id, method, params) {
  const msg = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(`→ ${line}`);
  child.stdin.write(line);
}

async function play() {
  console.log("=== act 1 — handshake ===");
  send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "demo-client", version: "0.0.0" },
  });
  await sleep(800);

  send(2, "tools/list");
  await sleep(1200);

  console.log("\n=== act 2 — normal traffic ===");
  send(3, "tools/call", {
    name: "read_file",
    arguments: { path: "src/auth.ts" },
  });
  await sleep(1400);

  send(4, "tools/call", {
    name: "list_files",
    arguments: { directory: "src/" },
  });
  await sleep(2000);

  console.log("\n=== act 3 — phishing beat ===");
  console.log("(an attacker email tricks the assistant into asking for .env)");
  send(5, "tools/call", {
    name: "read_file",
    arguments: { path: ".env" },
  });

  // Hold long enough for the user to see the approval modal pop, hit `i`
  // for inspect, then deny.
  console.log("\nHold here — approve or deny in the TUI.");
  console.log("(SIGINT or wait 60s for the default-deny timeout to fire)");

  await sleep(75_000);

  console.log("\n=== act 4 — outro ===");
  send(6, "tools/call", {
    name: "shell_exec",
    arguments: { cmd: "ls" },
  });
  await sleep(2000);

  child.stdin.end();
}

process.on("SIGINT", () => {
  child.kill("SIGINT");
  process.exit(0);
});

play().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
