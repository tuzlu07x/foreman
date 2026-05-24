import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import { FlowManager } from "../core/flow-manager.js";
import { RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { controlCommands } from "../db/schema.js";
import { dim, green, red } from "./colors.js";

// =============================================================================
// `foreman flow` — operator-facing CLI for the auto-routing system.
// =============================================================================
//
// Three subcommands cover the Phase A scope:
//   - start  → open a new flow + enqueue the root step's write directive
//   - list   → show active + recent flows (most recent first)
//   - show   → render a single flow's step tree
//
// Phase B/C will add: stop, override, watch, summary.

export const flowCommand = new Command("flow").description(
  "Manage agent-to-agent auto-routing flows.",
);

flowCommand
  .command("start")
  .description(
    "Open a new flow + enqueue the root step's write directive. The " +
      "FlowRouter will chain subsequent steps based on each agent's " +
      "handoff_rules.",
  )
  .requiredOption(
    "--agent <id>",
    "Root agent that receives the first directive (must be registered).",
  )
  .requiredOption(
    "--prompt <text>",
    "Initial task text handed to the root agent.",
  )
  .option(
    "--goal <text>",
    "Free-form goal string for the flow (shown in `foreman flow list`). Defaults to prompt.",
  )
  .option(
    "--max-steps <n>",
    "Cycle-protection ceiling. Flow halts after this many steps. Default 10.",
    "10",
  )
  .action(
    (opts: {
      agent: string;
      prompt: string;
      goal?: string;
      maxSteps: string;
    }) => {
      const db = getDb();
      const registry = new RegistryService(db, bus);
      const agent = registry.get(opts.agent);
      if (!agent) {
        console.error(red("error: ") + `Unknown agent '${opts.agent}'.`);
        closeDb();
        process.exit(1);
      }
      if (!agent.role) {
        console.error(
          red("error: ") +
            `Agent '${opts.agent}' has no role set. Run \`foreman agent role ${opts.agent} <role>\` first.`,
        );
        closeDb();
        process.exit(1);
      }
      const flows = new FlowManager(db);
      const goal = (opts.goal ?? opts.prompt).trim();
      const maxSteps = Number.parseInt(opts.maxSteps, 10) || 10;
      const { flowId, rootStepId } = flows.startFlow({
        goal,
        rootAgent: opts.agent,
        prompt: opts.prompt,
        maxSteps,
      });
      // Insert the directive with the 4-element flow-aware args shape so
      // the drain handler picks up flow context and the router fires.
      const inserted = db
        .insert(controlCommands)
        .values({
          command: "write",
          args: JSON.stringify([opts.agent, opts.prompt, flowId, rootStepId]),
          sourceAgent: "foreman:cli",
          sourceUser: null,
          status: "pending",
          createdAt: Date.now(),
        })
        .returning({ id: controlCommands.id })
        .get();
      // Best-effort: pre-mark the step as running so the directive id is
      // attached even before the drain picks it up.
      if (inserted?.id) {
        try {
          flows.markStepRunning(rootStepId, inserted.id);
        } catch {
          /* ignore */
        }
      }
      console.log(
        `${green("✓")} flow ${flowId} started — root step ${rootStepId} → ${opts.agent}`,
      );
      console.log(`  ${dim("goal")}      ${goal}`);
      console.log(`  ${dim("directive")} #${inserted?.id ?? "?"}`);
      console.log(
        `  ${dim("watch")}     foreman flow show ${flowId}`,
      );
      closeDb();
    },
  );

flowCommand
  .command("list")
  .description("List flows (most recent first).")
  .option("--active", "Only show active flows.")
  .action((opts: { active?: boolean }) => {
    const db = getDb();
    const flows = new FlowManager(db);
    const rows = opts.active ? flows.listActive() : flows.list();
    if (rows.length === 0) {
      console.log(dim("no flows"));
      closeDb();
      return;
    }
    for (const f of rows) {
      const elapsed = Math.round(
        ((f.endedAt ?? Date.now()) - f.startedAt) / 1000,
      );
      const statusColor =
        f.status === "active"
          ? green
          : f.status === "completed"
            ? dim
            : red;
      console.log(
        `${f.id}  ${statusColor(f.status.padEnd(9))}  steps=${f.stepCount}/${f.maxSteps}  ` +
          `${elapsed}s  ${dim("|")}  ${f.goal.slice(0, 60)}`,
      );
    }
    closeDb();
  });

flowCommand
  .command("preset <name>")
  .description(
    "Apply a preset role + handoff_rules configuration to registered agents. " +
      "Available presets: review-loop (codex=coder, claude-code=reviewer, " +
      "hermes=orchestrator with the canonical implement→review→fix loop).",
  )
  .action((name: string) => {
    const db = getDb();
    const registry = new RegistryService(db, bus);
    if (name !== "review-loop") {
      console.error(
        red("error: ") + `Unknown preset '${name}'. Available: review-loop.`,
      );
      closeDb();
      process.exit(1);
    }
    const presets: Array<{
      id: string;
      role: string;
      responsibility: string;
      rules: Array<{
        when: string;
        toRole: string;
        template: string;
        intent: string;
      }>;
    }> = [
      {
        id: "codex",
        role: "coder",
        responsibility:
          "Issue'ları implement eder, commit atar, push yapar. Çıktısı reviewer'a gider.",
        rules: [
          {
            when: "code_written_and_committed",
            toRole: "reviewer",
            template:
              "Aşağıdaki commit'i review et. Approve veya changes_requested ile dön:\n\n{output}",
            intent: "review",
          },
          {
            when: "code_written",
            toRole: "reviewer",
            template:
              "Aşağıdaki uncommitted çalışmayı review et. Approve veya changes_requested ile dön:\n\n{output}",
            intent: "review",
          },
          {
            when: "blocked",
            toRole: "orchestrator",
            template:
              "Codex blocker bildiriyor — kullanıcıya özet hazırla:\n\n{output}",
            intent: "summarize",
          },
        ],
      },
      {
        id: "claude-code",
        role: "reviewer",
        responsibility:
          "Codex'in çıktısını review eder. changes_requested → codex'e geri gönderir, approved → orchestrator'a final summary için verir.",
        rules: [
          {
            when: "changes_requested",
            toRole: "coder",
            template:
              "Aşağıdaki review feedback'ini uygula + tekrar commit et:\n\n{output}",
            intent: "fix",
          },
          {
            when: "approved",
            toRole: "orchestrator",
            template:
              "Review approved — kullanıcıya tek paragraflık özet hazırla:\n\n{output}",
            intent: "summarize",
          },
        ],
      },
      {
        id: "hermes",
        role: "orchestrator",
        responsibility:
          "Akışı yönetir, agentlar arası iletişimi denetler, kullanıcıya tek paragraf final özet verir.",
        rules: [],
      },
    ];
    let applied = 0;
    for (const p of presets) {
      const agent = registry.get(p.id);
      if (!agent) {
        console.log(`  ${dim("skip")} ${p.id} (not registered)`);
        continue;
      }
      registry.setRole(p.id, p.role);
      registry.setResponsibilityNote(p.id, p.responsibility);
      registry.setHandoffRules(
        p.id,
        p.rules.length > 0 ? JSON.stringify(p.rules) : null,
      );
      console.log(
        `${green("✓")} ${p.id} → role=${p.role}, ${p.rules.length} handoff rule(s)`,
      );
      applied += 1;
    }
    console.log("");
    console.log(`${dim(`Applied to ${applied}/${presets.length} agents.`)}`);
    console.log(
      `${dim("Start a flow with:")}  foreman flow start --agent codex --prompt "..."`,
    );
    closeDb();
  });

flowCommand
  .command("show <flowId>")
  .description("Show a flow's step tree with status + classifications.")
  .action((flowId: string) => {
    const db = getDb();
    const flows = new FlowManager(db);
    const flow = flows.get(flowId);
    if (!flow) {
      console.error(red("error: ") + `Flow '${flowId}' not found.`);
      closeDb();
      process.exit(1);
    }
    const elapsed = Math.round(
      ((flow.endedAt ?? Date.now()) - flow.startedAt) / 1000,
    );
    console.log(`${dim("Flow")} ${flow.id}`);
    console.log(`${dim("Goal:")}   ${flow.goal}`);
    console.log(
      `${dim("Status:")} ${flow.status} (${elapsed}s, ${flow.stepCount}/${flow.maxSteps} steps)`,
    );
    if (flow.currentHolder) {
      console.log(`${dim("Holder:")} ${flow.currentHolder}`);
    }
    if (flow.finalSummary) {
      console.log(`${dim("Final:")}  ${flow.finalSummary.slice(0, 200)}`);
    }
    console.log("");
    const steps = flows.listSteps(flowId);
    for (const s of steps) {
      const stepElapsed = Math.round(
        ((s.completedAt ?? Date.now()) - s.startedAt) / 1000,
      );
      const arrow = s.sourceAgent ? `${s.sourceAgent} → ${s.targetAgent}` : `(root) → ${s.targetAgent}`;
      const statusColor =
        s.status === "completed"
          ? green
          : s.status === "failed"
            ? red
            : dim;
      console.log(
        `  #${s.stepOrder}  ${arrow}  ${dim("[")}intent=${s.intent}${dim("]")}  ${statusColor(s.status)}  ${stepElapsed}s`,
      );
      if (s.outputClassification) {
        console.log(`      ${dim("→")} class: ${s.outputClassification}`);
      }
      if (s.outputSummary) {
        const oneLine = s.outputSummary.replace(/\s+/g, " ").trim().slice(0, 120);
        console.log(`      ${dim("→")} ${oneLine}`);
      }
    }
    closeDb();
  });
