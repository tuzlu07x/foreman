import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { catalogEntryFor, isInstance, supportsInstances } from "../core/agent-instance.js";
import { AGENT_TOKEN_ENV, AGENT_TOKEN_FILE_ENV } from "../core/agent-identity.js";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { loadOrg, resolveAssignee, type OrgDoc } from "../core/org/org.js";
import { loadActiveRegistry, type AgentEntry } from "../core/registry-catalog.js";
import { RegistryService, type RegisteredAgent } from "../core/registry.js";
import { instanceLaunchFor } from "../core/role-launch.js";
import { SecretStore } from "../core/secret-store.js";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateSecretsMasterKey } from "../identity/master-key.js";
import { getForemanPaths } from "../utils/config.js";
import { bold, dim, red } from "./colors.js";

// =============================================================================
// `foreman open <role>`: talk to one role yourself
// =============================================================================
//
// Opens the role's agent (Claude Code or Codex) in this terminal as that
// role: its own Foreman identity and MCP server, its org.yaml role as the
// system prompt (Codex: the first message), its model, and FOREMAN_SPAWNED_BY
// so Foreman's hook holds it to the role's `can`. You answer the agent's own
// prompts, as in any session you start yourself.

export interface OpenPlan {
  roleId: string;
  title: string;
  agentId: string;
  entry: AgentEntry;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The role `target` names: a role id, a department (its head), an agent id,
 *  or a title (any case). */
export function findRole(doc: OrgDoc, target: string): string | null {
  const direct = resolveAssignee(doc, target);
  if (direct) return direct;
  const wanted = target.trim().toLowerCase();
  const match = Object.entries(doc.roles).find(
    ([id, r]) => id.toLowerCase() === wanted || r.title.toLowerCase() === wanted || r.agent.toLowerCase() === wanted,
  );
  return match ? match[0] : null;
}

/** How to start `roleId`'s agent interactively, or why it can't be. */
export function openPlan(input: {
  doc: OrgDoc;
  roleId: string;
  registered: RegisteredAgent | null;
  catalog: Pick<ReturnType<typeof loadActiveRegistry>["doc"], "agents">;
  launchFor: (agentId: string, entry: AgentEntry) => { args: string[]; env: Record<string, string>; taskPrefix: string } | null;
}): OpenPlan | { error: string } {
  const role = input.doc.roles[input.roleId];
  if (!role) return { error: `'${input.roleId}' is not a role in org.yaml.` };
  if (!input.registered) {
    return { error: `${role.title} runs on '${role.agent}', which isn't registered. Add it with: foreman agent add ${role.agent} --type claude-code` };
  }
  const entry = catalogEntryFor(input.catalog, role.agent, input.registered);
  if (!entry || !supportsInstances(entry)) {
    return { error: `${role.title} runs on ${entry?.name ?? role.agent}. foreman open works for roles on Claude Code or Codex; open that agent the usual way.` };
  }
  const command = entry.id === "codex" ? "codex" : "claude";
  const launch = isInstance(role.agent, entry) ? input.launchFor(role.agent, entry) : null;
  const args = [...(launch?.args ?? [])];
  if (input.registered.modelVersion && entry.task_model_flag) args.push(entry.task_model_flag, input.registered.modelVersion);
  // Codex has no system-prompt flag: the role goes first, as in its tasks.
  if (launch?.taskPrefix) args.push(`${launch.taskPrefix}Wait for my instructions.`);
  return {
    roleId: input.roleId,
    title: role.title,
    agentId: role.agent,
    entry,
    command,
    args,
    env: { ...(launch?.env ?? {}), FOREMAN_SPAWNED_BY: role.agent },
  };
}

export const openCommand = new Command("open")
  .description("Open a role's agent (Claude Code or Codex) in this terminal, as that role")
  .argument("<role>", "a role id, its title, a department (its head) or the agent it runs on")
  .action(async (target: string) => {
    const paths = getForemanPaths();
    if (!existsSync(paths.root)) {
      console.error(red("error: ") + "Foreman is not initialised. Run 'foreman init' first.");
      process.exit(1);
    }
    let doc: OrgDoc | null;
    try {
      doc = loadOrg(paths.orgConfigPath);
    } catch (err) {
      console.error(red("error: ") + `org.yaml is invalid: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    if (!doc) {
      console.error(red("error: ") + "No team yet. Add roles in the TUI (t, then n) or with 'foreman org add-role'.");
      process.exit(1);
    }
    const roleId = findRole(doc, target);
    if (!roleId) {
      console.error(red("error: ") + `No role called '${target}'. Your roles: ${Object.keys(doc.roles).join(", ")}`);
      process.exit(1);
    }
    const registry = new RegistryService(getDb(), new EventBus<ForemanEventMap>());
    const store = new SecretStore(getDb(), loadOrCreateSecretsMasterKey());
    const plan = openPlan({
      doc,
      roleId,
      registered: registry.get(doc.roles[roleId]!.agent),
      catalog: loadActiveRegistry().doc,
      launchFor: (agentId, entry) => instanceLaunchFor(agentId, entry, store, paths),
    });
    closeDb();
    if ("error" in plan) {
      console.error(red("error: ") + plan.error);
      process.exit(1);
    }
    console.log(`Opening ${bold(plan.title)} (${plan.roleId}) on ${plan.entry.name}. Foreman sees it as ${bold(plan.agentId)}.`);
    console.log(dim("  Its own prompts are yours to answer; Foreman's policy and your approvals still apply."));
    const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
    // The role's identity travels in its own MCP server config, never in
    // the agent's environment.
    delete env[AGENT_TOKEN_ENV];
    delete env[AGENT_TOKEN_FILE_ENV];
    for (const key of plan.entry.task_env_strip ?? []) delete env[key];
    const child = spawn(plan.command, plan.args, { stdio: "inherit", env });
    child.on("error", (err) => {
      console.error(red("error: ") + `couldn't start ${plan.command}: ${err.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  });
