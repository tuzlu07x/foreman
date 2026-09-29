import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGateway } from "../../src/core/doctor.js";
import {
  acquireForemanPidfile,
  ForemanAlreadyRunningError,
  getForemanPidfilePath,
  PIDFILE_STALE_MS,
  readForemanPidInfo,
  releaseForemanPidfile,
  touchForemanPidfile,
} from "../../src/core/foreman-pidfile.js";
import { approvalReach, gatewayHolder, probeGateway } from "../../src/core/gateway.js";
import { NotifyConfigSchema } from "../../src/core/notification/notify-config.js";

// One gateway per home (src/core/gateway.ts): the pidfile says which kind
// holds it, and a stale one never makes `foreman start` attach to nothing.
describe("gateway: who holds the home", () => {
  let home: string;
  const OTHER = 424242;
  const alive = (pid: number): boolean => pid === OTHER || pid === process.pid;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fm-gw-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const pidfile = (content: string, ageMs = 0): void => {
    const path = getForemanPidfilePath(home);
    writeFileSync(path, content, { mode: 0o600 });
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
  };

  it("is none without a pidfile", () => {
    expect(probeGateway(home)).toEqual({ state: "none" });
  });

  it("reads the mode, and treats a pidfile without one as a TUI", () => {
    pidfile(`${OTHER}\nheadless\n`);
    expect(probeGateway(home, { alive })).toMatchObject({ state: "running", pid: OTHER, mode: "headless" });
    pidfile(String(OTHER));
    expect(probeGateway(home, { alive })).toMatchObject({ state: "running", pid: OTHER, mode: "tui" });
  });

  it("ignores a stale pidfile: a dead pid, one written before this boot, a reused pid", () => {
    pidfile(`${OTHER}\nheadless\n`);
    expect(probeGateway(home, { alive: () => false })).toEqual({ state: "none" });

    // Written an hour ago, the machine booted ten minutes ago: the pid has
    // been handed out again since.
    pidfile(`${OTHER}\nheadless\n`, 60 * 60_000);
    expect(probeGateway(home, { alive, bootTime: () => Date.now() - 10 * 60_000 })).toEqual({ state: "none" });

    // Same boot, heartbeat stopped, and the pid now belongs to something else.
    pidfile(`${OTHER}\nheadless\n`, PIDFILE_STALE_MS + 5_000);
    expect(probeGateway(home, { alive, command: () => "/usr/bin/vim notes.txt" })).toEqual({ state: "none" });
  });

  it("keeps a Foreman whose heartbeat is only late: two gateways would be worse than a refused start", () => {
    pidfile(`${OTHER}\nheadless\n`, PIDFILE_STALE_MS + 5_000);
    const probe = probeGateway(home, { alive, command: () => "/usr/local/bin/node /opt/foreman/dist/cli/index.js daemon --service" });
    expect(probe).toMatchObject({ state: "running", mode: "headless" });
    // A command line it can't read is not proof of reuse either.
    expect(probeGateway(home, { alive, command: () => null })).toMatchObject({ state: "running" });
  });

  it("acquires with a mode, refuses a second holder, and touches or releases only its own file", () => {
    acquireForemanPidfile(home, "headless");
    expect(readFileSync(getForemanPidfilePath(home), "utf-8")).toBe(`${process.pid}\nheadless\n`);
    expect(readForemanPidInfo(home)).toMatchObject({ pid: process.pid, mode: "headless" });

    // Another live process holds it (our parent stands in): refused, and
    // the file is untouched.
    pidfile(`${process.ppid}\ntui\n`, 10_000);
    expect(() => acquireForemanPidfile(home, "headless")).toThrow(ForemanAlreadyRunningError);
    const before = readFileSync(getForemanPidfilePath(home), "utf-8");
    touchForemanPidfile(home);
    releaseForemanPidfile(home);
    expect(readFileSync(getForemanPidfilePath(home), "utf-8")).toBe(before);
    expect(readForemanPidInfo(home)!.heartbeatAgeMs).toBeGreaterThanOrEqual(9_000);
  });

  it("names the holder", () => {
    expect(gatewayHolder({ state: "none" })).toBe("not running");
    expect(gatewayHolder({ state: "running", pid: 7, mode: "headless", heartbeatAgeMs: 0 })).toBe(
      "the background service (pid 7)",
    );
    expect(gatewayHolder({ state: "running", pid: 7, mode: "tui", heartbeatAgeMs: 0 })).toBe("`foreman start` (pid 7)");
  });

  it("the error names the pid that holds the home", () => {
    const err = new ForemanAlreadyRunningError(OTHER, getForemanPidfilePath(home));
    expect(err.message).toContain(`pid ${OTHER}`);
  });
});

describe("gateway: where approvals go", () => {
  const secrets = { exists: () => true, get: (name: string) => `value-of-${name}` };

  it("lists routed channels, and the ones you can decide from", () => {
    const config = NotifyConfigSchema.parse({
      channels: {
        telegram: { enabled: true, bot_token_ref: "tg", chat_id: "1", approval_bot_token_ref: "tg-approve" },
        slack: { enabled: true, webhook_url_ref: "slack-hook" },
        ntfy: { enabled: false },
      },
      routing: { critical: { channels: ["telegram", "slack"] } },
    });
    const secretsWithUrl = { ...secrets, get: (name: string) => (name === "slack-hook" ? "https://hooks.slack.com/services/T/B/x" : `v-${name}`) };
    expect(approvalReach(config, secretsWithUrl)).toEqual({ notified: ["telegram", "slack"], decide: ["telegram"] });
  });

  it("decides on the one Telegram bot when no chat agent shares it (#716)", () => {
    const config = NotifyConfigSchema.parse({
      channels: { telegram: { enabled: true, bot_token_ref: "tg", chat_id: "1" } },
      routing: { critical: { channels: ["telegram"] } },
    });
    expect(approvalReach(config, secrets)).toEqual({ notified: ["telegram"], decide: ["telegram"] });
    expect(approvalReach(config, secrets, ["hermes"])).toEqual({ notified: ["telegram"], decide: [] });
  });

  it("leaves out a channel that is enabled but no level routes to, or that can't be built", () => {
    const config = NotifyConfigSchema.parse({
      channels: { telegram: { enabled: true }, system: { enabled: true } },
      routing: { critical: { channels: ["telegram"] } },
    });
    // telegram lacks bot_token_ref / chat_id; system isn't routed.
    expect(approvalReach(config, secrets)).toEqual({ notified: [], decide: [] });
  });
});

describe("doctor: gateway", () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.FOREMAN_HOME;
    home = mkdtempSync(join(tmpdir(), "fm-dg-"));
    chmodSync(home, 0o700);
    process.env.FOREMAN_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FOREMAN_HOME;
    else process.env.FOREMAN_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it("says how to run it when nothing does", () => {
    expect(checkGateway()).toMatchObject({ status: "ok", message: expect.stringContaining("not running") });
  });

  it("names the running gateway, and warns when its heartbeat stopped", () => {
    writeFileSync(getForemanPidfilePath(home), `${process.pid}\nheadless\n`, { mode: 0o600 });
    expect(checkGateway()).toMatchObject({
      status: "ok",
      message: `the background service (pid ${process.pid}) — approvals wait in the TUI (no chat channel routed)`,
    });
    const at = new Date(Date.now() - PIDFILE_STALE_MS - 30_000);
    utimesSync(getForemanPidfilePath(home), at, at);
    const r = checkGateway();
    expect(r.status).toBe("warn");
    expect(r.message).toContain("hasn't checked in");
    expect(r.remediation).toContain("foreman service status");
  });
});
