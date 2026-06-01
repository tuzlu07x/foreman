// =============================================================================
// Per-agent login-step resolver (#tui-login)
// =============================================================================

import { findAgent, loadActiveRegistry } from "./registry-catalog.js";
import { resolveRequiredSetup, type OAuthStep } from "./required-setup.js";
import type { SecretStore } from "./secret-store.js";

export interface AgentLoginLookup {
  registryId: string;
  llmProvider: string | null;
}

export function resolveAgentLoginSteps(
  lookup: AgentLoginLookup,
  secretStore: SecretStore,
): OAuthStep[] {
  if (!lookup.llmProvider) return [];

  let doc;
  try {
    doc = loadActiveRegistry().doc;
  } catch {
    return [];
  }

  let entry;
  try {
    entry = findAgent(doc, lookup.registryId);
  } catch {
    return [];
  }

  const resolution = resolveRequiredSetup({
    agents: [entry],
    agentProviders: { [entry.id]: lookup.llmProvider },
    secretStore,
  });
  return resolution.oauthSteps;
}
