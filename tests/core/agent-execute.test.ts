import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeWriteDirective,
  renderOutputText,
} from "../../src/core/agent-execute.js";
import { EventBus, type ForemanEventMap } from "../../src/core/event-bus.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";
import { SessionManager } from "../../src/core/session.js";
import { createInMemoryDb } from "../../src/db/client.js";

// =============================================================================
// Foreman → Agent task execution + output relay — PR D of the multi-agent
// orchestration epic. Spawn engine (PR C) is exercised end-to-end here
// with real shell-script subprocesses; the Telegram relay is exercised via
// a fake fetch impl so we can assert payload shape without hitting the
// network.
// =============================================================================

function agent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: "codex",
    name: "Codex",
    tagline: "fixture",
    homepage: "https://example.com/",
    install: { npm: null, brew: null },
    config_paths: [],
    required_secrets: [],
    optional_secrets: [],
    mcp_compatible: true,
    supported_versions: "*",
    min_foreman_version: "0.1.0",
    ...overrides,
  } as AgentEntry;
}

describe("renderOutputText", () => {
  function input(message: string) {
    return {
      agentId: "codex",
      message,
      entry: agent({ task_command_template: "echo" }),
    };
  }

  it("renders an ok spawn with stdout + agent name header", () => {
    const text = renderOutputText(
      input("build the app"),
      {
        kind: "ok",
        exitCode: 0,
        stdout: "all done\nartifacts written\n",
        stderr: "",
        durationMs: 1500,
      },
    );
    expect(text).toContain("Codex");
    expect(text).toContain("finished your task");
    expect(text).toContain("all done");
    expect(text).toContain("artifacts written");
  });

  it("renders a failed spawn with exit code + stderr block", () => {
    const text = renderOutputText(
      input("x"),
      {
        kind: "failed",
        exitCode: 2,
        stdout: "",
        stderr: "ENOENT: missing file\n",
        durationMs: 100,
      },
    );
    expect(text).toContain("Exit code: 2");
    expect(text).toContain("ENOENT");
  });

  it("renders a timeout spawn with elapsed time + partial output", () => {
    const text = renderOutputText(
      input("x"),
      {
        kind: "timeout",
        stdout: "partial work...",
        stderr: "",
        durationMs: 5000,
        timeoutMs: 5000,
      },
    );
    expect(text).toContain("Timed out");
    expect(text).toContain("5s");
    expect(text).toContain("partial work");
  });

  it("truncates very long stdout to keep under Telegram's text limit", () => {
    const longOutput = "A".repeat(10_000);
    const text = renderOutputText(
      input("x"),
      {
        kind: "ok",
        exitCode: 0,
        stdout: longOutput,
        stderr: "",
        durationMs: 100,
      },
      3500,
    );
    expect(text).toContain("more chars truncated");
    // 3500 char limit + ~200 header/wrapping budget; comfortably under 4096.
    expect(text.length).toBeLessThan(4096);
  });

  it("renders an unsupported spawn (no task_command_template) as a clear warning", () => {
    const text = renderOutputText(
      input("x"),
      { kind: "unsupported", reason: "no template declared" },
    );
    expect(text).toContain("Cannot spawn");
    expect(text).toContain("no template declared");
  });

  it("renders a spawn-error with the underlying error message", () => {
    const text = renderOutputText(
      input("x"),
      { kind: "spawn-error", error: "ENOENT" },
    );
    expect(text).toContain("Spawn error");
    expect(text).toContain("ENOENT");
  });

  it("includes the task excerpt so the user sees what they asked for", () => {
    const text = renderOutputText(
      input("review PR #42 — focus on auth changes"),
      {
        kind: "ok",
        exitCode: 0,
        stdout: "done",
        stderr: "",
        durationMs: 50,
      },
    );
    expect(text).toContain("review PR");
  });

  // QA round 17 regression — Claude's normal English output contains
  // `.`, `!`, `-`, `(`, etc. — all MarkdownV2 reserved chars. Before
  // wrapping in code blocks, Telegram rejected the whole message with
  // HTTP 400 ("Character '.' is reserved and must be escaped") and the
  // user saw nothing. Wrap stdout in ``` and only escape ` / \ inside.
  it("wraps stdout in a code block so MarkdownV2 reserved chars don't break the message", () => {
    const text = renderOutputText(
      input("hi"),
      {
        kind: "ok",
        exitCode: 0,
        stdout: "Hello! I am Claude. Use `.` and `!` freely.\n",
        stderr: "",
        durationMs: 100,
      },
    );
    // Triple-backtick fence is the marker of a MarkdownV2 pre/code block.
    expect(text).toContain("```");
    // The reserved chars must reach Telegram LITERAL (no backslash
    // escape required inside a code block).
    expect(text).toContain("Hello! I am Claude.");
    expect(text).toContain("Use ");
  });

  it("escapes backticks + backslashes inside the code block (would otherwise close the fence)", () => {
    const text = renderOutputText(
      input("hi"),
      {
        kind: "ok",
        exitCode: 0,
        // Embedded backtick + backslash would either close the fence
        // early or land as a stray escape — break the message
        // structure. Must be backslash-escaped per Telegram docs.
        stdout: "Run `npm test` and check the C:\\path\n",
        stderr: "",
        durationMs: 100,
      },
    );
    expect(text).toContain("\\`npm test\\`");
    expect(text).toContain("C:\\\\path");
  });

  it("wraps stderr in a code block on failed spawns (same reserved-char fix)", () => {
    const text = renderOutputText(
      input("x"),
      {
        kind: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "Error: file not found at /tmp/foo.txt!\n",
        durationMs: 100,
      },
    );
    expect(text).toContain("```");
    expect(text).toContain("file not found");
    expect(text).toContain(".txt!");
  });
});

describe("executeWriteDirective", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-execute-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeScript(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  it("returns unsupported when entry has no task_command_template", async () => {
    const result = await executeWriteDirective(
      {
        agentId: "hermes",
        message: "hi",
        entry: agent({ id: "hermes", task_command_template: undefined }),
      },
      {},
    );
    expect(result.spawn.kind).toBe("unsupported");
    expect(result.outputRelay).toBeNull();
  });

  it("spawns the agent and POSTs the output back to Telegram", async () => {
    const echo = makeScript("echo.sh", "#!/bin/sh\necho \"hello: $1\"\n");
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "do the thing",
        entry: agent({ task_command_template: `${echo} {task}` }),
      },
      {
        telegramBotToken: "bot-123",
        telegramChatId: "456",
        fetchImpl: fakeFetch as unknown as typeof fetch,
      },
    );
    expect(result.spawn.kind).toBe("ok");
    expect(result.outputRelay?.status).toBe("ok");
    expect(fakeFetch).toHaveBeenCalledOnce();
    const call = fakeFetch.mock.calls[0]!;
    const url = call[0] as string;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(url).toContain("/botbot-123/sendMessage");
    expect(body.chat_id).toBe("456");
    expect(body.text).toContain("hello: do the thing");
    expect(body.parse_mode).toBe("MarkdownV2");
  });

  it("skips the Telegram relay when bot token is missing", async () => {
    const echo = makeScript("echo.sh", "#!/bin/sh\necho ok\n");
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "x",
        entry: agent({ task_command_template: echo }),
      },
      {},
    );
    expect(result.spawn.kind).toBe("ok");
    expect(result.outputRelay?.status).toBe("skipped");
    expect((result.outputRelay as { reason?: string }).reason).toContain(
      "telegram-bot-token",
    );
  });

  it("reports failed status with exit code + posts the failure to Telegram", async () => {
    const fail = makeScript("fail.sh", "#!/bin/sh\necho 'broke' >&2\nexit 3\n");
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    });
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "x",
        entry: agent({ task_command_template: fail }),
      },
      {
        telegramBotToken: "t",
        telegramChatId: "c",
        fetchImpl: fakeFetch as unknown as typeof fetch,
      },
    );
    expect(result.spawn.kind).toBe("failed");
    if (result.spawn.kind === "failed") {
      expect(result.spawn.exitCode).toBe(3);
    }
    const body = JSON.parse(
      (fakeFetch.mock.calls[0]![1] as { body: string }).body,
    );
    expect(body.text).toContain("Exit code: 3");
    expect(body.text).toContain("broke");
  });

  it("reports the failure to Telegram when the HTTP POST itself errors", async () => {
    const echo = makeScript("ok.sh", "#!/bin/sh\necho done\n");
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    });
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "x",
        entry: agent({ task_command_template: echo }),
      },
      {
        telegramBotToken: "t",
        telegramChatId: "c",
        fetchImpl: fakeFetch as unknown as typeof fetch,
      },
    );
    expect(result.spawn.kind).toBe("ok");
    expect(result.outputRelay?.status).toBe("failed");
    if (result.outputRelay?.status === "failed") {
      expect(result.outputRelay.reason).toContain("502");
    }
  });

  // ============================================================================
  // #517 Faz 3 wiring fix — taskSkipPermissions forwarded into spawnAgentTask.
  // Without this, the trust CLI's DB flag was a silent no-op + a trusted
  // codex still ran in `sandbox: read-only`. Bug surfaced in QA when the
  // operator ran `foreman agent trust codex` + codex still couldn't write
  // files. See manual QA report 2026-05-24.
  // ============================================================================

  it("forwards taskSkipPermissions=true so the spawn engine appends the trust flag", async () => {
    const argsDump = makeScript(
      "args.sh",
      '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n',
    );
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "do the thing",
        entry: agent({
          task_command_template: `${argsDump} "{task}"`,
          task_skip_permissions_flag: "--full-auto",
        }),
        taskSkipPermissions: true,
      },
      {},
    );
    expect(result.spawn.kind).toBe("ok");
    if (result.spawn.kind === "ok") {
      // The trust flag landed on argv exactly where the spawn engine
      // puts it (trailing position, after task + any model flag).
      expect(result.spawn.stdout).toContain("ARG:--full-auto");
      expect(result.spawn.stdout).toContain("ARG:do the thing");
    }
  });

  it("does NOT append the trust flag when taskSkipPermissions=false (default)", async () => {
    const argsDump = makeScript(
      "args.sh",
      '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n',
    );
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "do the thing",
        entry: agent({
          task_command_template: `${argsDump} "{task}"`,
          task_skip_permissions_flag: "--full-auto",
        }),
        // taskSkipPermissions intentionally omitted — default is "untrusted".
      },
      {},
    );
    expect(result.spawn.kind).toBe("ok");
    if (result.spawn.kind === "ok") {
      expect(result.spawn.stdout).not.toContain("--full-auto");
      // The task itself still made it through.
      expect(result.spawn.stdout).toContain("ARG:do the thing");
    }
  });

  it("forwards cwd to the spawn so the agent's workdir lands inside the user's project (#bug-B-cwd)", async () => {
    // Manual QA finding 2026-05-24: codex spawned in Foreman's cwd
    // (/Users/fatih/Projects/foreman) instead of the project the user
    // mentioned in the task text. With cwd forwarded, the spawn engine
    // hands the `cwd` option through to nodeSpawn, and the agent's
    // workdir matches what was requested.
    const pwd = makeScript("pwd.sh", "#!/bin/sh\npwd\n");
    const result = await executeWriteDirective(
      {
        agentId: "codex",
        message: "task",
        entry: agent({ task_command_template: pwd }),
        cwd: dir,
      },
      {},
    );
    expect(result.spawn.kind).toBe("ok");
    if (result.spawn.kind === "ok") {
      // macOS resolves /var → /private/var; both forms should be
      // accepted (the spawn used `dir`, the agent's `pwd` may resolve
      // symlinks). The relevant assertion is "the spawn cwd is the
      // tmpdir we passed", not the exact string form.
      expect(result.spawn.stdout.trim()).toMatch(
        new RegExp(`${dir.split("/").pop()}\\b`),
      );
    }
  });

  it("is a no-op when the catalog entry has no task_skip_permissions_flag even if trusted", async () => {
    // Hermes-style daemon agent: no flag in the catalog → trust is
    // meaningless on the spawn side. Defensive: don't append a phantom
    // empty string or crash.
    const argsDump = makeScript(
      "args.sh",
      '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n',
    );
    const result = await executeWriteDirective(
      {
        agentId: "hermes",
        message: "ping",
        entry: agent({
          task_command_template: `${argsDump} "{task}"`,
          // no task_skip_permissions_flag
        }),
        taskSkipPermissions: true,
      },
      {},
    );
    expect(result.spawn.kind).toBe("ok");
    if (result.spawn.kind === "ok") {
      const argLines = result.spawn.stdout
        .split("\n")
        .filter((l) => l.startsWith("ARG:"));
      // Just the task; no phantom flag.
      expect(argLines).toEqual(["ARG:ping"]);
    }
  });
});

// =============================================================================
// QA-fix 2026-05-24 (Wiring 4) — SessionManager wired around executeWriteDirective.
//
// Before: drain handler called `executeWriteDirective(...)` directly. No
// session row was opened, so:
//   - TUI Sessions panel showed "0 active" while real work happened
//   - `agents: last seen` heartbeat never advanced
//   - #523 lifecycle pushes ("▶️ codex started" / "✓ codex finished")
//     never fired
//   - #530 per-session cost rollup was always $0.00
//
// After: the executor opens a session BEFORE the spawn (so the started
// event fires while work is in flight) + closes it AFTER on outcome
// (`complete` on ok, `halt('manual')` on failure/timeout/spawn-error).
// Both terminal paths emit `session:completed` which the notification
// bridge routes as the lifecycle push. Best-effort throughout: a session
// throw must NEVER kill the spawn — the agent's work matters more than
// our bookkeeping.
// =============================================================================

describe("executeWriteDirective — SessionManager wiring", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-session-exec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeScript(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  function makeManager(): {
    bus: EventBus<ForemanEventMap>;
    manager: SessionManager;
    cleanup: () => void;
    events: Array<{ name: string; payload: unknown }>;
  } {
    const handle = createInMemoryDb();
    const bus = new EventBus<ForemanEventMap>();
    const manager = new SessionManager(handle.db, { bus });
    const events: Array<{ name: string; payload: unknown }> = [];
    bus.on("session:started", (p) => events.push({ name: "started", payload: p }));
    bus.on("session:completed", (p) =>
      events.push({ name: "completed", payload: p }),
    );
    bus.on("session:halted", (p) => events.push({ name: "halted", payload: p }));
    return { bus, manager, events, cleanup: () => handle.sqlite.close() };
  }

  it("opens a session with the user_command:write trigger + completes it on ok spawn", async () => {
    const { manager, events, cleanup } = makeManager();
    try {
      const echo = makeScript("echo.sh", "#!/bin/sh\necho done\n");
      const result = await executeWriteDirective(
        {
          agentId: "codex",
          message: "do the thing",
          entry: agent({ task_command_template: echo }),
          sessionManager: manager,
        },
        {},
      );
      expect(result.spawn.kind).toBe("ok");

      // The session row landed + transitioned active → completed.
      const allSessions = manager.list();
      expect(allSessions).toHaveLength(1);
      expect(allSessions[0]!.status).toBe("completed");
      expect(allSessions[0]!.participants).toEqual(["codex"]);

      // The lifecycle bridge needs both ends: started (so the user
      // gets the "▶️ codex started" push) and completed{outcome:
      // 'success'} (the "✓ codex finished" push).
      const started = events.find((e) => e.name === "started");
      expect(started).toBeDefined();
      expect((started!.payload as { trigger: string }).trigger).toBe(
        "user_command:write",
      );
      expect(
        (started!.payload as { participants: string[] }).participants,
      ).toEqual(["codex"]);

      const completed = events.find((e) => e.name === "completed");
      expect(completed).toBeDefined();
      expect((completed!.payload as { outcome: string }).outcome).toBe(
        "success",
      );
    } finally {
      cleanup();
    }
  });

  it("tags the session with projectTag = basename(cwd) so completion push shows '(todo-app)' (#530)", async () => {
    const { manager, events, cleanup } = makeManager();
    try {
      const echo = makeScript("echo.sh", "#!/bin/sh\necho ok\n");
      // The cwd basename becomes the project tag — directly visible
      // to the user in the lifecycle push's parens suffix.
      const result = await executeWriteDirective(
        {
          agentId: "codex",
          message: "task",
          entry: agent({ task_command_template: echo }),
          cwd: dir,
          sessionManager: manager,
        },
        {},
      );
      expect(result.spawn.kind).toBe("ok");
      const completed = events.find((e) => e.name === "completed");
      expect(completed).toBeDefined();
      expect((completed!.payload as { projectTag?: string }).projectTag).toBe(
        basename(dir),
      );
    } finally {
      cleanup();
    }
  });

  it("halts the session ('manual') when the spawn fails so the user sees a 'halted' lifecycle push", async () => {
    const { manager, events, cleanup } = makeManager();
    try {
      const fail = makeScript("fail.sh", "#!/bin/sh\necho 'broke' >&2\nexit 5\n");
      const result = await executeWriteDirective(
        {
          agentId: "codex",
          message: "x",
          entry: agent({ task_command_template: fail }),
          sessionManager: manager,
        },
        {},
      );
      expect(result.spawn.kind).toBe("failed");

      // halt() fires session:halted AND session:completed{outcome:
      // 'halted'} (manual halts terminate immediately, no resolution
      // wait). Both are needed: notification bridge listens for
      // completed to push the "⚠ halted" lifecycle.
      const halted = events.find((e) => e.name === "halted");
      expect(halted).toBeDefined();
      expect((halted!.payload as { reason: string }).reason).toBe("manual");

      const completed = events.find((e) => e.name === "completed");
      expect(completed).toBeDefined();
      expect((completed!.payload as { outcome: string }).outcome).toBe(
        "halted",
      );

      // DB transitioned active → halted (not completed).
      const sessions = manager.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe("halted");
    } finally {
      cleanup();
    }
  });

  it("does NOT open a session when sessionManager is omitted (preserves old behavior for test paths)", async () => {
    // The drain handler always passes sessionManager in production, but
    // executeWriteDirective is also called from unit tests and from
    // tools that don't need lifecycle tracking. Sanity check: no
    // bookkeeping happens when the caller doesn't ask for it.
    const { manager, events, cleanup } = makeManager();
    try {
      const echo = makeScript("echo.sh", "#!/bin/sh\necho done\n");
      const result = await executeWriteDirective(
        {
          agentId: "codex",
          message: "x",
          entry: agent({ task_command_template: echo }),
          // sessionManager intentionally omitted
        },
        {},
      );
      expect(result.spawn.kind).toBe("ok");
      expect(manager.list()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("survives a startSession throw — spawn still runs, no crash, no session row", async () => {
    // SessionManager bookkeeping is best-effort. If the DB write blows
    // up (locked, disk full, migration mismatch, whatever) the agent's
    // task still needs to run — Foreman's job is to spawn the work,
    // not to gate it behind bookkeeping. Verify by handing in a
    // broken-on-startSession manager.
    const { manager, cleanup } = makeManager();
    try {
      const echo = makeScript("echo.sh", "#!/bin/sh\necho done\n");
      // Stub startSession to throw; spawn must proceed anyway.
      const startSpy = vi
        .spyOn(manager, "startSession")
        .mockImplementation(() => {
          throw new Error("simulated db failure");
        });
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const result = await executeWriteDirective(
        {
          agentId: "codex",
          message: "x",
          entry: agent({ task_command_template: echo }),
          sessionManager: manager,
        },
        {},
      );
      expect(result.spawn.kind).toBe("ok");
      expect(startSpy).toHaveBeenCalledOnce();
      // The failure was logged to stderr (operator-visible diagnostic)
      // but the spawn outcome is what callers see.
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
      startSpy.mockRestore();
    } finally {
      cleanup();
    }
  });
});
