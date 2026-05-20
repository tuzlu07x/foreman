import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildArgvFromTemplate,
  spawnAgentTask,
} from "../../src/core/agent-spawn.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";

// =============================================================================
// Generic agent spawn engine — PR C of the multi-agent orchestration epic.
// Uses real subprocesses via shell scripts in a tmpdir so the spawn /
// capture / timeout paths are exercised end-to-end. No mocking of
// child_process — the engine is the thing the user actually relies on.
// =============================================================================

function agent(overrides: Partial<AgentEntry>): AgentEntry {
  return {
    id: "test-agent",
    name: "Test Agent",
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

describe("buildArgvFromTemplate", () => {
  it("tokenizes a simple `cmd arg ${task}` template", () => {
    const argv = buildArgvFromTemplate("codex exec {task}", "hello world");
    expect(argv).toEqual(["codex", "exec", "hello world"]);
  });

  it("preserves quoted `${task}` as a single argv element (no shell injection)", () => {
    // Template author quotes ${task} as a hint; shell-quote treats the
    // entire quoted segment as one token. Substitution keeps it as one
    // arg even though the task contains spaces.
    const argv = buildArgvFromTemplate(
      'claude --print "{task}"',
      "hello there",
    );
    expect(argv).toEqual(["claude", "--print", "hello there"]);
  });

  it("substitutes the literal task text — no shell metachar escaping (because no shell)", () => {
    // Embedded shell metachars in the task text stay LITERAL — the engine
    // spawns without a shell so `; rm -rf` is just a string, not a command.
    const argv = buildArgvFromTemplate(
      "codex exec {task}",
      "; rm -rf /",
    );
    expect(argv).toEqual(["codex", "exec", "; rm -rf /"]);
  });

  it("returns null on shell pipe / redirect operators in template", () => {
    // We don't support `|` / `>` in a task template — those would imply
    // wrapping in a shell, defeating the no-shell safety guarantee.
    expect(buildArgvFromTemplate("codex exec {task} | tee log", "x"))
      .toBeNull();
  });

  it("handles a template with no ${task} token (pass-through)", () => {
    expect(buildArgvFromTemplate("codex --version", "ignored"))
      .toEqual(["codex", "--version"]);
  });

  it("substitutes multi-line task content as a single arg", () => {
    const argv = buildArgvFromTemplate(
      'claude --print "{task}"',
      "line 1\nline 2\nline 3",
    );
    expect(argv).toEqual(["claude", "--print", "line 1\nline 2\nline 3"]);
  });
});

describe("spawnAgentTask", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-spawn-"));
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
    const result = await spawnAgentTask({
      entry: agent({ id: "hermes" }),
      task: "hi",
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.reason).toContain("hermes");
      expect(result.reason).toContain("task_command_template");
    }
  });

  it("captures stdout on a successful run", async () => {
    const cmd = makeScript(
      "echo-task.sh",
      "#!/bin/sh\necho \"got: $1\"\n",
    );
    const result = await spawnAgentTask({
      entry: agent({ task_command_template: `${cmd} {task}` }),
      task: "build the app",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.stdout).toContain("got: build the app");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("captures stderr separately", async () => {
    const cmd = makeScript(
      "stderr.sh",
      "#!/bin/sh\necho 'out' \necho 'err' >&2\n",
    );
    const result = await spawnAgentTask({
      entry: agent({ task_command_template: cmd }),
      task: "x",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.stdout).toContain("out");
      expect(result.stderr).toContain("err");
    }
  });

  it("returns failed when the agent exits non-zero", async () => {
    const cmd = makeScript(
      "fail.sh",
      "#!/bin/sh\necho 'oh no' >&2\nexit 7\n",
    );
    const result = await spawnAgentTask({
      entry: agent({ task_command_template: cmd }),
      task: "x",
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("oh no");
    }
  });

  it("times out when the agent runs longer than timeoutMs", async () => {
    const cmd = makeScript(
      "sleep.sh",
      "#!/bin/sh\nsleep 30\n",
    );
    const result = await spawnAgentTask({
      entry: agent({ task_command_template: cmd }),
      task: "x",
      timeoutMs: 200,
    });
    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.timeoutMs).toBe(200);
    }
  }, 15_000); // SIGTERM + grace + buffer; vitest default 5s is too tight.

  it("honors task_timeout_seconds from the registry entry", async () => {
    const cmd = makeScript("sleep.sh", "#!/bin/sh\nsleep 30\n");
    const result = await spawnAgentTask({
      entry: agent({
        task_command_template: cmd,
        task_timeout_seconds: 1, // 1s → trip during the script's 30s sleep
      }),
      task: "x",
    });
    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") {
      expect(result.timeoutMs).toBe(1000);
    }
  }, 15_000);

  it("streams stdout lines via onLine while also capturing the full buffer", async () => {
    const cmd = makeScript(
      "stream.sh",
      "#!/bin/sh\necho line-1\necho line-2\necho line-3\n",
    );
    const stdoutLines: string[] = [];
    const result = await spawnAgentTask({
      entry: agent({ task_command_template: cmd }),
      task: "x",
      onLine: (stream, line) => {
        if (stream === "stdout") stdoutLines.push(line);
      },
    });
    expect(result.kind).toBe("ok");
    expect(stdoutLines).toEqual(["line-1", "line-2", "line-3"]);
    if (result.kind === "ok") {
      expect(result.stdout).toContain("line-1");
      expect(result.stdout).toContain("line-3");
    }
  });

  it("returns spawn-error when the command binary is missing", async () => {
    const result = await spawnAgentTask({
      entry: agent({
        task_command_template: "/nonexistent/path/to/binary {task}",
      }),
      task: "x",
    });
    // Either spawn throws synchronously, or the child emits 'error'.
    // Both routes converge on { kind: "spawn-error" }.
    expect(result.kind).toBe("spawn-error");
  });

  it("does NOT interpret shell metachars in the task (no command injection)", async () => {
    // Task contains `;` and would form `echo got: hi; touch /tmp/pwned` under
    // a shell. With shell:false the task stays a literal arg.
    const cmd = makeScript("echo-arg.sh", "#!/bin/sh\necho \"got: $1\"\n");
    const result = await spawnAgentTask({
      entry: agent({ task_command_template: `${cmd} {task}` }),
      task: "hi; touch /tmp/foreman-pwned-test",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // The entire malicious string is captured as one arg + printed back.
      expect(result.stdout).toContain(
        "got: hi; touch /tmp/foreman-pwned-test",
      );
    }
    // And /tmp/foreman-pwned-test must NOT exist.
    expect(() =>
      require("node:fs").statSync("/tmp/foreman-pwned-test"),
    ).toThrow();
  });

  // QA round 13 bug 3 defensive: set env vars so a recursive Foreman
  // mcp-stdio (spawned by the child agent's MCP wiring) can detect
  // it's running inside a Foreman spawn and skip behavior that would
  // race with the parent's drain poller (DB lock contention).
  it("sets FOREMAN_SPAWN_DEPTH + FOREMAN_SPAWNED_BY on the child env", async () => {
    const cmd = makeScript(
      "env-dump.sh",
      "#!/bin/sh\necho \"depth=$FOREMAN_SPAWN_DEPTH by=$FOREMAN_SPAWNED_BY\"\n",
    );
    const result = await spawnAgentTask({
      entry: agent({ id: "codex", task_command_template: cmd }),
      task: "x",
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.stdout).toContain("depth=1");
      expect(result.stdout).toContain("by=codex");
    }
  });

  it("increments FOREMAN_SPAWN_DEPTH from parent process.env (visible nesting)", async () => {
    // Simulate the recursive case: process.env already has a depth value
    // (set by an outer Foreman spawn). The engine reads it, increments,
    // sets the child's env. Each layer of spawning adds 1 to the
    // visible depth in audit / debugging.
    const previous = process.env.FOREMAN_SPAWN_DEPTH;
    process.env.FOREMAN_SPAWN_DEPTH = "3";
    try {
      const cmd = makeScript(
        "env-dump.sh",
        "#!/bin/sh\necho \"depth=$FOREMAN_SPAWN_DEPTH\"\n",
      );
      const result = await spawnAgentTask({
        entry: agent({ id: "codex", task_command_template: cmd }),
        task: "x",
      });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.stdout).toContain("depth=4");
      }
    } finally {
      if (previous === undefined) delete process.env.FOREMAN_SPAWN_DEPTH;
      else process.env.FOREMAN_SPAWN_DEPTH = previous;
    }
  });
});
