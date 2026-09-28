#!/usr/bin/env node
// Measures `foreman-hook claude-code` latency (process spawn to exit) for an
// everyday call, with and without the hub daemon. Runs against a throwaway
// FOREMAN_HOME and HOME; never touches your real Foreman state.
//
//   npm run build && node scripts/hook-latency.mjs [runs]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist/cli/index.js");
const HOOK = join(ROOT, "dist/cli/hook.js");
const RUNS = Number.parseInt(process.argv[2] ?? "30", 10);
// A fresh agent id and session per call: the risk engine would (rightly)
// escalate dozens of calls a minute from one agent.
let seq = 0;

const home = mkdtempSync(join(tmpdir(), "fm-lat-"));
const env = {
  ...process.env,
  FOREMAN_HOME: home,
  HOME: home,
  FOREMAN_NO_UPDATE_CHECK: "1",
  // Nothing here waits on a person: an escalated call is denied at once
  // (and shows up as exit 2).
  FOREMAN_APPROVAL_TIMEOUT: "0",
};
delete env.FOREMAN_AGENT_TOKEN;
delete env.FOREMAN_AGENT_TOKEN_FILE;

function hookOnce() {
  return new Promise((done, fail) => {
    const started = process.hrtime.bigint();
    const id = `latency-${++seq}`;
    const child = spawn(process.execPath, [HOOK, id], { env, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", fail);
    child.on("exit", (code) => done({ code, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    child.stdin.end(JSON.stringify({ session_id: id, tool_name: "Bash", tool_input: { command: "ls" } }));
  });
}

async function measure(label) {
  await hookOnce(); // warm the file cache
  const times = [];
  const codes = new Set();
  for (let i = 0; i < RUNS; i++) {
    const { code, ms } = await hookOnce();
    codes.add(code);
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))].toFixed(1);
  console.log(`${label.padEnd(18)} runs=${RUNS} exit=${[...codes].join(",")} p50=${pct(50)}ms p90=${pct(90)}ms min=${times[0].toFixed(1)}ms`);
}

try {
  spawnSync(process.execPath, [CLI, "init"], { env, stdio: "ignore" });
  await measure("in-process");
  const daemon = spawn(process.execPath, [CLI, "daemon"], { env, stdio: ["ignore", "ignore", "inherit"] });
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(home, "foreman.sock")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(join(home, "foreman.sock"))) throw new Error("daemon did not come up");
  await measure("daemon");
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.on("exit", r));
} finally {
  rmSync(home, { recursive: true, force: true });
}
