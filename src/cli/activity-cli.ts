import { existsSync } from "node:fs";
import { Command } from "commander";
import {
  buildAgentActivityDigest,
  type AgentActivityDigest,
} from "../core/agent-activity-summary.js";
import { buildActivityPrompt } from "../core/agent-activity-prompt.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { parseSince } from "../core/llm/budget.js";
import {
  defaultLlmConfig,
  loadLlmConfig,
  isFeatureEnabled,
} from "../core/llm/config.js";
import { buildLlmClient } from "../core/llm/factory.js";
import { recordUsageAndCheckBudget } from "../core/llm/budget.js";
import { RegistryService } from "../core/registry.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { red } from "./colors.js";

// =============================================================================
// `foreman report` — surface the digest #435 generates
// =============================================================================
//
// Two output modes:
//   - default / `--json`: stringified digest for debugging + scripting
//   - `--narrate`: pipes the digest through Foreman's own LLM and
//     prints a 1-3 paragraph human narration. Same budget guardrails
//     + feature gate as `/foreman report me` (#432).
//
// #498 — Previously named `foreman activity` but collided with the
// chat-side `/foreman activity` (the control_commands ledger) which
// means a completely different thing. Renamed to `foreman report` to
// match chat-side semantics (`/foreman report me` is the LLM digest).
// `foreman activity` kept as a deprecated alias for one release so
// existing scripts don't break overnight.

export const reportCommand = new Command("report")
  .alias("activity")
  .description("LLM-narrated digest of recent agent activity (#435)")
  .option(
    "--since <Nd|Nh|Nm>",
    "Window length (e.g. 1h, 30m, 24h). Default 1h.",
    "1h",
  )
  .option("--agent <id>", "Limit to one agent (source OR target match)")
  .option("--narrate", "Run the digest through Foreman LLM + print prose")
  .option("--json", "Force JSON output (default when --narrate isn't set)")
  .action(
    async (options: {
      since: string;
      agent?: string;
      narrate?: boolean;
      json?: boolean;
    }) => {
      const exit = await runReport(options);
      process.exit(exit);
    },
  );

export async function runReport(options: {
  since?: string;
  agent?: string;
  narrate?: boolean;
  json?: boolean;
}): Promise<0 | 1 | 2> {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") +
        `Foreman is not initialised at ${paths.root}. Run \`foreman init\` first.`,
    );
    return 1;
  }
  const sinceArg = options.since ?? "1h";
  let windowMs: number;
  try {
    windowMs = parseSince(sinceArg);
  } catch (err) {
    console.error(
      red("error: ") +
        `--since ${sinceArg}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
  const windowMinutes = Math.max(1, Math.round(windowMs / 60_000));

  const db = getDb();
  try {
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    const digest = buildAgentActivityDigest(db, registry, {
      windowMinutes,
      ...(options.agent ? { agentId: options.agent } : {}),
    });

    if (!options.narrate) {
      // JSON is the default when --narrate isn't set. --json explicit
      // is the same path (kept for symmetry with other Foreman CLIs).
      console.log(JSON.stringify(digest, null, 2));
      return 0;
    }

    return await narrate(digest, paths.llmConfigPath);
  } finally {
    closeDb();
  }
}

async function narrate(
  digest: AgentActivityDigest,
  llmConfigPath: string,
): Promise<0 | 1 | 2> {
  const config = existsSync(llmConfigPath)
    ? loadLlmConfig(llmConfigPath)
    : defaultLlmConfig();
  if (!config.enabled) {
    console.error(
      red("error: ") +
        "Foreman LLM is disabled. Enable + configure it via the wizard or `foreman llm enable`.",
    );
    return 1;
  }
  // `orchestrator_chat` is the same feature flag `/foreman report me`
  // uses (#432). Reusing the toggle keeps the user opt-in surface
  // consistent — one flag for every LLM-narrate path.
  if (!isFeatureEnabled(config, "orchestrator_chat")) {
    console.error(
      red("error: ") +
        "`orchestrator_chat` feature flag is off. Enable it in llm.yaml under `features:`.",
    );
    return 1;
  }
  const db = getDb();
  const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
  let client;
  try {
    client = buildLlmClient(config, secretStore);
  } catch (err) {
    console.error(
      red("error: ") + (err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }
  const prompt = buildActivityPrompt({ digest });
  try {
    const resp = await client.call(prompt, {
      feature: "orchestrator_chat",
      maxTokens: 350,
      temperature: 0.3,
    });
    recordUsageAndCheckBudget(db, config, {
      provider: client.providerId,
      model: client.model,
      feature: "orchestrator_chat",
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      costUsd: resp.costUsd,
      durationMs: resp.durationMs,
      cacheHit: resp.cacheHit,
    });
    const text = resp.text.trim();
    if (text.length === 0) {
      console.error(red("error: ") + "LLM returned an empty response.");
      return 1;
    }
    console.log(text);
    return 0;
  } catch (err) {
    console.error(
      red("error: ") + (err instanceof Error ? err.message : String(err)),
    );
    return 1;
  }
}
