import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { ROLE_CAPABILITIES, saveOrgText, type RoleCapability } from "../../core/org/org.js";
import { ROLE_PRESETS, type RolePreset } from "../../core/org/role-library.js";

// =============================================================================
// Setup wizard: "Your team" (optional)
// =============================================================================
//
// After install, give the agents jobs: pick ready-made roles or describe your
// own, each filled by a new Claude Code or Codex instance named after the
// role, with the role's instructions and permissions (org.yaml `can`). What
// `foreman org add-role <id> --preset … --runs-on …` does, from the wizard.

/** The agents a role can run on: only these run as several agents. */
export const TEAM_RUNTIMES = ["claude-code", "codex"] as const;
export type TeamRuntime = (typeof TEAM_RUNTIMES)[number];

export const TEAM_RUNTIME_NAMES: Record<TeamRuntime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export type TeamPhase =
  | "pick"
  | "custom-title"
  | "custom-describe"
  | "custom-can"
  | "company"
  | "applying"
  | "result";

/** A role you described yourself. */
export interface TeamCustomRole {
  title: string;
  instructions: string;
  can: RoleCapability[];
}

/** One row of the picker: a ready-made role or one of yours. */
export interface TeamChoice {
  /** `preset:<id>` or `custom:<index>`. */
  key: string;
  title: string;
  summary: string;
  instructions: string;
  can: RoleCapability[];
  runsOn: TeamRuntime;
  /** The preset's id, for the role id. */
  presetId?: string;
}

/** A role the wizard will add: its role id, the instance that fills it. */
export interface TeamMember {
  roleId: string;
  agentId: string;
  title: string;
  instructions: string;
  can: RoleCapability[];
  runsOn: TeamRuntime;
  reportsTo: string;
}

export interface TeamResult {
  added: TeamMember[];
  failed: { title: string; reason: string }[];
  /** Set when org.yaml couldn't be written: nothing was added to it. */
  orgError: string | null;
}

/** Claude Code and Codex, when registered: what roles can run on. */
export function teamRuntimes(registered: readonly string[]): TeamRuntime[] {
  return TEAM_RUNTIMES.filter((r) => registered.includes(r));
}

function runtimeFor(preferred: TeamRuntime, available: readonly TeamRuntime[]): TeamRuntime {
  return available.includes(preferred) ? preferred : (available[0] ?? preferred);
}

/** The picker rows: every ready-made role, then yours. */
export function teamChoices(
  custom: readonly TeamCustomRole[],
  available: readonly TeamRuntime[],
  runsOn: Readonly<Record<string, TeamRuntime>>,
): TeamChoice[] {
  const presets = ROLE_PRESETS.map((p: RolePreset) => {
    const key = `preset:${p.id}`;
    return {
      key,
      title: p.title,
      summary: p.summary,
      instructions: p.instructions,
      can: [...p.can],
      runsOn: runtimeFor(runsOn[key] ?? p.runsOn, available),
      presetId: p.id,
    };
  });
  const yours = custom.map((c, i) => {
    const key = `custom:${i}`;
    return {
      key,
      title: c.title,
      summary: c.instructions || "your own role",
      instructions: c.instructions,
      can: [...c.can],
      runsOn: runtimeFor(runsOn[key] ?? "claude-code", available),
    };
  });
  return [...presets, ...yours];
}

/** The other runtime, when both are available. */
export function nextRuntime(current: TeamRuntime, available: readonly TeamRuntime[]): TeamRuntime {
  const i = available.indexOf(current);
  return available[(i + 1) % available.length] ?? current;
}

/** `Social media!` → `social-media`: a role and agent id. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : "role";
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The roles to add, with ids free in org.yaml and the registry. With a
 *  manager among them, everyone else reports to the manager; otherwise to
 *  `existingManager` (a role already in org.yaml) when given, else to you. */
export function planTeam(
  picked: readonly TeamChoice[],
  existingRoles: readonly string[],
  registered: readonly string[],
  existingManager?: string,
): TeamMember[] {
  const taken = new Set([...existingRoles, ...registered]);
  const members = picked.map((c) => {
    const id = unique(c.presetId ?? slugify(c.title), taken);
    return {
      roleId: id,
      agentId: id,
      title: c.title,
      instructions: c.instructions,
      can: c.can,
      runsOn: c.runsOn,
      reportsTo: existingManager ?? "human",
    };
  });
  const manager = members.find((m, i) => picked[i]!.presetId === "manager");
  if (manager) {
    for (const m of members) if (m !== manager) m.reportsTo = manager.roleId;
  }
  return members;
}

/** Who everyone reports to, for the picker's footer. */
export function reportingLine(picked: readonly TeamChoice[]): string {
  return picked.some((c) => c.presetId === "manager")
    ? "Everyone reports to the Manager, who reports to you."
    : "Everyone reports to you.";
}

/** The role ids already in org.yaml, or none when there's no (readable) one. */
export function existingRoleIds(orgConfigPath: string): string[] {
  if (!existsSync(orgConfigPath)) return [];
  try {
    const roles = parseDocument(readFileSync(orgConfigPath, "utf-8")).get("roles");
    const json: unknown = roles && typeof roles === "object" && "toJSON" in roles ? (roles as { toJSON(): unknown }).toJSON() : null;
    return json && typeof json === "object" ? Object.keys(json) : [];
  } catch {
    return [];
  }
}

function newOrgText(company: string): string {
  return [
    "# Your team, set up by `foreman setup`. Edit it freely;",
    "# `foreman org validate` checks it and `foreman org show` draws it.",
    "version: 1",
    `company: ${JSON.stringify(company)}`,
    "human:",
    "  title: Owner",
    // `roles:` comes with the first role (block style, not `{}`).
    "",
  ].join("\n");
}

/**
 * Add the team: each instance first (through `addAgent`), then every role
 * whose instance was added, to org.yaml in one validated write. A new
 * org.yaml is created for `company` when there is none. A role whose
 * instance couldn't be added is reported and left out.
 */
export async function applyTeam(
  members: readonly TeamMember[],
  deps: {
    orgConfigPath: string;
    company: string;
    addAgent: (agentId: string, runsOn: TeamRuntime) => Promise<string | null>;
  },
): Promise<TeamResult> {
  const added: TeamMember[] = [];
  const failed: TeamResult["failed"] = [];
  for (const m of members) {
    let error: string | null;
    try {
      error = await deps.addAgent(m.agentId, m.runsOn);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error === null) added.push(m);
    else failed.push({ title: m.title, reason: error });
  }
  if (added.length === 0) return { added, failed, orgError: null };
  try {
    const text = existsSync(deps.orgConfigPath)
      ? readFileSync(deps.orgConfigPath, "utf-8")
      : newOrgText(deps.company.trim() || "My team");
    const doc = parseDocument(text);
    for (const m of added) {
      doc.setIn(["roles", m.roleId], {
        title: m.title,
        agent: m.agentId,
        reports_to: m.reportsTo,
        ...(m.instructions ? { instructions: m.instructions } : {}),
        can: m.can,
      });
    }
    saveOrgText(deps.orgConfigPath, doc.toString());
  } catch (err) {
    return { added: [], failed, orgError: err instanceof Error ? err.message : String(err) };
  }
  return { added, failed, orgError: null };
}

export const CAPABILITY_LABELS: Record<RoleCapability, string> = {
  read: "read files",
  write: "write files",
  shell: "run commands",
  network: "use the web",
};

export { ROLE_CAPABILITIES };
