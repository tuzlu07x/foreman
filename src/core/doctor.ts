import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { parse as parseYaml } from "yaml";
import { createInMemoryDb, getDb } from "../db/client.js";
import { getMigrationStatus } from "../db/migration-status.js";
import { derivePublicKey } from "../identity/keypair.js";
import { sign, verify } from "../identity/signing.js";
import { MCPGateway } from "../mcp/gateway.js";
import { getForemanPaths } from "../utils/config.js";
import { legacyHasInterestingFiles } from "../utils/migrate-config.js";
import { EventBus, type ForemanEventMap } from "./event-bus.js";
import { getBudgetStatus } from "./llm/budget.js";
import { loadLlmConfig } from "./llm/config.js";
import {
  loadActiveProviders,
  loadActiveRegistry,
} from "./registry-catalog.js";
import { detectProviderByPrefix } from "./key-prefix-detect.js";
import { loadVoiceConfig } from "./notification/voice-config.js";
import { findDuplicateSlots } from "./secret-slot-migration.js";
import { SecretStore } from "./secret-store.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { RegistryService } from "./registry.js";
import { getUpdateCachePath, isNewer } from "./update-check.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
}

export interface DoctorReport {
  checks: CheckResult[];
  /** Counts by status — surfaced in --json output so consumers don't have to
   * iterate `checks[]` to drive their own monitoring thresholds. */
  summary: DoctorSummary;
  /** 0 = all ok, 1 = warnings only, 2 = any failure. */
  exitCode: 0 | 1 | 2;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
}

const MIN_NODE_MAJOR = 20;

export function checkPaths(): CheckResult {
  const paths = getForemanPaths();
  return {
    name: "paths",
    status: "ok",
    message: `config=${paths.configDir} · state=${paths.stateDir} · cache=${paths.cacheDir}`,
  };
}

export function checkLegacyHome(): CheckResult {
  if (!legacyHasInterestingFiles()) {
    return {
      name: "legacy_home",
      status: "ok",
      message: "no legacy ~/.foreman/ files detected",
    };
  }
  return {
    name: "legacy_home",
    status: "warn",
    message: "legacy ~/.foreman/ still contains config or state files",
    remediation:
      "Run 'foreman migrate-config' to move them into the platform-native dirs.",
  };
}

export function checkNodeVersion(): CheckResult {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      name: "node_version",
      status: "fail",
      message: `Node ${process.versions.node} is below the required ${MIN_NODE_MAJOR}.x`,
      remediation: `Install Node >= ${MIN_NODE_MAJOR} (e.g. via nvm: 'nvm install ${MIN_NODE_MAJOR}').`,
    };
  }
  return {
    name: "node_version",
    status: "ok",
    message: `Node ${process.versions.node}`,
  };
}

export function checkForemanHome(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    return {
      name: "foreman_home",
      status: "fail",
      message: `${paths.root} does not exist`,
      remediation: "Run 'foreman init' to create it.",
    };
  }
  try {
    accessSync(paths.root, constants.W_OK);
  } catch {
    return {
      name: "foreman_home",
      status: "fail",
      message: `${paths.root} is not writable`,
      remediation: `Check permissions: 'chmod u+w ${paths.root}'.`,
    };
  }
  return {
    name: "foreman_home",
    status: "ok",
    message: paths.root,
  };
}

export function checkExpectedFiles(): CheckResult {
  const paths = getForemanPaths();
  const missing: string[] = [];
  if (!existsSync(paths.identityPath)) missing.push("identity.key");
  if (!existsSync(paths.policyPath)) missing.push("policy.yaml");
  if (!existsSync(paths.dbPath)) missing.push("foreman.db");
  if (missing.length > 0) {
    return {
      name: "expected_files",
      status: "fail",
      message: `missing files in ${paths.root}: ${missing.join(", ")}`,
      remediation: "Run 'foreman init' to regenerate the missing files.",
    };
  }
  return {
    name: "expected_files",
    status: "ok",
    message: "identity.key, policy.yaml, foreman.db present",
  };
}

export function checkIdentityKey(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.identityPath)) {
    return {
      name: "identity_key",
      status: "fail",
      message: `${paths.identityPath} not found`,
      remediation: "Run 'foreman init'.",
    };
  }
  try {
    const privateKey = readFileSync(paths.identityPath);
    if (privateKey.length !== 32) {
      return {
        name: "identity_key",
        status: "fail",
        message: `identity.key is ${privateKey.length} bytes (expected 32)`,
        remediation:
          "Identity file is corrupt. Back it up, delete it, and re-run 'foreman init' (this rotates the key).",
      };
    }
    const publicKey = derivePublicKey(privateKey);
    const signature = sign("foreman-doctor-probe", privateKey);
    if (!verify("foreman-doctor-probe", signature, publicKey)) {
      return {
        name: "identity_key",
        status: "fail",
        message: "Ed25519 sign/verify round-trip failed",
        remediation:
          "Identity file is corrupt — back it up and re-run 'foreman init'.",
      };
    }
    return {
      name: "identity_key",
      status: "ok",
      message: `ed25519:${publicKey.subarray(0, 4).toString("hex")}…`,
    };
  } catch (err) {
    return {
      name: "identity_key",
      status: "fail",
      message: `failed to load identity.key: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Check the file's permissions or re-run 'foreman init'.",
    };
  }
}

export function checkDatabase(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "database",
      status: "fail",
      message: `${paths.dbPath} not found`,
      remediation: "Run 'foreman init'.",
    };
  }
  try {
    getDb();
    return {
      name: "database",
      status: "ok",
      message: `${paths.dbPath} opens; schema is at the latest migration`,
    };
  } catch (err) {
    return {
      name: "database",
      status: "fail",
      message: `database failed to open or migrate: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Back up foreman.db, then re-run 'foreman init'. If the schema is ahead of this binary, upgrade foreman-agent.",
    };
  }
}

export function checkFts5(): CheckResult {
  try {
    const { sqlite } = createInMemoryDb();
    const row = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='requests_fts'",
      )
      .get();
    sqlite.close();
    if (!row) {
      return {
        name: "fts5",
        status: "fail",
        message: "requests_fts virtual table not present after migration",
        remediation:
          "The linked sqlite was built without FTS5. Reinstall better-sqlite3 against a sqlite that includes FTS5: 'npm rebuild better-sqlite3'.",
      };
    }
    return {
      name: "fts5",
      status: "ok",
      message: "FTS5 available; requests_fts ready",
    };
  } catch (err) {
    return {
      name: "fts5",
      status: "fail",
      message: `FTS5 probe failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Reinstall better-sqlite3 with FTS5 enabled.",
    };
  }
}

export function checkPolicyYaml(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.policyPath)) {
    return {
      name: "policy_yaml",
      status: "fail",
      message: `${paths.policyPath} not found`,
      remediation: "Run 'foreman init' to write the default template.",
    };
  }
  try {
    const text = readFileSync(paths.policyPath, "utf-8");
    const parsed = parseYaml(text);
    if (
      parsed !== null &&
      (typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      return {
        name: "policy_yaml",
        status: "fail",
        message: "policy.yaml top-level must be an object (or empty)",
        remediation: `Edit ${paths.policyPath} — see the comments in the template for shape.`,
      };
    }
    return {
      name: "policy_yaml",
      status: "ok",
      message: "parses",
    };
  } catch (err) {
    return {
      name: "policy_yaml",
      status: "fail",
      message: `policy.yaml failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Open ${paths.policyPath} and fix the syntax (YAML validators online help).`,
    };
  }
}

// Notification config — best-effort lint. Doesn't require a working bot.
export function checkNotifyConfig(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.notifyConfigPath)) {
    return {
      name: "notify_config",
      status: "ok",
      message: "notify.yaml absent — OOB notifications disabled (the default)",
    };
  }
  try {
    const text = readFileSync(paths.notifyConfigPath, "utf-8");
    const parsed = parseYaml(text);
    if (
      parsed !== null &&
      (typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      return {
        name: "notify_config",
        status: "fail",
        message: "notify.yaml top-level must be an object (or empty)",
        remediation: `Edit ${paths.notifyConfigPath} — see docs/notifications.md.`,
      };
    }
    const channels =
      (parsed as { channels?: Record<string, { enabled?: boolean }> })?.channels ?? {};
    const enabled = Object.entries(channels)
      .filter(([, v]) => v?.enabled === true)
      .map(([k]) => k);
    if (enabled.length === 0) {
      return {
        name: "notify_config",
        status: "warn",
        message: "notify.yaml present but no channels enabled",
        remediation: "Run `foreman notify enable telegram` (or another channel).",
      };
    }
    return {
      name: "notify_config",
      status: "ok",
      message: `enabled channels: ${enabled.join(", ")}`,
    };
  } catch (err) {
    return {
      name: "notify_config",
      status: "fail",
      message: `notify.yaml failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Open ${paths.notifyConfigPath} and fix the YAML syntax.`,
    };
  }
}

// LLM config — best-effort lint. Doesn't try to talk to the provider; just
// confirms the YAML parses + when global is on, the referenced credential
// secret resolves.
export function checkLlmConfig(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.llmConfigPath)) {
    return {
      name: "llm_config",
      status: "ok",
      message: "llm.yaml absent — LLM features disabled (the default)",
    };
  }
  try {
    const text = readFileSync(paths.llmConfigPath, "utf-8");
    const parsed = parseYaml(text);
    if (
      parsed !== null &&
      (typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      return {
        name: "llm_config",
        status: "fail",
        message: "llm.yaml top-level must be an object (or empty)",
        remediation: `Edit ${paths.llmConfigPath} — see docs/llm.md.`,
      };
    }
    const obj = (parsed ?? {}) as {
      enabled?: boolean;
      provider?: string;
    };
    const enabled = obj.enabled === true;
    const provider = obj.provider ?? "anthropic";
    if (!enabled) {
      return {
        name: "llm_config",
        status: "ok",
        message: `parses (global off, default provider ${provider})`,
      };
    }
    return {
      name: "llm_config",
      status: "ok",
      message: `parses (global ON, provider ${provider}) — run \`foreman llm test\` to verify credentials`,
    };
  } catch (err) {
    return {
      name: "llm_config",
      status: "fail",
      message: `llm.yaml failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Open ${paths.llmConfigPath} and fix the YAML syntax.`,
    };
  }
}

// LLM credentials — when LLM is globally enabled, confirm the referenced
// provider's secret exists in the store. Otherwise verification / smart-report
// silently fall back to heuristic-only forever and the user has no clue why
// (their setup looks "on" but nothing fires). Skipped when LLM is off.
export function checkLlmCredentials(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.llmConfigPath)) {
    return {
      name: "llm_credentials",
      status: "ok",
      message: "llm.yaml absent — credentials not required",
    };
  }
  let config: ReturnType<typeof loadLlmConfig>;
  try {
    config = loadLlmConfig(paths.llmConfigPath);
  } catch {
    // Bad YAML is already reported by llm_config — don't double-flag here.
    return {
      name: "llm_credentials",
      status: "ok",
      message: "skipped (llm.yaml failed to parse — see llm_config above)",
    };
  }
  if (!config.enabled) {
    return {
      name: "llm_credentials",
      status: "ok",
      message: "LLM global switch is off — credentials not required",
    };
  }
  const providerCred = (config.credentials as Record<string, { secret_name?: string | null } | undefined>)[
    config.provider
  ];
  const secretName = providerCred?.secret_name ?? null;
  if (!secretName) {
    return {
      name: "llm_credentials",
      status: "warn",
      message: `LLM enabled but ${config.provider}.secret_name is unset in llm.yaml`,
      remediation: `Edit ${paths.llmConfigPath} and set credentials.${config.provider}.secret_name (then \`foreman secrets add <name>\`).`,
    };
  }
  try {
    const db = getDb();
    const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
    if (!store.exists(secretName)) {
      return {
        name: "llm_credentials",
        status: "warn",
        message: `LLM enabled but secret "${secretName}" is missing from the store`,
        remediation: `Run \`foreman secrets add ${secretName}\` — verification + smart-report will silently fall back to heuristic-only until this is set.`,
      };
    }
    // Prefix sanity check (#307) — catches the round 2 footgun where a user
    // pasted an OpenAI sk-proj- key into the Anthropic slot. We resolve the
    // expected prefix via the provider catalog (the source of truth set in
    // #291), then use the shared most-specific-wins detector so that
    // "sk-ant-..." resolves to Anthropic, not OpenAI's sub-prefix "sk-".
    // Skipped silently when the catalog opts out (key_prefix: null /
    // missing — Ollama, custom).
    const expectedPrefix = lookupExpectedPrefix(config.provider);
    if (expectedPrefix) {
      const value = store.get(secretName);
      const detected = detectProviderByPrefix(value);
      if (!detected || detected.providerId !== config.provider) {
        const matchedNote = detected
          ? ` (value looks like a ${detected.provider} key)`
          : "";
        return {
          name: "llm_credentials",
          status: "warn",
          message: `secret "${secretName}" doesn't match ${config.provider} key format (expected prefix "${expectedPrefix}")${matchedNote}`,
          remediation: `Run \`foreman secrets rotate ${secretName}\` and paste a ${config.provider} key. If this is a private fork/proxy with non-standard keys, ignore this warning.`,
        };
      }
    }
    return {
      name: "llm_credentials",
      status: "ok",
      message: `${config.provider} credentials present (${secretName})`,
    };
  } catch (err) {
    return {
      name: "llm_credentials",
      status: "warn",
      message: `couldn't check secret store: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function lookupExpectedPrefix(providerId: string): string | null {
  try {
    const { doc } = loadActiveProviders();
    const entry = doc.providers.find((p) => p.id === providerId);
    return entry?.key_prefix ?? null;
  } catch {
    // Catalog unreadable — skip prefix check rather than fail the doctor.
    return null;
  }
}

// #342 — surfaces leftover <provider>-api-key slots from pre-#291 wizard
// runs. Doesn't break anything; just nudges the user to run dedupe so the
// list is clean + future paste-validation hints aren't ambiguous.
export function checkSecretSlotDuplicates(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "secret_slots",
      status: "ok",
      message: "database not yet initialised",
    };
  }
  try {
    const db = getDb();
    const store = new SecretStore(db, loadOrCreateSecretsMasterKey());
    const names = store.list().map((r) => r.name);
    const duplicates = findDuplicateSlots(names);
    if (duplicates.length === 0) {
      return {
        name: "secret_slots",
        status: "ok",
        message: "no legacy duplicate slots",
      };
    }
    const labels = duplicates.map((d) => d.legacy).join(", ");
    return {
      name: "secret_slots",
      status: "warn",
      message: `${duplicates.length} legacy provider slot${duplicates.length === 1 ? "" : "s"} alongside canonical (#342): ${labels}`,
      remediation: `Run \`foreman secrets dedupe-providers --dry-run\` to preview, then \`--yes\` to remove.`,
    };
  } catch (err) {
    return {
      name: "secret_slots",
      status: "warn",
      message: `slot scan failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// LLM budget — warns at alert_threshold_pct, fails when the cap is exhausted
// (LLM features will refuse new calls until the next reset). Silent when LLM
// is globally disabled — no point alarming users who never opted in.
export function checkLlmBudget(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.llmConfigPath)) {
    return {
      name: "llm_budget",
      status: "ok",
      message: "llm.yaml absent — LLM features disabled",
    };
  }
  let config: ReturnType<typeof loadLlmConfig>;
  try {
    config = loadLlmConfig(paths.llmConfigPath);
  } catch (err) {
    return {
      name: "llm_budget",
      status: "warn",
      message: `llm.yaml unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!config.enabled) {
    return {
      name: "llm_budget",
      status: "ok",
      message: "LLM global switch is off — budget not in use",
    };
  }
  try {
    const db = getDb();
    const status = getBudgetStatus(db, config);
    const pctLabel = `${status.spentPct.toFixed(0)}%`;
    if (status.spentUsd >= status.capUsd) {
      return {
        name: "llm_budget",
        status: "fail",
        message: `LLM budget exhausted — \$${status.spentUsd.toFixed(2)} of \$${status.capUsd.toFixed(2)} (${pctLabel}). Smart features paused until reset.`,
        remediation:
          "Run `foreman llm budget --set N` to raise the monthly cap, or wait for the next billing window.",
      };
    }
    if (status.alertTripped) {
      return {
        name: "llm_budget",
        status: "warn",
        message: `LLM budget alert tripped — \$${status.spentUsd.toFixed(2)} of \$${status.capUsd.toFixed(2)} (${pctLabel}) spent.`,
        remediation: `Inspect with \`foreman llm usage --since=7d\` or raise the cap with \`foreman llm budget --set N\`.`,
      };
    }
    return {
      name: "llm_budget",
      status: "ok",
      message: `\$${status.spentUsd.toFixed(2)} of \$${status.capUsd.toFixed(2)} (${pctLabel}) spent — well under the alert threshold`,
    };
  } catch (err) {
    return {
      name: "llm_budget",
      status: "warn",
      message: `budget check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Voice config (#305) — surfaces parse failures + tells the user the file
// is either present + readable or absent (using built-in defaults). Doesn't
// alarm when absent because defaults are designed to be sensible without
// any config.
export function checkVoiceConfig(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.voiceConfigPath)) {
    return {
      name: "voice_config",
      status: "ok",
      message:
        "voice.yaml absent — using built-in defaults (quiet hours 23:00→08:00, summaries at 20:00, pattern detection on)",
    };
  }
  try {
    const cfg = loadVoiceConfig(paths.voiceConfigPath);
    const enabled = [
      cfg.proactive_notifications.daily_summary.enabled && "daily_summary",
      cfg.proactive_notifications.weekly_summary.enabled && "weekly_summary",
      cfg.proactive_notifications.pattern_detection.enabled && "pattern_detection",
      cfg.proactive_notifications.agent_health_alerts.enabled && "agent_health_alerts",
      cfg.proactive_notifications.budget_alerts.enabled && "budget_alerts",
    ].filter(Boolean) as string[];
    const summary =
      enabled.length === 0
        ? "all proactive types disabled"
        : `enabled: ${enabled.join(", ")}`;
    return {
      name: "voice_config",
      status: "ok",
      message: `parses (${summary}; quiet hours ${cfg.quiet_hours.enabled ? `${cfg.quiet_hours.from}→${cfg.quiet_hours.to}` : "disabled"})`,
    };
  } catch (err) {
    return {
      name: "voice_config",
      status: "warn",
      message: `voice.yaml unreadable: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Delete voice.yaml to fall back to defaults, or fix the YAML (see docs/voice.md schema).",
    };
  }
}

export function checkAgentsRegistered(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "agents_registered",
      status: "fail",
      message: "database is missing, cannot count agents",
      remediation: "Run 'foreman init' first.",
    };
  }
  try {
    const db = getDb();
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    const allRows = registry.listAll();
    const activeCount = allRows.filter((r) => r.status === "active").length;
    const disabledCount = allRows.filter((r) => r.status === "disabled").length;
    const blockedCount = allRows.filter((r) => r.status === "blocked").length;
    if (allRows.length === 0) {
      return {
        name: "agents_registered",
        status: "warn",
        message: "no agents registered yet",
        remediation:
          "Add one with 'foreman agent add' or 'foreman registry list' to pick from the curated catalog.",
      };
    }
    const detail = [
      `${activeCount} active`,
      disabledCount > 0 ? `${disabledCount} disabled` : null,
      blockedCount > 0 ? `${blockedCount} blocked` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(", ");
    return {
      name: "agents_registered",
      status: "ok",
      message: `${allRows.length} registered (${detail})`,
    };
  } catch (err) {
    return {
      name: "agents_registered",
      status: "fail",
      message: `could not read agents: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Run 'foreman init' if the database is fresh.",
    };
  }
}

// #408 / #412 — Validate that every registered agent with a
// provider_mapping has its required secret (or OAuth credential) in
// place. Surfaces ✓ / ⚠ / ✗ per-agent so the operator can see at a
// glance which agents will start cleanly and which need attention.
export function checkProviderMapping(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "provider_mapping",
      status: "ok",
      message: "skipped (no database yet)",
    };
  }
  try {
    const db = getDb();
    const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
    const allRows = registry.listAll();
    const registryDoc = loadActiveRegistry();
    const secretStore = new SecretStore(db, loadOrCreateSecretsMasterKey());
    const lines: string[] = [];
    const remediations: string[] = [];
    let anyFail = false;
    let anyWarn = false;
    for (const row of allRows) {
      const entry = registryDoc.doc.agents.find((a) => a.id === row.id);
      if (!entry) continue;
      // Skip agents without provider_mapping — older agents fall back
      // to the legacy projection path; doctor doesn't try to validate
      // them here (other checks cover their secrets).
      if (!entry.provider_mapping) continue;
      const provider = row.llmProvider;
      if (!provider) {
        // Pre-setup / fresh-install state — the agent is registered but
        // the user hasn't completed the wizard's provider step yet.
        // Silently skip so doctor doesn't surface a warning during a
        // mid-setup `foreman doctor` run.
        continue;
      }
      const providerMapping = entry.provider_mapping[provider];
      if (!providerMapping) {
        lines.push(
          `  ✗ ${row.id} — provider '${provider}' has no mapping (available: ${Object.keys(entry.provider_mapping).join(", ")})`,
        );
        remediations.push(
          `foreman provider switch ${row.id} <${Object.keys(entry.provider_mapping).join("|")}>`,
        );
        anyFail = true;
        continue;
      }
      const variantId = row.providerVariant ?? providerMapping.preferred;
      const variant = providerMapping.variants[variantId];
      if (!variant) {
        lines.push(
          `  ✗ ${row.id} — variant '${variantId}' not found in '${provider}' mapping`,
        );
        anyFail = true;
        continue;
      }
      // #434 — Append the per-agent model version when set; falls back
      // to "(variant default)" tag when null so the user can tell at a
      // glance which agents are pinned vs. inheriting.
      const modelTag = row.modelVersion
        ? ` · model=${row.modelVersion}`
        : " · model=(variant default)";
      if (variant.required_secret) {
        const present = secretStore.exists(variant.required_secret);
        if (present) {
          lines.push(
            `  ✓ ${row.id} — ${provider}/${variantId}${modelTag} (${variant.required_secret} present)`,
          );
        } else {
          lines.push(
            `  ✗ ${row.id} — ${provider}/${variantId}${modelTag} requires '${variant.required_secret}' (missing)`,
          );
          remediations.push(`foreman secrets add ${variant.required_secret}`);
          anyFail = true;
        }
      } else if (variant.interactive_setup) {
        lines.push(
          `  ⚠ ${row.id} — ${provider}/${variantId}${modelTag} uses OAuth (run \`${variant.interactive_setup}\` if not done)`,
        );
        anyWarn = true;
      } else {
        lines.push(
          `  ✓ ${row.id} — ${provider}/${variantId}${modelTag} (no auth needed)`,
        );
      }
    }
    if (lines.length === 0) {
      return {
        name: "provider_mapping",
        status: "ok",
        message: "no agents with provider_mapping registered",
      };
    }
    const message = lines.join("\n");
    if (anyFail) {
      return {
        name: "provider_mapping",
        status: "fail",
        message,
        remediation:
          remediations.length > 0
            ? `Try: ${[...new Set(remediations)].join(" · ")}`
            : undefined,
      };
    }
    if (anyWarn) {
      return {
        name: "provider_mapping",
        status: "warn",
        message,
      };
    }
    return {
      name: "provider_mapping",
      status: "ok",
      message,
    };
  } catch (err) {
    return {
      name: "provider_mapping",
      status: "fail",
      message: `provider_mapping check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkMcpGateway(): CheckResult {
  try {
    const gateway = new MCPGateway(new EventBus<ForemanEventMap>());
    gateway.dispose();
    return {
      name: "mcp_gateway",
      status: "ok",
      message: "gateway instantiates cleanly (stdio transport ready)",
    };
  } catch (err) {
    return {
      name: "mcp_gateway",
      status: "fail",
      message: `MCP gateway failed to instantiate: ${err instanceof Error ? err.message : String(err)}`,
      remediation:
        "Likely a bad install. Try 'npm install -g foreman-agent' again or run from the source tree.",
    };
  }
}

const APP_VERSION = "0.1.0";

export function checkUpdate(): CheckResult {
  if (process.env.FOREMAN_NO_UPDATE_CHECK === "1") {
    return {
      name: "update",
      status: "ok",
      message: "skipped (FOREMAN_NO_UPDATE_CHECK=1)",
    };
  }
  const path = getUpdateCachePath();
  if (!existsSync(path)) {
    return {
      name: "update",
      status: "ok",
      message: "no cached check yet — 'foreman start' will refresh on next run",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      latest?: unknown;
      observedAt?: unknown;
    };
    if (typeof raw.latest !== "string") {
      return {
        name: "update",
        status: "ok",
        message: "cache present but unreadable — will refresh on next start",
      };
    }
    if (isNewer(raw.latest, APP_VERSION)) {
      return {
        name: "update",
        status: "warn",
        message: `installed ${APP_VERSION}, latest ${raw.latest}`,
        remediation:
          "npm install -g foreman-agent@latest  (or 'brew upgrade foreman' if you tapped it)",
      };
    }
    return {
      name: "update",
      status: "ok",
      message: `up to date (latest ${raw.latest})`,
    };
  } catch {
    return {
      name: "update",
      status: "ok",
      message: "cache unreadable — will refresh on next start",
    };
  }
}

export function checkMigrations(): CheckResult {
  const paths = getForemanPaths();
  if (!existsSync(paths.dbPath)) {
    return {
      name: "migrations",
      status: "ok",
      message: "no DB yet — schema lands on 'foreman init'",
    };
  }
  try {
    const status = getMigrationStatus(paths.dbPath, paths.migrationsPath);
    if (status.pendingCount === 0) {
      return {
        name: "migrations",
        status: "ok",
        message: `up to date (${status.appliedCount} applied)`,
      };
    }
    return {
      name: "migrations",
      status: "warn",
      message: `${status.pendingCount} pending: ${status.pendingTags.join(", ")}`,
      remediation:
        "Run 'foreman migrate --apply' — it backs up to foreman.db.bak first.",
    };
  } catch (err) {
    return {
      name: "migrations",
      status: "fail",
      message: `could not read migration status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function checkChafa(env: NodeJS.ProcessEnv = process.env): CheckResult {
  if (whichOnPath("chafa", env)) {
    return {
      name: "chafa",
      status: "ok",
      message: "chafa on PATH (premium boot mascot will render)",
    };
  }
  try {
    execFileSync("chafa", ["--version"], {
      stdio: "ignore",
      timeout: 1000,
      env,
    });
    return {
      name: "chafa",
      status: "ok",
      message: "chafa available",
    };
  } catch {
    return {
      name: "chafa",
      status: "warn",
      message: "chafa not found",
      remediation:
        "Optional: 'brew install chafa' (macOS) or 'apt install chafa' (Debian/Ubuntu) for the higher-fidelity boot mascot.",
    };
  }
}

const CHECKS: (() => CheckResult)[] = [
  checkNodeVersion,
  checkPaths,
  checkForemanHome,
  checkExpectedFiles,
  checkIdentityKey,
  checkDatabase,
  checkMigrations,
  checkFts5,
  checkPolicyYaml,
  checkNotifyConfig,
  checkLlmConfig,
  checkLlmCredentials,
  checkLlmBudget,
  checkSecretSlotDuplicates,
  checkVoiceConfig,
  checkAgentsRegistered,
  checkProviderMapping,
  checkMcpGateway,
  checkLegacyHome,
  checkUpdate,
  () => checkChafa(),
];

export function runDoctor(_options: DoctorOptions = {}): DoctorReport {
  const checks: CheckResult[] = [];
  for (const fn of CHECKS) {
    try {
      checks.push(fn());
    } catch (err) {
      checks.push({
        name: "doctor",
        status: "fail",
        message: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const summary = computeSummary(checks);
  const exitCode = computeExitCode(checks);
  return { checks, summary, exitCode };
}

export function computeSummary(checks: CheckResult[]): DoctorSummary {
  const out: DoctorSummary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}

export function computeExitCode(checks: CheckResult[]): 0 | 1 | 2 {
  if (checks.some((c) => c.status === "fail")) return 2;
  if (checks.some((c) => c.status === "warn")) return 1;
  return 0;
}

function whichOnPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = `${dir}/${bin}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
