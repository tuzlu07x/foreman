import { existsSync, readFileSync } from "node:fs";
import { isMap, parseDocument, type Document } from "yaml";
import { RESERVED_ORG_IDS, ROLE_CAPABILITIES, saveOrgText, type RoleCapability } from "../../core/org/org.js";
import {
  DEPARTMENT_PRESETS,
  departmentRolePresets,
  findDepartmentPreset,
  generalRolePresets,
  type RolePreset,
} from "../../core/org/role-library.js";

// =============================================================================
// Setup wizard: "Your team" (optional)
// =============================================================================
//
// After install, give the agents jobs: pick ready-made roles or describe your
// own, each filled by a new Claude Code or Codex instance named after the
// role, with the role's instructions and permissions (org.yaml `can`). Roles
// can be grouped into departments (IT, Marketing… or your own): a
// department's first role leads it, reports to the Manager (or you), and the
// rest of the department reports to that lead. What `foreman org add-role` /
// `add-department` do, from the wizard and the Team page.

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
  | "custom-dept"
  | "dept-pick"
  | "dept-name"
  | "dept-runtime"
  | "company"
  | "applying"
  | "result";

/** A role you described yourself. */
export interface TeamCustomRole {
  title: string;
  instructions: string;
  can: RoleCapability[];
  /** The department it joins (a TeamDepartment key), if any. */
  department?: string;
}

/** A department being set up: a ready-made one or yours. */
export interface TeamDepartment {
  /** `dept:<n>`; stays the same when another department is removed. */
  key: string;
  /** DEPARTMENT_PRESETS id, for a ready-made one. */
  presetId?: string;
  name: string;
  /** What its roles run on, unless one was switched on its own row. */
  runsOn: TeamRuntime;
}

/** One role of the picker: a ready-made role or one of yours. */
export interface TeamChoice {
  /** `preset:<id>`, `custom:<index>` or `dept:<n>:<preset id>`. */
  key: string;
  title: string;
  summary: string;
  instructions: string;
  can: RoleCapability[];
  runsOn: TeamRuntime;
  /** The preset's id, for the role id. */
  presetId?: string;
  /** The department it belongs to (a TeamDepartment key). */
  department?: string;
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
  /** Its department's id in org.yaml. */
  department?: string;
  departmentName?: string;
  /** Leads its department (org.yaml `head`). */
  lead?: boolean;
}

export interface TeamResult {
  added: TeamMember[];
  failed: { title: string; reason: string }[];
  /** Departments written to org.yaml, with the role that leads each. */
  departments: { id: string; name: string; head: string }[];
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

function presetChoice(
  key: string,
  p: RolePreset,
  runsOn: TeamRuntime,
  department?: string,
): TeamChoice {
  return {
    key,
    title: p.title,
    summary: p.summary,
    instructions: p.instructions,
    can: [...p.can],
    runsOn,
    presetId: p.id,
    ...(department ? { department } : {}),
  };
}

/** The picker's roles: the ready-made ones, yours, then each department's. */
export function teamChoices(
  custom: readonly TeamCustomRole[],
  available: readonly TeamRuntime[],
  runsOn: Readonly<Record<string, TeamRuntime>>,
  departments: readonly TeamDepartment[] = [],
): TeamChoice[] {
  const known = new Set(departments.map((d) => d.key));
  const own = (c: TeamCustomRole, i: number, fallback: TeamRuntime, department?: string): TeamChoice => {
    const key = `custom:${i}`;
    return {
      key,
      title: c.title,
      summary: c.instructions || "your own role",
      instructions: c.instructions,
      can: [...c.can],
      runsOn: runtimeFor(runsOn[key] ?? fallback, available),
      ...(department ? { department } : {}),
    };
  };
  const general = generalRolePresets().map((p) => {
    const key = `preset:${p.id}`;
    return presetChoice(key, p, runtimeFor(runsOn[key] ?? p.runsOn, available));
  });
  const yours = custom.flatMap((c, i) =>
    c.department && known.has(c.department) ? [] : [own(c, i, "claude-code")],
  );
  const grouped = departments.flatMap((d) => {
    const preset = d.presetId ? findDepartmentPreset(d.presetId) : undefined;
    const ready = preset
      ? departmentRolePresets(preset).map((p) => {
          const key = `${d.key}:${p.id}`;
          return presetChoice(key, p, runtimeFor(runsOn[key] ?? d.runsOn, available), d.key);
        })
      : [];
    const mine = custom.flatMap((c, i) => (c.department === d.key ? [own(c, i, d.runsOn, d.key)] : []));
    return [...ready, ...mine];
  });
  return [...general, ...yours, ...grouped];
}

/** One row of the picker. */
export type TeamPickRow =
  | { kind: "role"; choice: TeamChoice; lead: boolean }
  | { kind: "department"; department: TeamDepartment; roles: TeamChoice[] }
  | { kind: "own-role" }
  | { kind: "add-department" };

/** The picker's rows: roles on their own, each department (a header, then
 *  its roles, the first picked one marked as lead), then "+ Your own role…"
 *  and "+ Add a department…". */
export function teamPickRows(
  choices: readonly TeamChoice[],
  departments: readonly TeamDepartment[],
  picked: readonly string[],
): TeamPickRow[] {
  const rows: TeamPickRow[] = choices
    .filter((c) => !c.department)
    .map((choice) => ({ kind: "role", choice, lead: false }));
  for (const department of departments) {
    const roles = choices.filter((c) => c.department === department.key);
    rows.push({ kind: "department", department, roles });
    const lead = roles.find((c) => picked.includes(c.key));
    for (const choice of roles) rows.push({ kind: "role", choice, lead: choice === lead });
  }
  rows.push({ kind: "own-role" }, { kind: "add-department" });
  return rows;
}

/** The other runtime, when both are available. */
export function nextRuntime(current: TeamRuntime, available: readonly TeamRuntime[]): TeamRuntime {
  const i = available.indexOf(current);
  return available[(i + 1) % available.length] ?? current;
}

/** What a department's roles run on: one runtime, or "mixed". */
export function departmentRuntime(
  department: TeamDepartment,
  roles: readonly TeamChoice[],
): TeamRuntime | "mixed" {
  const all = new Set(roles.map((r) => r.runsOn));
  if (all.size === 0) return department.runsOn;
  return all.size === 1 ? [...all][0]! : "mixed";
}

/** A new department: its key is one no department has used. */
export function addDepartment(
  departments: readonly TeamDepartment[],
  draft: Omit<TeamDepartment, "key">,
): { departments: TeamDepartment[]; key: string } {
  const used = departments.map((d) => Number(d.key.slice("dept:".length))).filter(Number.isFinite);
  const key = `dept:${Math.max(0, ...used) + 1}`;
  return { departments: [...departments, { ...draft, key }], key };
}

/** What the picker holds; removing a department changes all of it. */
export interface TeamSelection {
  departments: TeamDepartment[];
  custom: TeamCustomRole[];
  picked: string[];
  runsOn: Record<string, TeamRuntime>;
}

/** Remove a department with its roles (yours in it too): the remaining
 *  own roles are renumbered, and what was picked or switched follows them. */
export function removeDepartment(sel: TeamSelection, key: string): TeamSelection {
  const renumber = new Map<string, string>();
  const custom: TeamCustomRole[] = [];
  sel.custom.forEach((c, i) => {
    if (c.department === key) return;
    renumber.set(`custom:${i}`, `custom:${custom.length}`);
    custom.push(c);
  });
  const remap = (k: string): string | null => {
    if (k.startsWith(`${key}:`)) return null;
    if (k.startsWith("custom:")) return renumber.get(k) ?? null;
    return k;
  };
  const runsOn: Record<string, TeamRuntime> = {};
  for (const [k, v] of Object.entries(sel.runsOn)) {
    const to = remap(k);
    if (to) runsOn[to] = v;
  }
  return {
    departments: sel.departments.filter((d) => d.key !== key),
    custom,
    picked: sel.picked.flatMap((k) => {
      const to = remap(k);
      return to ? [to] : [];
    }),
    runsOn,
  };
}

/** Space on a department: pick all its roles, or none when all are picked. */
export function toggleDepartment(
  picked: readonly string[],
  choices: readonly TeamChoice[],
  key: string,
): string[] {
  const roles = choices.filter((c) => c.department === key).map((c) => c.key);
  if (roles.length > 0 && roles.every((k) => picked.includes(k))) {
    return picked.filter((k) => !roles.includes(k));
  }
  return [...picked, ...roles.filter((k) => !picked.includes(k))];
}

/** `r` on a department: every role in it runs on the other agent (or, when
 *  they were mixed, on the one after the department's). */
export function switchDepartmentRuntime(
  departments: readonly TeamDepartment[],
  runsOn: Readonly<Record<string, TeamRuntime>>,
  choices: readonly TeamChoice[],
  key: string,
  available: readonly TeamRuntime[],
): { departments: TeamDepartment[]; runsOn: Record<string, TeamRuntime> } {
  const department = departments.find((d) => d.key === key);
  if (!department) return { departments: [...departments], runsOn: { ...runsOn } };
  const roles = choices.filter((c) => c.department === key);
  const current = departmentRuntime(department, roles);
  const next = nextRuntime(current === "mixed" ? department.runsOn : current, available);
  const nextRunsOn = { ...runsOn };
  for (const r of roles) delete nextRunsOn[r.key];
  return {
    departments: departments.map((d) => (d.key === key ? { ...d, runsOn: next } : d)),
    runsOn: nextRunsOn,
  };
}

/** `Social media!` → `social-media`: a role, agent or department id. */
export function slugify(title: string, fallback = "role"): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : fallback;
}

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The roles to add, with ids free in org.yaml and the registry (and never
 *  a reserved word). With a manager among them, everyone else reports to
 *  the manager; otherwise to `existingManager` (a role already in org.yaml)
 *  when given, else to you. In a department, the first role leads it and
 *  reports as above; the rest of the department reports to its lead.
 *  Department ids are free among departments and roles, old and new. */
export function planTeam(
  picked: readonly TeamChoice[],
  existingRoles: readonly string[],
  registered: readonly string[],
  existingManager?: string,
  departments: readonly TeamDepartment[] = [],
  existingDepartments: readonly string[] = [],
): TeamMember[] {
  const taken = new Set([...existingRoles, ...registered, ...existingDepartments, ...RESERVED_ORG_IDS]);
  const members: TeamMember[] = picked.map((c) => {
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
  const manager = members.find((_, i) => picked[i]!.presetId === "manager" && !picked[i]!.department);
  const boss = manager?.roleId ?? existingManager ?? "human";
  members.forEach((m, i) => {
    if (m !== manager && !picked[i]!.department && manager) m.reportsTo = manager.roleId;
  });
  for (const d of departments) {
    const inDept = members.filter((_, i) => picked[i]!.department === d.key);
    const lead = inDept[0];
    if (!lead) continue;
    const id = unique(d.presetId ?? slugify(d.name, "department"), taken);
    for (const m of inDept) {
      m.department = id;
      m.departmentName = d.name;
      m.reportsTo = m === lead ? boss : lead.roleId;
    }
    lead.lead = true;
  }
  return members;
}

/** Who everyone reports to, for the picker's footer. */
export function reportingLine(
  picked: readonly TeamChoice[],
  departments: readonly TeamDepartment[] = [],
): string {
  const manager = picked.some((c) => c.presetId === "manager" && !c.department);
  const used = departments.filter((d) => picked.some((c) => c.department === d.key));
  if (used.length === 0) {
    return manager ? "Everyone reports to the Manager, who reports to you." : "Everyone reports to you.";
  }
  const boss = manager ? "the Manager" : "you";
  const dept =
    used.length === 1
      ? `${used[0]!.name}'s lead reports to ${boss}; the rest of ${used[0]!.name} reports to its lead.`
      : `Each department's lead reports to ${boss}; the rest report to their lead.`;
  const others = picked.some((c) => !c.department && c.presetId !== "manager");
  const general = manager
    ? others
      ? "Everyone else reports to the Manager, who reports to you."
      : "The Manager reports to you."
    : others
      ? "Everyone else reports to you."
      : "";
  return [dept, general].filter(Boolean).join(" ");
}

/** `Manager (Claude Code), Developer (Codex)`: the roles added, with what
 *  each runs on. */
export function teamRoleList(members: readonly TeamMember[]): string {
  return members.map((m) => `${m.title} (${TEAM_RUNTIME_NAMES[m.runsOn]})`).join(", ");
}

function topLevelKeys(orgConfigPath: string, key: "roles" | "departments"): string[] {
  if (!existsSync(orgConfigPath)) return [];
  try {
    const node = parseDocument(readFileSync(orgConfigPath, "utf-8")).get(key);
    const json: unknown = node && typeof node === "object" && "toJSON" in node ? (node as { toJSON(): unknown }).toJSON() : null;
    return json && typeof json === "object" ? Object.keys(json) : [];
  } catch {
    return [];
  }
}

/** The role ids already in org.yaml, or none when there's no (readable) one. */
export function existingRoleIds(orgConfigPath: string): string[] {
  return topLevelKeys(orgConfigPath, "roles");
}

/** The department ids already in org.yaml. */
export function existingDepartmentIds(orgConfigPath: string): string[] {
  return topLevelKeys(orgConfigPath, "departments");
}

function newOrgText(company: string): string {
  return [
    "# Your team, set up by `foreman setup`. Edit it freely;",
    "# `foreman org validate` checks it and `foreman org show` draws it.",
    "version: 1",
    `company: ${JSON.stringify(company)}`,
    "human:",
    "  title: Owner",
    // `departments:` and `roles:` come with the first entry (block style, not `{}`).
    "",
  ].join("\n");
}

/** Give the document a block `departments:` map, before `roles:`. */
function ensureDepartments(doc: Document): void {
  const root = doc.contents;
  if (!isMap(root)) return;
  const existing = root.get("departments", true);
  if (isMap(existing)) {
    if (existing.items.length === 0) existing.flow = false;
    return;
  }
  const pair = doc.createPair("departments", {});
  if (isMap(pair.value)) pair.value.flow = false;
  const at = root.items.findIndex((p) => {
    const k: unknown = p.key;
    return (k && typeof k === "object" && "value" in k ? (k as { value: unknown }).value : k) === "roles";
  });
  if (at === -1) root.items.push(pair);
  else root.items.splice(at, 0, pair);
}

/**
 * Add the team: each instance first (through `addAgent`), then every role
 * whose instance was added, with its departments, to org.yaml in one
 * validated write. A new org.yaml is created for `company` when there is
 * none. A role whose instance couldn't be added is reported and left out:
 * whoever reported to it reports to its manager instead; a department whose
 * lead failed is led by its first role that was added, and a department
 * with no role added is left out.
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
  const lost = new Map<string, TeamMember>();
  for (const m of members) {
    let error: string | null;
    try {
      error = await deps.addAgent(m.agentId, m.runsOn);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (error === null) added.push({ ...m });
    else {
      failed.push({ title: m.title, reason: error });
      lost.set(m.roleId, m);
    }
  }

  const departments: TeamResult["departments"] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const id = m.department;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const lead = members.find((x) => x.department === id && x.lead) ?? m;
    let head = added.find((x) => x.roleId === lead.roleId);
    if (!head) {
      head = added.find((x) => x.department === id);
      if (!head) continue; // nobody in it was added: no department
      head.lead = true;
      head.reportsTo = lead.reportsTo;
      for (const x of added) if (x !== head && x.reportsTo === lead.roleId) x.reportsTo = head.roleId;
    }
    departments.push({ id, name: m.departmentName ?? id, head: head.roleId });
  }
  // Anyone else reporting to a role that wasn't added reports to its manager.
  for (const m of added) {
    const hops = new Set<string>();
    while (lost.has(m.reportsTo) && !hops.has(m.reportsTo)) {
      hops.add(m.reportsTo);
      m.reportsTo = lost.get(m.reportsTo)!.reportsTo;
    }
  }

  if (added.length === 0) return { added, failed, departments: [], orgError: null };
  try {
    const text = existsSync(deps.orgConfigPath)
      ? readFileSync(deps.orgConfigPath, "utf-8")
      : newOrgText(deps.company.trim() || "My team");
    const doc = parseDocument(text);
    if (departments.length > 0) ensureDepartments(doc);
    for (const d of departments) doc.setIn(["departments", d.id], { name: d.name, head: d.head });
    for (const m of added) {
      doc.setIn(["roles", m.roleId], {
        title: m.title,
        agent: m.agentId,
        ...(m.department ? { department: m.department } : {}),
        reports_to: m.reportsTo,
        ...(m.instructions ? { instructions: m.instructions } : {}),
        can: m.can,
      });
    }
    saveOrgText(deps.orgConfigPath, doc.toString());
  } catch (err) {
    return { added: [], failed, departments: [], orgError: err instanceof Error ? err.message : String(err) };
  }
  return { added, failed, departments, orgError: null };
}

/** Lines `text` takes when wrapped at `width` columns, word by word. */
export function wrappedLines(text: string, width: number): number {
  const w = Math.max(10, width);
  let lines = 1;
  let col = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const len = [...word].length;
    if (col === 0) col = len;
    else if (col + 1 + len <= w) col += 1 + len;
    else {
      lines++;
      col = len;
    }
    while (col > w) {
      lines++;
      col -= w;
    }
  }
  return lines;
}

/** The slice of `total` rows to show in `height` lines with the cursor in
 *  view: when they don't all fit, two of the lines say what's above/below. */
export function scrollWindow(
  total: number,
  cursor: number,
  height: number,
): { start: number; end: number; above: number; below: number } {
  if (total <= height) return { start: 0, end: total, above: 0, below: 0 };
  const size = Math.max(1, height - 2);
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), total - size));
  const end = Math.min(total, start + size);
  return { start, end, above: start, below: total - end };
}

export const CAPABILITY_LABELS: Record<RoleCapability, string> = {
  read: "read files",
  write: "write files",
  shell: "run commands",
  network: "use the web",
};

export { DEPARTMENT_PRESETS, ROLE_CAPABILITIES };
