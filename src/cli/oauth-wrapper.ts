import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { bus } from "../core/event-bus.js";
import {
  loadActiveRegistry,
  type AgentEntry,
} from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";

// =============================================================================
// OAuth wrappers (#408 / #413 — Phase 5)
// =============================================================================
//
// Generic runner that:
//   1. Looks up an agent's `provider_mapping[provider].variants[variant]`
//   2. Spawns the variant's `interactive_setup` command (e.g. `codex login`)
//      with stdio inherited so the user sees the OAuth flow + can interact
//   3. After the command exits, polls `post_setup_verify` (e.g.
//      `codex auth status`) with exponential backoff until success or
//      a 5-minute timeout
//   4. Persists the active variant in `agents` so doctor + provider list
//      reflect the OAuth-complete state
//
// Each agent that supports OAuth gets a thin subcommand wrapper —
// `foreman codex-login`, `foreman anthropic-login` — that calls into the
// generic runner with the appropriate agent id baked in.

export interface OAuthWrapperOptions {
  /** Override the timeout (ms) for the verify-polling loop. */
  verifyTimeoutMs?: number;
  /** Override interval start for backoff (ms). Test hook. */
  verifyInitialIntervalMs?: number;
  /** Inject a custom log sink. */
  log?: (line: string) => void;
}

export interface OAuthWrapperResult {
  ok: boolean;
  /** Error / status message when ok=false. */
  reason?: string;
  /** Did the variant get persisted to the agent's record? */
  persisted?: boolean;
}

/**
 * Run the OAuth flow for an agent's variant, then verify + persist.
 * Caller picks the agent id + foreman provider; we resolve the variant
 * from the registry's `provider_mapping`.
 */
export async function runOAuthWrapper(
  agentId: string,
  foremanProvider: string,
  variantOverride: string | undefined,
  opts: OAuthWrapperOptions = {},
): Promise<OAuthWrapperResult> {
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 5 * 60 * 1000;
  const initialIntervalMs = opts.verifyInitialIntervalMs ?? 1000;

  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    return {
      ok: false,
      reason: `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`,
    };
  }

  const registryDoc = loadActiveRegistry();
  const entry = registryDoc.doc.agents.find((a: AgentEntry) => a.id === agentId);
  if (!entry) {
    return { ok: false, reason: `agent ${agentId} not in registry` };
  }
  if (!entry.provider_mapping) {
    return {
      ok: false,
      reason: `agent ${agentId} has no provider_mapping declared`,
    };
  }
  const providerMapping = entry.provider_mapping[foremanProvider];
  if (!providerMapping) {
    const available = Object.keys(entry.provider_mapping).join(", ");
    return {
      ok: false,
      reason: `agent ${agentId} doesn't support ${foremanProvider} (available: ${available})`,
    };
  }
  const variantId = variantOverride ?? providerMapping.preferred;
  const variant = providerMapping.variants[variantId];
  if (!variant) {
    return {
      ok: false,
      reason: `variant ${variantId} not found in ${foremanProvider} mapping`,
    };
  }
  if (!variant.interactive_setup) {
    return {
      ok: false,
      reason: `variant ${foremanProvider}/${variantId} has no interactive_setup — nothing to wrap. Use 'foreman provider switch' for API-key flows.`,
    };
  }

  log(dim(`▸ Running \`${variant.interactive_setup}\` …`));
  log(
    dim(
      `  (${entry.name} will likely open a browser. Complete the OAuth flow there.)`,
    ),
  );

  const flowOk = await runInteractive(variant.interactive_setup, log);
  if (!flowOk) {
    return { ok: false, reason: "interactive setup command exited non-zero" };
  }

  if (variant.post_setup_verify) {
    log(dim("▸ Waiting for OAuth completion…"));
    const verified = await pollVerify(
      variant.post_setup_verify,
      verifyTimeoutMs,
      initialIntervalMs,
      log,
    );
    if (!verified) {
      return {
        ok: false,
        reason: `OAuth verify (\`${variant.post_setup_verify}\`) didn't succeed within ${Math.round(verifyTimeoutMs / 1000)}s`,
      };
    }
  }

  // Persist the variant to agents table so doctor + `foreman provider
  // list` reflect the OAuth-complete state.
  let persisted = false;
  try {
    const db = getDb();
    const registry = new RegistryService(db, bus);
    if (registry.get(agentId)) {
      registry.setLlmProvider(agentId, foremanProvider);
      registry.setProviderVariant(agentId, variantId);
      persisted = true;
    }
    closeDb();
  } catch {
    /* persistence is best-effort — OAuth itself succeeded */
  }

  log(
    green("✓ ") +
      `${entry.name} authenticated via ${foremanProvider}/${variantId}`,
  );
  if (persisted) {
    log(green("✓ ") + "marked active variant in agents table");
  }
  return { ok: true, persisted };
}

// =============================================================================
// Internals
// =============================================================================

function runInteractive(
  command: string,
  log: (line: string) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      log(red(`✗ failed to spawn: ${err.message}`));
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

async function pollVerify(
  command: string,
  timeoutMs: number,
  initialIntervalMs: number,
  log: (line: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let interval = initialIntervalMs;
  const maxInterval = 30_000;
  while (Date.now() < deadline) {
    const result = await runQuiet(command);
    if (result === 0) return true;
    await sleep(Math.min(interval, deadline - Date.now()));
    interval = Math.min(interval * 2, maxInterval);
  }
  log(
    orange(
      `  verify timed out after ${Math.round(timeoutMs / 1000)}s — try '${command}' manually`,
    ),
  );
  return false;
}

function runQuiet(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

// =============================================================================
// Per-agent subcommands
// =============================================================================
//
// Each agent that ships OAuth-capable variants gets a thin command alias.
// All delegate to `runOAuthWrapper` — Foreman code stays single-path.

export const codexLoginCommand = new Command("codex-login")
  .description(
    "Run Codex's OAuth flow and persist the result for Foreman (#408 phase 5)",
  )
  .option(
    "--variant <id>",
    "specific variant to authenticate (defaults to the agent's preferred OAuth variant)",
    "oauth",
  )
  .action(async (options: { variant?: string }) => {
    const result = await runOAuthWrapper("codex", "openai", options.variant);
    if (!result.ok) {
      process.stderr.write(red("✗ ") + (result.reason ?? "unknown error") + "\n");
      process.exit(1);
    }
    process.exit(0);
  });

export const claudeLoginCommand = new Command("claude-login")
  .description(
    "Run Claude Code's OAuth flow and persist the result for Foreman (#408 phase 5)",
  )
  .option(
    "--variant <id>",
    "specific variant (defaults to 'oauth')",
    "oauth",
  )
  .action(async (options: { variant?: string }) => {
    const result = await runOAuthWrapper(
      "claude-code",
      "anthropic",
      options.variant,
    );
    if (!result.ok) {
      process.stderr.write(red("✗ ") + (result.reason ?? "unknown error") + "\n");
      process.exit(1);
    }
    process.exit(0);
  });
