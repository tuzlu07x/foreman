import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { AGENT_PROVIDER, quickModels } from "../core/foreman-command.js";
import { HUMAN, loadOrg, RESERVED_ORG_IDS, saveOrgText, type OrgDoc } from "../core/org/org.js";
import type { RegisteredAgent, RegistryService } from "../core/registry.js";
import { nextRuntime, slugify, TEAM_RUNTIME_NAMES, TEAM_RUNTIMES, type TeamRuntime } from "./setup-wizard/team-logic.js";

// =============================================================================
// Team page (`t`): remove a role, switch what runs it, change its model —
// or do the same for a whole department — written through to org.yaml and
// the registry. Each action says what it did in plain words.
// =============================================================================

export interface TeamActionDeps {
  orgConfigPath: string;
  registry: RegistryService;
  /** Adds a Claude Code / Codex instance: the Team page's own add path
   *  (null when added, else why not). */
  addAgent: (agentId: string, runsOn: TeamRuntime) => Promise<string | null>;
  /** Unregisters an agent for good: its key, identity token and Foreman's
   *  wiring (null when done, else why not). */
  removeAgent: (agentId: string) => Promise<string | null>;
}

export interface TeamActionResult {
  ok: boolean;
  /** What happened, in words (one line). */
  message: string;
}

const done = (message: string): TeamActionResult => ({ ok: true, message });
const failed = (message: string): TeamActionResult => ({ ok: false, message });

/** An error's first line, without a stack. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  // org.yaml validation lists its issues under a heading: say the first.
  return (/:$/.test(lines[0] ?? "") && lines[1] ? lines[1] : lines[0]) ?? "unknown error";
}

function readOrg(path: string): OrgDoc {
  const org = loadOrg(path);
  if (!org) throw new Error("there's no org.yaml");
  return org;
}

/** What program runs `agent` (`claude-code`, `codex`, …). */
export function agentRuntime(agent: Pick<RegisteredAgent, "id" | "metadata">): string {
  const r = agent.metadata?.registryId;
  return typeof r === "string" && r ? r : agent.id;
}

/** An instance (named for a role), not the program itself. */
export function isInstanceAgent(agent: Pick<RegisteredAgent, "id" | "metadata">): boolean {
  return agentRuntime(agent) !== agent.id && !(TEAM_RUNTIMES as readonly string[]).includes(agent.id);
}

function titleOf(org: OrgDoc, roleId: string): string {
  return org.roles[roleId]?.title ?? roleId;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

// -----------------------------------------------------------------------------
// Remove
// -----------------------------------------------------------------------------

export interface RemovalPlan {
  removed: string[];
  /** Roles that reported to a removed one, and who they report to now. */
  reportsTo: Record<string, string>;
  /** Departments whose head was removed, and the role that leads them now. */
  heads: Record<string, string>;
  /** Departments that go: asked for, or with no role left. */
  droppedDepartments: string[];
}

/**
 * What removing `roleIds` (and `departments`) does to the chart. Whoever
 * reported to a removed role reports to its manager instead (the nearest
 * one left). A department whose head goes is led by its first role left
 * (org.yaml order), as in the setup wizard: the new lead reports where the
 * old one did, and the rest of the department that reported to the old
 * lead reports to the new one. A department with no role left goes.
 */
export function planRemoval(org: OrgDoc, roleIds: readonly string[], departments: readonly string[] = []): RemovalPlan {
  const removed = new Set(roleIds.filter((id) => org.roles[id]));
  const dropped = new Set(departments.filter((d) => org.departments[d]));
  for (const [id, role] of Object.entries(org.roles)) {
    if (role.department && dropped.has(role.department)) removed.add(id);
  }
  const survivors = Object.keys(org.roles).filter((id) => !removed.has(id));
  const reportsTo: Record<string, string> = {};
  const heads: Record<string, string> = {};
  /** The first manager above `from` (inclusive) that stays, or you. */
  const keptFrom = (from: string, skip?: string): string => {
    const seen = new Set<string>();
    let up = from;
    while (up !== HUMAN && (removed.has(up) || up === skip) && !seen.has(up)) {
      seen.add(up);
      up = org.roles[up]?.reports_to ?? HUMAN;
    }
    return seen.has(up) ? HUMAN : up;
  };
  // Departments that lose their head.
  const promoted = new Map<string, string>(); // old head → new head
  for (const [id, dept] of Object.entries(org.departments)) {
    if (dropped.has(id) || !removed.has(dept.head)) continue;
    const next = survivors.find((r) => org.roles[r]!.department === id);
    if (!next) {
      dropped.add(id);
      continue;
    }
    heads[id] = next;
    promoted.set(dept.head, next);
    reportsTo[next] = keptFrom(org.roles[dept.head]!.reports_to, next);
  }
  // Everyone else whose manager goes.
  for (const id of survivors) {
    if (reportsTo[id] !== undefined) continue;
    const role = org.roles[id]!;
    if (!removed.has(role.reports_to)) continue;
    const seen = new Set<string>();
    let up = role.reports_to;
    let to: string | null = null;
    while (up !== HUMAN && removed.has(up) && !seen.has(up)) {
      seen.add(up);
      const lead = promoted.get(up);
      if (lead && lead !== id && org.roles[up]!.department === role.department) {
        to = lead;
        break;
      }
      up = org.roles[up]?.reports_to ?? HUMAN;
    }
    reportsTo[id] = to ?? (seen.has(up) ? HUMAN : up);
  }
  return { removed: [...removed], reportsTo, heads, droppedDepartments: [...dropped] };
}

/** The instances only removed roles used: unregistered with them. Never
 *  Claude Code or Codex themselves, nor an agent a remaining role uses. */
export function agentsToUnregister(org: OrgDoc, plan: RemovalPlan, registry: Pick<RegistryService, "get">): string[] {
  const gone = new Set(plan.removed);
  const stillUsed = new Set(
    Object.entries(org.roles)
      .filter(([id]) => !gone.has(id))
      .map(([, r]) => r.agent.toLowerCase()),
  );
  const out: string[] = [];
  for (const id of plan.removed) {
    const agentId = org.roles[id]!.agent;
    if (stillUsed.has(agentId.toLowerCase()) || out.includes(agentId)) continue;
    const agent = registry.get(agentId);
    if (agent && isInstanceAgent(agent)) out.push(agentId);
  }
  return out;
}

/** Remove roles (or a whole department with its roles): org.yaml first, in
 *  one validated write, then the instances no role uses any more. */
export async function removeRoles(
  deps: TeamActionDeps,
  roleIds: readonly string[],
  departments: readonly string[] = [],
): Promise<TeamActionResult> {
  let org: OrgDoc;
  try {
    org = readOrg(deps.orgConfigPath);
  } catch (err) {
    return failed(`Couldn't read org.yaml: ${reason(err)}`);
  }
  const plan = planRemoval(org, roleIds, departments);
  if (plan.removed.length === 0 && plan.droppedDepartments.length === 0) return failed("Nothing to remove.");
  if (plan.removed.length === Object.keys(org.roles).length) {
    return failed("That would remove every role: org.yaml needs at least one. Add another role first (n), or edit org.yaml.");
  }
  try {
    const doc = parseDocument(readFileSync(deps.orgConfigPath, "utf-8"));
    for (const id of plan.removed) doc.deleteIn(["roles", id]);
    for (const [id, to] of Object.entries(plan.reportsTo)) doc.setIn(["roles", id, "reports_to"], to);
    for (const [d, head] of Object.entries(plan.heads)) {
      if (!plan.droppedDepartments.includes(d)) doc.setIn(["departments", d, "head"], head);
    }
    for (const d of plan.droppedDepartments) doc.deleteIn(["departments", d]);
    saveOrgText(deps.orgConfigPath, doc.toString());
  } catch (err) {
    return failed(`org.yaml wasn't changed: ${reason(err)}`);
  }
  const notes: string[] = [];
  const unregistered: string[] = [];
  for (const agentId of agentsToUnregister(org, plan, deps.registry)) {
    let error: string | null;
    try {
      error = await deps.removeAgent(agentId);
    } catch (err) {
      error = reason(err);
    }
    if (error === null) unregistered.push(agentId);
    else notes.push(`couldn't unregister ${agentId}: ${error}`);
  }
  const who = (id: string): string => (id === HUMAN ? "you" : titleOf(org, id));
  const named = departments.filter((d) => org.departments[d]).map((d) => org.departments[d]!.name);
  const what =
    named.length > 0
      ? `${listWords(named)} removed (${plan.removed.length} role${plan.removed.length === 1 ? "" : "s"})`
      : `${listWords(plan.removed.map((id) => titleOf(org, id)))} removed`;
  const moved = Object.entries(plan.reportsTo)
    .filter(([id]) => !Object.values(plan.heads).includes(id))
    .map(([id, to]) => `${titleOf(org, id)} now reports to ${who(to)}`);
  const leads = Object.entries(plan.heads)
    .filter(([d]) => !plan.droppedDepartments.includes(d))
    .map(([d, head]) => `${titleOf(org, head)} leads ${org.departments[d]!.name}`);
  const emptied = plan.droppedDepartments
    .filter((d) => !departments.includes(d))
    .map((d) => `${org.departments[d]!.name} had no roles left and was removed`);
  const parts = [
    what,
    ...leads,
    ...moved,
    ...emptied,
    unregistered.length > 0 ? `unregistered ${listWords(unregistered)}` : null,
    ...notes,
  ].filter(Boolean);
  return notes.length > 0 ? failed(parts.join(" · ")) : done(parts.join(" · "));
}

// -----------------------------------------------------------------------------
// Runtime
// -----------------------------------------------------------------------------

/** The provider whose models `model` is, when Foreman can tell. */
export function modelProvider(model: string): string | null {
  for (const provider of new Set(Object.values(AGENT_PROVIDER))) {
    if (quickModels(provider).some((m) => m.id === model)) return provider;
  }
  const m = model.toLowerCase();
  if (/^(claude|anthropic)|[./]anthropic[./]|^(opus|sonnet|haiku)\b/.test(m)) return "anthropic";
  if (/^(gpt|o\d|codex|chatgpt)/.test(m)) return "openai";
  return null;
}

/** Keep a model override when an agent moves to `runtime`: not when it is
 *  the other provider's model. */
export function modelFitsRuntime(model: string, runtime: string): boolean {
  const provider = modelProvider(model);
  return provider === null || provider === AGENT_PROVIDER[runtime];
}

/** Where `r` sends these roles: the other agent when they all run on one,
 *  else the one after the first's (the department's lead comes first). */
export function switchTarget(runtimes: readonly (string | null)[], available: readonly TeamRuntime[]): TeamRuntime | null {
  const team = runtimes.filter((r): r is TeamRuntime => (TEAM_RUNTIMES as readonly string[]).includes(r ?? ""));
  if (team.length === 0 || available.length < 2) return null;
  const next = nextRuntime(team[0]!, available);
  return next === team[0] ? null : next;
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** Re-register instance `agent` on `target` through the add path, keeping
 *  its id (and so its identity token). What the agent carried over: its
 *  blocked/disabled status, responsibility note, flow role and hand-off
 *  rules, and a model override that fits the new provider. Trust to skip
 *  permission prompts was given to the other program, so it isn't. When
 *  the add fails, the old registration comes back as it was. */
async function reRegister(
  deps: TeamActionDeps,
  agent: RegisteredAgent,
  target: TeamRuntime,
): Promise<{ error: string | null; clearedModel: boolean; lostTrust: boolean }> {
  const { registry } = deps;
  const publicKey = registry.getPublicKey(agent.id);
  const restoreSettings = (a: RegisteredAgent, keepModel: boolean): void => {
    if (keepModel && a.modelVersion) registry.setModelVersion(a.id, a.modelVersion);
    if (a.responsibilityNote) registry.setResponsibilityNote(a.id, a.responsibilityNote);
    if (a.role) registry.setRole(a.id, a.role);
    if (a.handoffRules) registry.setHandoffRules(a.id, a.handoffRules);
    if (a.status === "blocked") registry.block(a.id);
    else if (a.status === "disabled") registry.disable(a.id);
  };
  registry.remove(agent.id);
  let error: string | null;
  try {
    error = await deps.addAgent(agent.id, target);
  } catch (err) {
    error = reason(err);
  }
  if (error === null && !registry.get(agent.id)) error = `${agent.id} wasn't registered`;
  if (error !== null) {
    if (!registry.get(agent.id)) {
      registry.register({
        id: agent.id,
        displayName: agent.displayName,
        transport: agent.transport,
        ...(agent.endpoint ? { endpoint: agent.endpoint } : {}),
        ...(agent.metadata ? { metadata: agent.metadata } : {}),
        ...(publicKey ? { publicKey } : {}),
        ...(agent.llmProvider ? { llmProvider: agent.llmProvider } : {}),
        ...(agent.providerVariant ? { providerVariant: agent.providerVariant } : {}),
      });
      restoreSettings(agent, true);
      if (agent.taskSkipPermissions) registry.setTaskSkipPermissions(agent.id, true);
    }
    return { error, clearedModel: false, lostTrust: false };
  }
  const keepModel = agent.modelVersion ? modelFitsRuntime(agent.modelVersion, target) : false;
  restoreSettings(agent, keepModel);
  return { error: null, clearedModel: Boolean(agent.modelVersion) && !keepModel, lostTrust: agent.taskSkipPermissions };
}

/**
 * Run `roleIds` on `target`. A role on its own instance has that instance
 * re-registered on the other program; a role on Claude Code or Codex
 * itself, or on an instance roles outside `roleIds` share, moves to a new
 * instance named after the role (added the way the Team page adds roles),
 * and org.yaml points it there.
 */
export async function switchRuntime(
  deps: TeamActionDeps,
  roleIds: readonly string[],
  target: TeamRuntime,
): Promise<TeamActionResult> {
  let org: OrgDoc;
  try {
    org = readOrg(deps.orgConfigPath);
  } catch (err) {
    return failed(`Couldn't read org.yaml: ${reason(err)}`);
  }
  const { registry } = deps;
  const set = new Set(roleIds.filter((id) => org.roles[id]));
  const name = TEAM_RUNTIME_NAMES[target];
  const skipped: string[] = [];
  const problems: string[] = [];
  const inPlace = new Map<string, RegisteredAgent>();
  const moves: string[] = [];
  for (const id of set) {
    const role = org.roles[id]!;
    const agent = registry.get(role.agent);
    if (!agent) {
      skipped.push(`${role.title} (${role.agent} isn't registered)`);
      continue;
    }
    const runtime = agentRuntime(agent);
    if (runtime === target) continue;
    if (!(TEAM_RUNTIMES as readonly string[]).includes(runtime)) {
      skipped.push(`${role.title} (it runs on ${agent.displayName}, which can't switch)`);
      continue;
    }
    const shared = Object.entries(org.roles).some(([other, r]) => !set.has(other) && r.agent === agent.id);
    if (isInstanceAgent(agent) && !shared) inPlace.set(agent.id, agent);
    else moves.push(id);
  }
  const switched: string[] = [];
  const cleared: string[] = [];
  const untrusted: string[] = [];
  for (const agent of inPlace.values()) {
    const r = await reRegister(deps, agent, target);
    const titles = [...set].filter((id) => org.roles[id]!.agent === agent.id).map((id) => titleOf(org, id));
    if (r.error !== null) problems.push(`${listWords(titles)} stays as it was: ${r.error}`);
    else {
      switched.push(...titles);
      if (r.clearedModel) cleared.push(agent.id);
      if (r.lostTrust) untrusted.push(agent.id);
    }
  }
  const taken = new Set([...registry.listAll().map((a) => a.id), ...RESERVED_ORG_IDS, ...TEAM_RUNTIMES]);
  const added: Record<string, string> = {};
  for (const id of moves) {
    const agentId = unique(slugify(id), taken);
    let error: string | null;
    try {
      error = await deps.addAgent(agentId, target);
    } catch (err) {
      error = reason(err);
    }
    if (error === null) added[id] = agentId;
    else problems.push(`couldn't add ${agentId} on ${name} for ${titleOf(org, id)}: ${error}`);
  }
  if (Object.keys(added).length > 0) {
    try {
      const doc = parseDocument(readFileSync(deps.orgConfigPath, "utf-8"));
      for (const [id, agentId] of Object.entries(added)) doc.setIn(["roles", id, "agent"], agentId);
      saveOrgText(deps.orgConfigPath, doc.toString());
      switched.push(...Object.keys(added).map((id) => `${titleOf(org, id)} (now ${added[id]})`));
    } catch (err) {
      // Nothing points at the new instances: take them back out.
      for (const agentId of Object.values(added)) {
        try {
          await deps.removeAgent(agentId);
        } catch {
          // reported below as part of the failure
        }
      }
      problems.push(`org.yaml wasn't changed: ${reason(err)}`);
    }
  }
  const parts = [
    switched.length > 0 ? `${listWords(switched)} now run${switched.length === 1 ? "s" : ""} on ${name}` : null,
    cleared.length > 0 ? `model reset to ${name}'s own for ${listWords(cleared)}` : null,
    untrusted.length > 0 ? `trust it again if you want: foreman agent trust ${untrusted[0]}` : null,
    ...skipped.map((s) => `skipped ${s}`),
    ...problems,
  ].filter(Boolean);
  if (parts.length === 0) return done(`Already on ${name}.`);
  return problems.length > 0 || switched.length === 0 ? failed(parts.join(" · ")) : done(parts.join(" · "));
}

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,119}$/;

/** A typed model id, or why it isn't one. */
export function checkModelId(text: string): { model: string } | { error: string } {
  const model = text.trim();
  if (!model) return { error: "Type a model id, like gpt-6-sol." };
  if (!MODEL_RE.test(model)) {
    return { error: "A model id is one word: letters, digits and . _ - : / @ + (like gpt-6-sol)." };
  }
  return { model };
}

/** Roles outside `roleIds` whose agent is one of theirs: a model set for
 *  those agents applies to them too. */
export function sharingRoles(org: OrgDoc, roleIds: readonly string[]): string[] {
  const set = new Set(roleIds);
  const agents = new Set(roleIds.flatMap((id) => (org.roles[id] ? [org.roles[id]!.agent] : [])));
  return Object.entries(org.roles)
    .filter(([id, r]) => !set.has(id) && agents.has(r.agent))
    .map(([, r]) => r.title);
}

/** Set (or, with null, clear) the model of the agents filling `roleIds`.
 *  A role's own `model:` in org.yaml (what `foreman org apply` pushes)
 *  follows, so the two never disagree. */
export async function setRolesModel(
  deps: TeamActionDeps,
  roleIds: readonly string[],
  model: string | null,
): Promise<TeamActionResult> {
  let org: OrgDoc;
  try {
    org = readOrg(deps.orgConfigPath);
  } catch (err) {
    return failed(`Couldn't read org.yaml: ${reason(err)}`);
  }
  if (model !== null) {
    const checked = checkModelId(model);
    if ("error" in checked) return failed(checked.error);
    model = checked.model;
  }
  const ids = roleIds.filter((id) => org.roles[id]);
  const agents = [...new Set(ids.map((id) => org.roles[id]!.agent))];
  const set: string[] = [];
  const skipped: string[] = [];
  for (const agentId of agents) {
    if (!deps.registry.get(agentId)) {
      skipped.push(`${agentId} (not registered)`);
      continue;
    }
    try {
      deps.registry.setModelVersion(agentId, model);
      set.push(agentId);
    } catch (err) {
      skipped.push(`${agentId} (${reason(err)})`);
    }
  }
  const withOwn = ids.filter((id) => org.roles[id]!.model !== undefined && deps.registry.get(org.roles[id]!.agent));
  if (withOwn.length > 0) {
    try {
      const doc = parseDocument(readFileSync(deps.orgConfigPath, "utf-8"));
      for (const id of withOwn) {
        if (model === null) doc.deleteIn(["roles", id, "model"]);
        else doc.setIn(["roles", id, "model"], model);
      }
      saveOrgText(deps.orgConfigPath, doc.toString());
    } catch (err) {
      return failed(`model set, but org.yaml's model: wasn't updated: ${reason(err)}`);
    }
  }
  const titles = ids.filter((id) => set.includes(org.roles[id]!.agent)).map((id) => titleOf(org, id));
  const also = sharingRoles(org, ids.filter((id) => set.includes(org.roles[id]!.agent)));
  const parts = [
    titles.length > 0
      ? `${listWords(titles)}: ${model === null ? "back to the agent's own model" : `model ${model}`}`
      : null,
    also.length > 0 ? `${listWords(also)} too (same agent)` : null,
    skipped.length > 0 ? `skipped ${listWords(skipped)}` : null,
  ].filter(Boolean);
  if (titles.length === 0) return failed(parts.join(" · ") || "Nothing to change.");
  return done(parts.join(" · "));
}
