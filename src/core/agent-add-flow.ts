import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AgentEntry } from "./registry-catalog.js";
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

export function checkSecrets(
  entry: AgentEntry,
  store: SecretStore,
): SecretCheckResult {
  const required = entry.required_secrets.map((name) => ({
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
