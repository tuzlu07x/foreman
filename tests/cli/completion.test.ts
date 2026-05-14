import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  buildCompletionTree,
  renderCompletion,
} from "../../src/cli/completion.js";

function makeProgram(): Command {
  // Compact stand-in for the real foreman program — enough subcommands +
  // flags to exercise each renderer without snapshotting the whole CLI
  // (which churns whenever we add a new flag elsewhere).
  const program = new Command("foreman").description("the gateway");
  const initCmd = new Command("init").description("Initialise the home dir");
  initCmd.option("--reset-policy", "overwrite policy.yaml");
  program.addCommand(initCmd);

  const agentCmd = new Command("agent")
    .alias("agents")
    .description("Agent commands");
  agentCmd.addCommand(new Command("list").description("List agents"));
  agentCmd.addCommand(new Command("remove").description("Remove an agent"));
  agentCmd.addCommand(new Command("show").description("Show one agent"));
  program.addCommand(agentCmd);

  program.addCommand(
    new Command("doctor").description("Diagnose the environment"),
  );
  return program;
}

describe("buildCompletionTree", () => {
  it("walks subcommands recursively and surfaces flags + descriptions", () => {
    const tree = buildCompletionTree(makeProgram());
    expect(tree.name).toBe("foreman");
    const subNames = tree.subcommands.map((s) => s.name).sort();
    expect(subNames).toEqual(["agent", "doctor", "init"]);
    const init = tree.subcommands.find((s) => s.name === "init")!;
    expect(init.flags).toContain("--reset-policy");
    expect(init.flags).toContain("--help");
    const agent = tree.subcommands.find((s) => s.name === "agent")!;
    expect(agent.aliases).toEqual(["agents"]);
    const agentSubs = agent.subcommands.map((s) => s.name).sort();
    expect(agentSubs).toEqual(["list", "remove", "show"]);
  });

  it("filters out the built-in `help` subcommand", () => {
    const tree = buildCompletionTree(makeProgram());
    expect(tree.subcommands.find((s) => s.name === "help")).toBeUndefined();
  });
});

describe("renderCompletion — bash", () => {
  it("includes top-level subcommands in the first-arg completion list", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "bash");
    expect(out).toContain("init");
    expect(out).toContain("agent");
    expect(out).toContain("doctor");
    expect(out).toContain("complete -F _foreman_complete foreman");
  });

  it("threads aliases into the top-level word list", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "bash");
    expect(out).toContain("agents");
  });

  it("is syntactically valid under `bash -n`", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "bash");
    const tmp = mkdtempSync(join(tmpdir(), "foreman-comp-"));
    const path = join(tmp, "foreman.bash");
    try {
      writeFileSync(path, out);
      const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`bash -n failed: ${result.stderr}`);
      }
      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("renderCompletion — zsh", () => {
  it("opens with #compdef and lists every subcommand", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "zsh");
    expect(out.startsWith("#compdef foreman")).toBe(true);
    expect(out).toContain("'init:");
    expect(out).toContain("'agent:");
    expect(out).toContain("'doctor:");
  });

  it("emits a nested case arm for subcommands that have sub-subcommands", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "zsh");
    expect(out).toContain("agent subcommands");
    expect(out).toContain("'list:");
    expect(out).toContain("'remove:");
  });

  it("is syntactically valid under `zsh -n` (when zsh is available)", () => {
    let zsh = false;
    try {
      execFileSync("zsh", ["--version"], { stdio: "ignore", timeout: 1000 });
      zsh = true;
    } catch {
      // zsh missing on the host — skip.
    }
    if (!zsh) return;

    const out = renderCompletion(buildCompletionTree(makeProgram()), "zsh");
    const tmp = mkdtempSync(join(tmpdir(), "foreman-comp-"));
    const path = join(tmp, "_foreman");
    try {
      writeFileSync(path, out);
      const result = spawnSync("zsh", ["-n", path], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`zsh -n failed: ${result.stderr}`);
      }
      expect(result.status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("renderCompletion — fish", () => {
  it("declares the no-subcommand guard and registers each top-level subcommand", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "fish");
    expect(out).toContain("function __foreman_no_subcommand");
    expect(out).toContain("-a 'init'");
    expect(out).toContain("-a 'agent'");
    expect(out).toContain("-a 'doctor'");
  });

  it("registers nested subcommands behind __fish_seen_subcommand_from", () => {
    const out = renderCompletion(buildCompletionTree(makeProgram()), "fish");
    expect(out).toContain("__fish_seen_subcommand_from agent");
    expect(out).toContain("-a 'list'");
  });
});
