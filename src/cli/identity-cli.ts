import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { loadActiveRegistry } from "../core/registry-catalog.js";
import { applyForemanSoul } from "../core/foreman-soul.js";
import { RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { launchEditor } from "../tui/launch-editor.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";
import { DEFAULT_FOREMAN_SOUL } from "./identity-template.js";
import { requireConfirm, requireTty } from "./require-confirm.js";

export const identityCommand = new Command("identity").description(
  "Foreman's user-facing persona (show / edit / reset / push)",
);

identityCommand
  .command("show")
  .description("Print the Foreman SOUL.md that gets propagated to agents")
  .action(() => {
    const paths = getForemanPaths();
    if (!existsSync(paths.configDir)) {
      console.error(
        red("error: ") + "Foreman is not initialised. Run 'foreman init' first.",
      );
      process.exit(1);
    }
    const text = existsSync(paths.soulPath)
      ? readFileSync(paths.soulPath, "utf-8")
      : DEFAULT_FOREMAN_SOUL;
    process.stdout.write(text);
    if (!text.endsWith("\n")) process.stdout.write("\n");
  });

identityCommand
  .command("edit")
  .description(
    "Open SOUL.md in $EDITOR and propagate the result to every registered agent",
  )
  .action(async () => {
    const paths = getForemanPaths();
    if (!existsSync(paths.configDir)) {
      console.error(
        red("error: ") + "Foreman is not initialised. Run 'foreman init' first.",
      );
      process.exit(1);
    }
    requireTty({ command: "identity edit", fallbackPath: paths.soulPath });
    if (!existsSync(paths.soulPath)) {
      writeFileSync(paths.soulPath, DEFAULT_FOREMAN_SOUL);
    }
    await launchEditor(paths.soulPath);
    pushToAgents(paths.soulPath);
  });

identityCommand
  .command("reset")
  .description("Overwrite SOUL.md with the default Foreman identity template")
  .option("--yes", "skip the confirmation prompt")
  .action(async (options: { yes?: boolean }) => {
    const paths = getForemanPaths();
    const ok = await requireConfirm({
      yes: options.yes,
      question: `Overwrite ${paths.soulPath} with the default Foreman identity?`,
      noun: "reset SOUL.md",
    });
    if (!ok) {
      console.log("(cancelled)");
      return;
    }
    writeFileSync(paths.soulPath, DEFAULT_FOREMAN_SOUL);
    console.log(`${green("✓")} ${paths.soulPath} ${dim("reset to template")}`);
    pushToAgents(paths.soulPath);
  });

identityCommand
  .command("push")
  .description(
    "Re-propagate the current SOUL.md to every registered agent (idempotent)",
  )
  .action(() => {
    const paths = getForemanPaths();
    if (!existsSync(paths.soulPath)) {
      writeFileSync(paths.soulPath, DEFAULT_FOREMAN_SOUL);
      console.log(`${green("✓")} seeded ${paths.soulPath} ${dim("(template)")}`);
    }
    pushToAgents(paths.soulPath);
  });

function pushToAgents(soulPath: string): void {
  const db = getDb();
  try {
    const registry = new RegistryService(db);
    const { doc } = loadActiveRegistry();
    const registered = registry.list();
    let wrote = 0;
    let alreadyCurrent = 0;
    let skipped = 0;
    for (const agent of registered) {
      const registryId =
        typeof agent.metadata?.registryId === "string"
          ? agent.metadata.registryId
          : null;
      const entry = registryId
        ? doc.agents.find((a) => a.id === registryId) ?? null
        : null;
      if (!entry || !entry.identity_path) {
        skipped += 1;
        continue;
      }
      try {
        // QA round 13: forward registry context so the multi-agent
        // SOUL.md gets responsibility + peer info, not the generic
        // fallback. registry.list() is already loaded above.
        const peers = registered
          .filter((a) => a.id !== agent.id)
          .map((a) => ({
            id: a.id,
            displayName: a.displayName,
            responsibilityNote: a.responsibilityNote,
          }));
        const result = applyForemanSoul({
          entry,
          soulPath,
          responsibilityNote: agent.responsibilityNote,
          peers,
        });
        if (result?.changed) {
          console.log(`  ${green("✓")} ${entry.name} ${dim(result.path)}`);
          wrote += 1;
        } else if (result) {
          console.log(`  ${dim("·")} ${entry.name} ${dim("(already current)")}`);
          alreadyCurrent += 1;
        }
      } catch (err) {
        console.log(
          `  ${orange("⚠")} ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    console.log(
      dim(
        `${wrote} written, ${alreadyCurrent} already current, ${skipped} agent(s) without an identity_path`,
      ),
    );
  } finally {
    closeDb();
  }
}

