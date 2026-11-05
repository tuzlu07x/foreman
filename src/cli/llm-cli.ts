import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "commander";
import {
  defaultLlmConfig,
  isFeatureEnabled,
  loadLlmConfig,
  ProviderIdSchema,
  saveLlmConfig,
  setAuthMode,
  type AuthModeProviderId,
  type LlmConfig,
  type LlmFeature,
  type ProviderId,
} from "../core/llm/config.js";
import { deriveDefaultModelId } from "../core/provider-resolver.js";

export { setAuthMode };
import {
  buildLlmClient,
  LlmCredentialMissingError,
  LlmProviderUnavailableError,
} from "../core/llm/factory.js";
import {
  featureSplit,
  getBudgetStatus,
  listProjectCosts,
  listSessionCosts,
  parseSince,
  queryUsage,
  recordUsage,
} from "../core/llm/budget.js";
import {
  type OAuthTokens,
} from "../core/llm/oauth/oauth-flow.js";
import { revokeChatgptSession, signInWithChatgpt } from "../core/llm/oauth/chatgpt-signin.js";
import {
  CHATGPT_USAGE_URL,
  getOAuthProvider,
  isOAuthProviderId,
  type OAuthProviderConfig,
  type OAuthProviderId,
} from "../core/llm/oauth/oauth-providers.js";
import {
  clearOAuthTokens,
  loadOAuthTokens,
  removeLegacyClaudeTokens,
  saveOAuthTokens,
} from "../core/llm/oauth/token-store.js";
import {
  CLAUDE_LOGIN_COMMAND,
  ClaudeCodeLlmClient,
  ClaudeCodeNotReadyError,
} from "../core/llm/providers/claude-code.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { WIN32_URL_HANDLER } from "../utils/browser-open.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";
import { safeLoadConfig } from "./safe-load.js";

export const llmCommand = new Command("llm").description(
  "Optional LLM-backed verification + smart-report features (opt-in)",
);

// ============================================================================
// status
// ============================================================================

llmCommand
  .command("status")
  .description("Show current LLM config, budget, and per-feature flags")
  .action(() => {
    requireInitialised();
    const paths = getForemanPaths();
    const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig, {
      label: "llm.yaml",
    });
    const db = getDb();
    const budget = getBudgetStatus(db, config);

    console.log(orange("Foreman LLM features"));
    console.log("");
    const globalState = config.enabled ? green("✓ enabled") : dim("○ disabled");
    console.log(`  global              ${globalState}`);
    console.log(
      `  provider            ${config.provider} (${dim(config.model)})`,
    );

    const daysUntilReset = Math.max(
      0,
      Math.ceil((budget.windowEnd - Date.now()) / 86_400_000),
    );
    console.log(
      `  budget              \$${budget.spentUsd.toFixed(2)} / \$${budget.capUsd.toFixed(2)} (${budget.spentPct.toFixed(0)}%) — resets in ${daysUntilReset} day${daysUntilReset === 1 ? "" : "s"}`,
    );
    if (budget.alertTripped && budget.spentUsd < budget.capUsd) {
      console.log(
        `  ${orange("!")} budget alert tripped — ${budget.spentPct.toFixed(0)}% of cap used`,
      );
    }
    if (budget.spentUsd >= budget.capUsd) {
      console.log(
        `  ${red("✗")} budget exceeded — LLM features will refuse calls`,
      );
    }

    console.log("");
    console.log(`  Auth:`);
    const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
    for (const pid of ["anthropic", "openai"] as const) {
      console.log(
        `    ${pid.padEnd(20)} ${describeAuthMode(config, store, pid)}`,
      );
    }

    console.log("");
    console.log(`  Features:`);
    for (const feature of [
      "verification",
      "smart_report",
      "policy_suggestions",
    ] as const) {
      const flag = config.features[feature] ? green("✓ on") : dim("off");
      const effectively = isFeatureEnabled(config, feature);
      const note =
        config.features[feature] && !effectively
          ? dim(" (overridden — global off)")
          : "";
      console.log(`    ${feature.padEnd(20)} ${flag}${note}`);
    }
    closeDb();
  });

// ============================================================================
// enable / disable
// ============================================================================

llmCommand
  .command("enable [feature]")
  .description(
    "Turn on the global switch (no arg), or enable a specific feature (verification / smart_report / policy_suggestions / orchestrator_chat)",
  )
  .action((feature: string | undefined) => {
    requireInitialised();
    const paths = getForemanPaths();
    const config = existsSync(paths.llmConfigPath)
      ? safeLoadConfig(paths.llmConfigPath, loadLlmConfig, {
          label: "llm.yaml",
        })
      : defaultLlmConfig();
    if (!feature) {
      config.enabled = true;
      saveLlmConfig(paths.llmConfigPath, config);
      console.log(`${green("✓")} LLM global switch enabled`);
      if (!hasAnyFeatureOn(config)) {
        console.log(
          dim(
            "  → no individual features are on yet — try `foreman llm enable verification`",
          ),
        );
      }
      return;
    }
    if (!isKnownFeature(feature)) {
      console.error(
        red("error: ") +
          `unknown feature: ${feature} — try ${KNOWN_FEATURES.join(" / ")}`,
      );
      process.exit(1);
    }
    config.features[feature] = true;
    saveLlmConfig(paths.llmConfigPath, config);
    console.log(`${green("✓")} ${feature} enabled`);
    if (!config.enabled) {
      console.log(
        dim(
          "  → global switch is still OFF — `foreman llm enable` (no arg) to turn it on",
        ),
      );
    }
  });

llmCommand
  .command("disable [feature]")
  .description(
    "Turn off the global switch (no arg), or disable a specific feature",
  )
  .action((feature: string | undefined) => {
    requireInitialised();
    const paths = getForemanPaths();
    if (!existsSync(paths.llmConfigPath)) {
      console.log(dim("(no llm.yaml — already disabled)"));
      return;
    }
    const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig, {
      label: "llm.yaml",
    });
    if (!feature) {
      config.enabled = false;
      saveLlmConfig(paths.llmConfigPath, config);
      console.log(`${green("✓")} LLM global switch disabled`);
      return;
    }
    if (!isKnownFeature(feature)) {
      console.error(red("error: ") + `unknown feature: ${feature}`);
      process.exit(1);
    }
    config.features[feature] = false;
    saveLlmConfig(paths.llmConfigPath, config);
    console.log(`${green("✓")} ${feature} disabled`);
  });

// ============================================================================
// test — one-shot ping the configured provider
// ============================================================================

llmCommand
  .command("test")
  .description(
    "Send a test prompt to the configured provider (uses cheapest call)",
  )
  .action(async () => {
    requireInitialised();
    const paths = getForemanPaths();
    const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig, {
      label: "llm.yaml",
    });
    const db = getDb();
    let client;
    try {
      const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
      client = buildLlmClient(config, store);
    } catch (err) {
      if (err instanceof LlmProviderUnavailableError) {
        console.error(red("error: ") + err.message);
        closeDb();
        process.exit(2);
      }
      if (err instanceof LlmCredentialMissingError) {
        console.error(red("error: ") + err.message);
        closeDb();
        process.exit(1);
      }
      throw err;
    }
    try {
      const res = await client.ping();
      recordUsage(db, {
        provider: config.provider,
        model: client.model,
        feature: "test",
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        costUsd: res.costUsd,
        durationMs: res.durationMs,
      });
      console.log(
        `${green("✓")} ${config.provider} responded in ${res.durationMs}ms`,
      );
      console.log(`  ${dim("reply")}      ${res.text.trim().slice(0, 80)}`);
      console.log(
        `  ${dim("tokens")}     in=${res.inputTokens} out=${res.outputTokens}`,
      );
      console.log(`  ${dim("cost")}       \$${res.costUsd.toFixed(6)}`);
    } catch (err) {
      console.error(
        red("error: ") +
          `LLM test failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// ============================================================================
// login / logout — a subscription (ChatGPT sign-in, or Claude Code for Claude)
// ============================================================================

llmCommand
  .command("login <provider>")
  .description(
    "Connect your subscription: openai signs in with ChatGPT, anthropic uses Claude Code",
  )
  .option(
    "--headless",
    "Skip the loopback callback server; instead show the URL and prompt for " +
      "the redirect URL/code you paste back. Use on SSH / remote shells where " +
      "the browser can't reach the Foreman host's localhost.",
    false,
  )
  .action(async (providerArg: string, opts: { headless: boolean }) => {
    requireInitialised();
    const paths = getForemanPaths();
    if (providerArg === "anthropic") {
      try {
        await connectClaudeCode(paths.llmConfigPath);
      } catch (err) {
        console.error(
          red("error: ") + (err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
      console.log("");
      console.log(green("✓ Connected to Claude Code"));
      console.log(
        `  ${dim("auth_mode")}  credentials.anthropic → claude_code (saved to llm.yaml)`,
      );
      console.log(
        `  ${dim("next")}       foreman llm enable, if the brain is still off`,
      );
      const brain = loadLlmConfig(paths.llmConfigPath).provider;
      if (brain !== "anthropic") {
        console.log(`  ${dim("switch")}     foreman llm use anthropic (the brain runs on ${brain} now)`);
      }
      return;
    }
    if (!isOAuthProviderId(providerArg)) {
      console.error(
        red("error: ") +
          `Unknown provider '${providerArg}'. Use: anthropic | openai`,
      );
      process.exit(2);
    }
    const provider = getOAuthProvider(providerArg);
    const db = getDb();
    try {
      const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
      console.log(orange(`Foreman — sign in to ${provider.label}`));
      console.log("");
      const result = await performOAuthLogin(
        provider,
        { headless: opts.headless },
        { llmConfigPath: paths.llmConfigPath },
        store,
        defaultLoginDeps(),
      );
      console.log("");
      const brain = loadLlmConfig(paths.llmConfigPath).provider;
      const inUse = brain === provider.id;
      console.log(green(inUse ? "✓ You're using your ChatGPT plan" : "✓ Signed in to ChatGPT"));
      if (result.email) console.log(`  ${dim("account")}    ${result.email}`);
      if (inUse) {
        console.log("  Foreman's AI requests use your plan, separately from anything else you pay for.");
      } else {
        console.log(`  Foreman's brain still runs on ${brain}, so your plan isn't in use yet.`);
        console.log(`  ${dim("switch")}     foreman llm use ${provider.id}`);
      }
      console.log(`  ${dim("manage")}     ${CHATGPT_USAGE_URL}`);
      console.log(`  ${dim("auth_mode")}  credentials.${provider.id} → oauth (saved to llm.yaml)`);
    } catch (err) {
      console.error(
        red("error: ") +
          `Login failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    } finally {
      closeDb();
    }
  });

llmCommand
  .command("logout <provider>")
  .description(
    "Disconnect a subscription and revert that provider to API-key auth_mode",
  )
  .action(async (providerArg: string) => {
    requireInitialised();
    if (providerArg !== "anthropic" && !isOAuthProviderId(providerArg)) {
      console.error(
        red("error: ") +
          `Unknown provider '${providerArg}'. Use: anthropic | openai`,
      );
      process.exit(2);
    }
    const paths = getForemanPaths();
    const db = getDb();
    try {
      const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
      if (providerArg === "anthropic") {
        removeLegacyClaudeTokens(store);
        saveAuthMode(paths.llmConfigPath, "anthropic", "api_key");
        console.log(
          `${green("✓")} anthropic: auth_mode → api_key. Claude Code's own sign-in is unchanged.`,
        );
        return;
      }
      const tokens = loadOAuthTokens(store, providerArg);
      const revoked = tokens ? await revokeChatgptSession(tokens) : false;
      performOAuthLogout(
        providerArg,
        { llmConfigPath: paths.llmConfigPath },
        store,
      );
      console.log(
        tokens
          ? `${green("✓")} Signed out (${providerArg}: tokens cleared, auth_mode → api_key)`
          : `${dim("○")} ${providerArg} was already signed out (auth_mode → api_key)`,
      );
      if (tokens && !revoked) {
        console.log(
          orange("note: ") +
            "OpenAI didn't confirm the sign-out. You can disconnect Foreman in ChatGPT Settings.",
        );
      }
    } finally {
      closeDb();
    }
  });

// ============================================================================
// budget — set + status
// ============================================================================

llmCommand
  .command("use <provider> [model]")
  .description("Run Foreman's brain on this provider, with its default model unless you name one")
  .action((providerArg: string, modelArg?: string) => {
    requireInitialised();
    const provider = ProviderIdSchema.safeParse(providerArg);
    if (!provider.success) {
      console.error(
        red("error: ") +
          `Unknown provider '${providerArg}'. Use: ${ProviderIdSchema.options.join(" | ")}`,
      );
      process.exit(2);
    }
    try {
      const { provider: id, model } = switchBrain(getForemanPaths().llmConfigPath, provider.data, modelArg);
      console.log(`${green("✓")} Foreman's brain now runs on ${id}`);
      console.log(`  ${dim("model")}      ${model}`);
      console.log(`  ${dim("next")}       foreman llm test`);
    } catch (err) {
      console.error(red("error: ") + (err instanceof Error ? err.message : String(err)));
      process.exit(2);
    }
  });

llmCommand
  .command("budget")
  .description("View or change the monthly LLM budget")
  .option("--set <usd>", "Set the monthly cap in USD", (v) => Number(v))
  .option("--alert <pct>", "Set the % at which to fire a budget alert", (v) =>
    parseInt(v, 10),
  )
  .option("--reset-day <n>", "Day of month the budget resets (1-28)", (v) =>
    parseInt(v, 10),
  )
  .option(
    "--status",
    "Print detailed budget status (default if no other option)",
    false,
  )
  .action(
    (options: {
      set?: number;
      alert?: number;
      resetDay?: number;
      status?: boolean;
    }) => {
      requireInitialised();
      const paths = getForemanPaths();
      const config = existsSync(paths.llmConfigPath)
        ? safeLoadConfig(paths.llmConfigPath, loadLlmConfig, {
            label: "llm.yaml",
          })
        : defaultLlmConfig();

      let changed = false;
      if (options.set !== undefined) {
        if (!Number.isFinite(options.set) || options.set <= 0) {
          console.error(red("error: ") + `--set must be a positive USD amount`);
          process.exit(1);
        }
        config.budget.monthly_cap_usd = options.set;
        changed = true;
      }
      if (options.alert !== undefined) {
        if (
          !Number.isInteger(options.alert) ||
          options.alert < 0 ||
          options.alert > 100
        ) {
          console.error(red("error: ") + `--alert must be an integer 0-100`);
          process.exit(1);
        }
        config.budget.alert_threshold_pct = options.alert;
        changed = true;
      }
      if (options.resetDay !== undefined) {
        if (
          !Number.isInteger(options.resetDay) ||
          options.resetDay < 1 ||
          options.resetDay > 28
        ) {
          console.error(red("error: ") + `--reset-day must be 1-28`);
          process.exit(1);
        }
        config.budget.reset_day_of_month = options.resetDay;
        changed = true;
      }

      if (changed) {
        saveLlmConfig(paths.llmConfigPath, config);
        console.log(`${green("✓")} budget config saved`);
      }

      const db = getDb();
      const status = getBudgetStatus(db, config);
      const split = featureSplit(db, config);
      const monthLabel = new Date(status.windowStart).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      });
      console.log("");
      console.log(orange(`Budget — ${monthLabel}`));
      console.log("");
      console.log(`  cap            \$${status.capUsd.toFixed(2)}`);
      const exhausted = status.spentUsd >= status.capUsd;
      const tripped = status.alertTripped && !exhausted ? orange(" ⚠") : "";
      const exhaustedTag = exhausted ? red(" ✗ exhausted") : "";
      console.log(
        `  spent          \$${status.spentUsd.toFixed(4)}  (${status.spentPct.toFixed(0)}%)${tripped}${exhaustedTag}`,
      );
      console.log(`  remaining      \$${status.remainingUsd.toFixed(4)}`);
      const daysUntilReset = Math.max(
        0,
        Math.ceil((status.windowEnd - Date.now()) / 86_400_000),
      );
      const endLabel = new Date(status.windowEnd).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      console.log(
        `  resets         in ${daysUntilReset} day${daysUntilReset === 1 ? "" : "s"}  (${endLabel})`,
      );
      console.log(
        `  alert at       \$${((config.budget.alert_threshold_pct / 100) * status.capUsd).toFixed(2)} (${config.budget.alert_threshold_pct}%)`,
      );
      if (split.length > 0) {
        const splitLine = split
          .map((s) => `${s.feature} \$${s.spentUsd.toFixed(2)}`)
          .join(" · ");
        console.log(`  feature split  ${splitLine}`);
      }
      console.log("");
      console.log(`  ${renderBar(status.spentPct)}`);
      closeDb();
    },
  );

// ============================================================================
// usage — recent calls
// ============================================================================

llmCommand
  .command("usage")
  .description("Itemise recent LLM calls (cost + feature + tokens)")
  .option("--limit <n>", "How many rows to show", (v) => parseInt(v, 10), 30)
  .option(
    "--since <Nd|Nh|Nm>",
    "Only rows newer than this window (e.g. 24h, 7d)",
  )
  .option(
    "--feature <name>",
    "Filter to a single feature (verification / smart_report / test)",
  )
  // #530 — Rollup flags: group spend by project tag or session id.
  // `--by session` / `--by project` produce a summary table instead of
  // the per-call itemisation; `--project <tag>` filters the itemised
  // view to a single project ("how did todo-app spend its $1.18?").
  .option("--by <session|project>", "Group rows + sum cost by this dimension")
  .option(
    "--project <tag>",
    "Filter rows to a single project tag (overrides --by project)",
  )
  .option("--json", "Output JSON instead of a table", false)
  .action(
    (options: {
      limit: number;
      since?: string;
      feature?: string;
      by?: string;
      project?: string;
      json?: boolean;
    }) => {
      requireInitialised();
      const db = getDb();
      let sinceTs: number | undefined;
      if (options.since) {
        try {
          sinceTs = Date.now() - parseSince(options.since);
        } catch (err) {
          console.error(
            red("error: ") + (err instanceof Error ? err.message : String(err)),
          );
          closeDb();
          process.exit(1);
        }
      }

      // #530 — Rollup mode: produce a project / session summary instead of
      // the per-call itemisation. Filter by project takes precedence
      // (drops into the itemisation with a project filter) so users get
      // both the per-project total + the per-call breakdown in one
      // invocation.
      if (options.by && !options.project) {
        const by = options.by.toLowerCase();
        if (by !== "session" && by !== "project") {
          console.error(
            red("error: ") +
              `--by must be 'session' or 'project' (got '${options.by}')`,
          );
          closeDb();
          process.exit(1);
        }
        const grouped =
          by === "project"
            ? listProjectCosts(db, sinceTs)
            : listSessionCosts(db, sinceTs);
        if (options.json) {
          process.stdout.write(JSON.stringify(grouped, null, 2) + "\n");
          closeDb();
          return;
        }
        if (grouped.length === 0) {
          console.log(dim(`(no matching ${by} rollups)`));
          closeDb();
          return;
        }
        for (const r of grouped) {
          const tag =
            "projectTag" in r ? r.projectTag : r.sessionId.slice(0, 8);
          const cost = r.totalUsd.toFixed(4);
          const lastAt = r.lastAt
            ? new Date(r.lastAt).toISOString().slice(0, 19).replace("T", " ")
            : "-";
          const sessions =
            "sessions" in r
              ? ` ${r.sessions} session${r.sessions === 1 ? "" : "s"}`
              : "";
          console.log(
            `${tag.padEnd(24)} \$${cost.padStart(10)} ${String(r.calls).padStart(4)} calls${sessions} ${dim(`(last ${lastAt})`)}`,
          );
        }
        const total = grouped.reduce((s, r) => s + r.totalUsd, 0);
        console.log(
          dim(
            `\nTotal: \$${total.toFixed(4)} across ${grouped.length} ${by}${grouped.length === 1 ? "" : "s"}`,
          ),
        );
        closeDb();
        return;
      }

      const rows = queryUsage(db, {
        limit: options.limit,
        since: sinceTs,
        feature: options.feature,
        ...(options.project ? { project: options.project } : {}),
      });
      if (options.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        closeDb();
        return;
      }
      if (rows.length === 0) {
        console.log(dim("(no matching LLM calls)"));
        closeDb();
        return;
      }
      for (const r of rows) {
        const ts = new Date(r.ts).toISOString().slice(0, 19).replace("T", " ");
        const cost = r.costUsd.toFixed(6);
        const req = r.requestId ? dim(` ${r.requestId.slice(0, 5)}…`) : "";
        const tag = r.projectTag ? dim(` [${r.projectTag}]`) : "";
        console.log(
          `${dim(ts)} ${r.provider.padEnd(9)} ${r.feature.padEnd(18)} ${r.model.padEnd(22)} in=${String(r.inputTokens).padStart(5)} out=${String(r.outputTokens).padStart(5)} \$${cost} ${dim(`${r.durationMs}ms`)}${r.cacheHit ? dim(" (cache)") : ""}${req}${tag}`,
        );
      }
      const total = rows.reduce((s, r) => s + r.costUsd, 0);
      const cached = rows.filter((r) => r.cacheHit).length;
      const label = options.since
        ? `${options.since} total`
        : `${rows.length}-row total`;
      const filterNote = options.project
        ? ` for project '${options.project}'`
        : "";
      console.log(
        dim(
          `\n${label}${filterNote}: \$${total.toFixed(4)} across ${rows.length} call${rows.length === 1 ? "" : "s"} (${cached} cached)`,
        ),
      );
      closeDb();
    },
  );

// ============================================================================
// Helpers
// ============================================================================

function requireInitialised(): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") +
        `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
}

const KNOWN_FEATURES: readonly string[] = Object.keys(
  defaultLlmConfig().features,
);
export function isKnownFeature(s: string): s is LlmFeature {
  return KNOWN_FEATURES.includes(s);
}

function hasAnyFeatureOn(config: LlmConfig): boolean {
  return Object.values(config.features).some((v) => v === true);
}

function renderBar(pct: number, width = 30): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const colour = clamped >= 100 ? red : clamped >= 80 ? orange : green;
  return colour(bar);
}

export interface LoginDeps {
  /** Runs the sign-in against OpenAI. Replace in tests. */
  runLogin: typeof signInWithChatgpt;
  openInBrowser: (url: string, autoOpen?: boolean) => void;
  /** Prompts the user to paste the redirect URL / code (headless mode). */
  promptPaste: () => Promise<string>;
}

/** Default deps used by the CLI — real fetch, real spawn, real readline. */
export function defaultLoginDeps(): LoginDeps {
  return {
    runLogin: signInWithChatgpt,
    openInBrowser,
    promptPaste: promptForCallback,
  };
}

export async function performOAuthLogin(
  provider: OAuthProviderConfig,
  opts: { headless: boolean },
  paths: { llmConfigPath: string },
  store: SecretStore,
  deps: LoginDeps,
): Promise<{ email?: string }> {
  const tokens: OAuthTokens = await deps.runLogin(store, {
    presentAuthUrl: (url: string) => deps.openInBrowser(url, !opts.headless),
    useLoopback: !opts.headless,
    onRetry: () => console.log("OpenAI needs one more sign-in to finish setting up Foreman.\n"),
    ...(opts.headless ? { readPastedCode: deps.promptPaste } : {}),
  });
  saveOAuthTokens(store, provider.id, tokens);
  const config = loadLlmConfig(paths.llmConfigPath);
  saveLlmConfig(paths.llmConfigPath, setAuthMode(config, provider.id, "oauth"));
  return tokens.email ? { email: tokens.email } : {};
}

export function performOAuthLogout(
  providerId: OAuthProviderId,
  paths: { llmConfigPath: string },
  store: SecretStore,
): void {
  clearOAuthTokens(store, providerId);
  saveAuthMode(paths.llmConfigPath, providerId, "api_key");
}

/**
 * Move Foreman's brain to another provider. Signing in doesn't do this: setup
 * can sign in to two plans in a row after you chose one. A model from the old
 * provider wouldn't exist on the new one, so it takes that provider's default.
 */
export function switchBrain(path: string, provider: ProviderId, model?: string): LlmConfig {
  const current = loadLlmConfig(path);
  const chosen = model ?? (current.provider === provider ? current.model : deriveDefaultModelId(provider));
  if (chosen === "default") {
    throw new Error(`${provider} has no default model. Name one: foreman llm use ${provider} <model>`);
  }
  const next = { ...current, enabled: true, provider, model: chosen };
  saveLlmConfig(path, next);
  return next;
}

function saveAuthMode(
  path: string,
  providerId: AuthModeProviderId,
  mode: "api_key" | "oauth" | "claude_code",
): void {
  saveLlmConfig(path, setAuthMode(loadLlmConfig(path), providerId, mode));
}

/**
 * Connect Foreman's brain to the user's own Claude Code. A real call decides,
 * since `claude auth status` stays true after a token is revoked. Signing in
 * happens only in Claude Code's own flow, which Foreman just starts.
 */
export async function connectClaudeCode(
  llmConfigPath: string,
  client: Pick<ClaudeCodeLlmClient, "ping"> = new ClaudeCodeLlmClient({
    model: defaultLlmConfig().model,
  }),
  runClaudeLogin: () => boolean = () =>
    spawnSync(CLAUDE_LOGIN_COMMAND, { shell: true, stdio: "inherit" })
      .status === 0,
): Promise<void> {
  try {
    await client.ping();
  } catch (err) {
    if (
      !(err instanceof ClaudeCodeNotReadyError) ||
      err.reason !== "signed-out"
    )
      throw err;
    console.log(
      `Claude Code isn't signed in. Starting its own sign-in (${CLAUDE_LOGIN_COMMAND})…`,
    );
    if (!runClaudeLogin()) throw err;
    await client.ping();
  }
  saveAuthMode(llmConfigPath, "anthropic", "claude_code");
}

export function describeAuthMode(
  config: LlmConfig,
  store: SecretStore,
  providerId: AuthModeProviderId,
): string {
  const cred = config.credentials[providerId];
  if (cred?.auth_mode === "claude_code") {
    return `${green("Claude Code")} (its own sign-in)`;
  }
  if (providerId === "openai" && cred?.auth_mode === "oauth") {
    const tokens = loadOAuthTokens(store, providerId);
    if (!tokens) {
      return `${orange("ChatGPT plan (not signed in)")} — run \`foreman llm login ${providerId}\``;
    }
    const account = tokens.email ? `, ${tokens.email}` : "";
    return `${green("Using ChatGPT plan")} (signed in${account}) · manage usage: ${CHATGPT_USAGE_URL}`;
  }
  return cred?.secret_name
    ? `${dim("api key")} (${cred.secret_name})`
    : `${dim("api key")} (no secret_name)`;
}

function openInBrowser(url: string, autoOpen = true): void {
  console.log("Open this URL in your browser to sign in:");
  console.log("");
  console.log(`  ${url}`);
  console.log("");
  if (!autoOpen) return;
  const platform = process.platform;
  // win32: rundll32, not `cmd /c start` — cmd.exe would re-parse `&` in
  // the query string.
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args = platform === "win32" ? [WIN32_URL_HANDLER, url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

async function promptForCallback(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      "\nAfter signing in, your browser will land on a localhost URL that " +
        "won't load.\nCopy the FULL URL from the address bar and paste it " +
        "here:\n> ",
      (answer) => {
        rl.close();
        resolve(answer);
      },
    );
  });
}
