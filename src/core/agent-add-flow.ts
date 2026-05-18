import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentEntry, ProviderEntry } from "./registry-catalog.js";
import type { RegistryService } from "./registry.js";
import type { SecretStore } from "./secret-store.js";

export interface SecretCheckResult {
  required: SecretStatus[];
  optional: SecretStatus[];
  hasAllRequired: boolean;
}

export interface SecretStatus {
  name: string;
  present: boolean;
}

export class AgentAlreadyRegisteredError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent "${agentId}" is already registered`);
    this.name = "AgentAlreadyRegisteredError";
  }
}

export class MissingRequiredSecretsError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `Cannot register agent — required secrets missing: ${missing.join(", ")}`,
    );
    this.name = "MissingRequiredSecretsError";
  }
}

export function expandHome(path: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

export interface CheckSecretsOptions {
  /** Provider id the user explicitly picked for this agent (#297). When
   *  set, `checkSecrets` filters out `required_secrets` that belong to a
   *  *different* provider — e.g. user picked openai for OpenClaw → the
   *  registry's `required_secrets: ["anthropic-key"]` becomes empty
   *  because anthropic-key belongs to anthropic, not openai (#373). */
  llmProvider?: string;
  /** Provider catalog used to resolve secret_name → owning provider id.
   *  When omitted, the filter is skipped (legacy callers preserved). */
  providerCatalog?: ProviderEntry[];
}

/**
 * Map a secret name to the provider id that owns it (e.g. "anthropic-key" →
 * "anthropic"). Returns null when the secret isn't a provider-owned key
 * (Telegram bot tokens etc.) — those stay required regardless of
 * llmProvider.
 */
export function providerOwningSecret(
  secretName: string,
  providerCatalog: ProviderEntry[],
): string | null {
  const provider = providerCatalog.find(
    (p) => p.secret_name === secretName,
  );
  return provider?.id ?? null;
}

export function checkSecrets(
  entry: AgentEntry,
  store: SecretStore,
  options: CheckSecretsOptions = {},
): SecretCheckResult {
  const requiredFiltered = filterRequiredByProvider(
    entry.required_secrets,
    options,
  );
  const required = requiredFiltered.map((name) => ({
    name,
    present: store.exists(name),
  }));
  const optional = entry.optional_secrets.map((name) => ({
    name,
    present: store.exists(name),
  }));
  return {
    required,
    optional,
    hasAllRequired: required.every((s) => s.present),
  };
}

// #373 — Drop `required_secrets` entries that belong to a provider OTHER
// than the one the user picked for this agent. Non-provider secrets
// (Telegram bot token etc.) pass through unchanged.
function filterRequiredByProvider(
  required: readonly string[],
  options: CheckSecretsOptions,
): string[] {
  if (!options.llmProvider || !options.providerCatalog) {
    return [...required];
  }
  return required.filter((secretName) => {
    const owner = providerOwningSecret(secretName, options.providerCatalog!);
    // Not a provider key (or provider not in catalog) → keep required
    if (owner === null) return true;
    // Owner matches user's pick → still required
    return owner === options.llmProvider;
  });
}

export function pickConfigPath(entry: AgentEntry): string | null {
  for (const raw of entry.config_paths) {
    const expanded = expandHome(raw);
    if (existsSync(expanded)) return expanded;
  }
  // No file found; return the first declared path (expanded) as the *would-be*
  // location so the caller can create it.
  const first = entry.config_paths[0];
  return first ? expandHome(first) : null;
}

export interface RegisterAgentInput {
  agentId: string;
  entry: AgentEntry;
  registry: RegistryService;
  llmProvider?: string;
  responsibilityNote?: string;
}

export interface RegisterAgentResult {
  agentId: string;
  privateKey: Buffer;
}

export function registerAgent(input: RegisterAgentInput): RegisterAgentResult {
  if (input.registry.get(input.agentId)) {
    throw new AgentAlreadyRegisteredError(input.agentId);
  }
  const result = input.registry.register({
    id: input.agentId,
    displayName: input.entry.name,
    transport: "stdio",
    metadata: {
      registryId: input.entry.id,
      registryHomepage: input.entry.homepage,
    },
    llmProvider: input.llmProvider,
    responsibilityNote: input.responsibilityNote,
  });
  if (!result.privateKey) {
    throw new Error(
      "RegistryService.register did not return a private key — internal invariant broken",
    );
  }
  return { agentId: input.agentId, privateKey: result.privateKey };
}
