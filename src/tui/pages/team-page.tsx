import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { type JSX, useEffect, useMemo, useState } from "react";
import { runAgentAddScripted } from "../../cli/agent-add.js";
import { agentDefaultModel } from "../../core/agent-runtime-info.js";
import { AGENT_PROVIDER, quickModels } from "../../core/foreman-command.js";
import { loadOrg, type OrgDoc } from "../../core/org/org.js";
import { getForemanPaths } from "../../utils/config.js";
import { removeAgentAndWiring } from "../agent-removal.js";
import { PageHeader } from "../components/typography.js";
import { useDashboardServices } from "../dashboard-context.js";
import { fitWidth, oneLine } from "../format.js";
import { useTerminalSize } from "../hooks.js";
import {
  applyTeam,
  CAPABILITY_LABELS,
  DEPARTMENT_PRESETS,
  existingDepartmentIds,
  existingRoleIds,
  nextRuntime,
  planTeam,
  ROLE_CAPABILITIES,
  scrollWindow,
  wrappedLines,
  TEAM_RUNTIME_NAMES,
  teamChoices,
  teamRoleList,
  teamRuntimes,
  type TeamChoice,
  type TeamCustomRole,
  type TeamDepartment,
  type TeamResult,
  type TeamRuntime,
} from "../setup-wizard/team-logic.js";
import {
  checkModelId,
  removeRoles,
  setRolesModel,
  sharingRoles,
  switchRuntime,
  switchTarget,
  type TeamActionDeps,
  type TeamActionResult,
} from "../team-actions.js";
import {
  canWords,
  columnNeeds,
  departmentLine,
  NO_DEPARTMENT,
  reportsToWords,
  roleCells,
  rowKey,
  runtimeDisplayName,
  teamCounts,
  teamColumns,
  teamTree,
  type TeamDepartmentRow,
  type TeamRoleInfo,
  type TeamTreeRow,
} from "../team-page-logic.js";
import { isAsciiMode, roundBorder, theme } from "../theme.js";

// =============================================================================
// Team page (hotkey `t`): your org chart by department — who fills each
// role, on what, with which model, what it may do. On a role: `x` removes
// it, `r` switches Claude Code ⇄ Codex, `m` picks its model, Enter shows it
// all; on a department's header the same keys act on all its roles, and
// ←/→ (or Enter) fold it. `n` adds a role and `d` a department (all its
// roles at once), as in the setup wizard's Your team step.
// =============================================================================

/** A department about to be added (no key yet). */
type DeptDraft = Omit<TeamDepartment, "key">;

/** What `x`, `r` or `m` acts on: one role, or a department's roles. */
interface Target {
  roleIds: string[];
  /** "Backend Developer", or "IT" for a department. */
  label: string;
  /** The department (id) when the header was picked; NO_DEPARTMENT for
   *  the roles with none. */
  department?: string;
}

type Op =
  | { kind: "list" }
  | { kind: "details"; roleId: string }
  | {
      kind: "confirm";
      question: string;
      busy: string;
      action: "remove" | "runtime" | "model";
      target: Target;
      run: () => Promise<TeamActionResult>;
    }
  | { kind: "model"; target: Target; cursor: number }
  | { kind: "model-type"; target: Target; error: string | null }
  | { kind: "pick"; cursor: number; runsOn: Record<string, TeamRuntime> }
  | { kind: "dept-pick"; cursor: number }
  | { kind: "dept-name" }
  | { kind: "dept-runtime"; draft: DeptDraft; cursor: number }
  | { kind: "own-title"; department?: DeptDraft }
  | { kind: "own-describe"; draft: TeamCustomRole; department?: DeptDraft }
  | { kind: "own-can"; draft: TeamCustomRole; cursor: number; department?: DeptDraft }
  | { kind: "busy"; label: string };

export interface TeamPageProps {
  onLeave: () => void;
  onEditingChange?: (editing: boolean) => void;
  height: number;
}

interface Loaded {
  org: OrgDoc | null;
  error: string | null;
}

function load(path: string): Loaded {
  try {
    return { org: loadOrg(path), error: null };
  } catch (err) {
    return { org: null, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
}

const DEPT_KEY = "dept:1";

/** What the Team page says after adding: who was added, on what, and who
 *  leads a new department. */
function addedNotice(result: TeamResult): string {
  const m = result.added[0];
  if (!m) return `${theme.symbols.cross} ${result.orgError ?? result.failed[0]?.reason ?? "nothing was added"}`;
  const failed = result.failed.length > 0 ? ` · couldn't add ${result.failed.map((f) => f.title).join(", ")}` : "";
  const d = result.departments[0];
  if (d) {
    const lead = result.added.find((a) => a.roleId === d.head);
    const boss = lead?.reportsTo === "human" ? "you" : (lead?.reportsTo ?? "you");
    return `${theme.symbols.check} ${d.name} added: ${teamRoleList(result.added)} · led by ${d.head}, who reports to ${boss}${failed}`;
  }
  return `${theme.symbols.check} ${m.title} added: runs as ${m.agentId} (${TEAM_RUNTIME_NAMES[m.runsOn]}), reports to ${m.reportsTo === "human" ? "you" : m.reportsTo}${failed}`;
}

/** `3 IT roles`, `the 2 roles with no department`, or the role's title. */
function targetWords(t: Target): string {
  const n = t.roleIds.length;
  if (t.department === undefined) return t.label;
  if (t.department === NO_DEPARTMENT) return `the ${n === 1 ? "role" : `${n} roles`} with no department`;
  return `${n === 1 ? "the" : n} ${t.label} role${n === 1 ? "" : "s"}`;
}

/** One entry of the model picker. */
interface ModelChoice {
  label: string;
  hint?: string;
  /** The model to set; null goes back to the agent's own; undefined asks. */
  model: string | null | undefined;
}

export function TeamPage({ onLeave, onEditingChange, height }: TeamPageProps): JSX.Element {
  const services = useDashboardServices();
  const orgPath = services.orgConfigPath ?? getForemanPaths().orgConfigPath;
  const { cols } = useTerminalSize();
  const [loaded, setLoaded] = useState<Loaded>(() => load(orgPath));
  const [agents, setAgents] = useState(() => services.registry.listAll());
  const [selected, setSelected] = useState<{ key: string | null; index: number }>({ key: null, index: -1 });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [op, setOp] = useState<Op>({ kind: "list" });
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped by each change made here. */
  const [changes, setChanges] = useState(0);

  const reload = (): void => {
    setLoaded(load(orgPath));
    setAgents(services.registry.listAll());
  };

  useEffect(() => {
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [orgPath, services.registry]);

  const typing = op.kind === "own-title" || op.kind === "own-describe" || op.kind === "dept-name" || op.kind === "model-type";
  useEffect(() => {
    onEditingChange?.(op.kind !== "list");
    return () => onEditingChange?.(false);
  }, [op.kind]);

  const runtimes = useMemo(() => teamRuntimes(agents.map((a) => a.id)), [agents]);
  const pageAgents = useMemo(
    () =>
      agents.map((a) => ({
        id: a.id,
        registryId: typeof a.metadata?.registryId === "string" ? a.metadata.registryId : undefined,
        displayName: a.displayName,
        modelVersion: a.modelVersion,
        status: a.status,
      })),
    [agents],
  );
  // Each program's own model (its config's `model`), read again when the
  // programs in use change or after a change here, not on every refresh.
  const programs = [...new Set(pageAgents.map((a) => a.registryId ?? a.id))].sort().join(",");
  const defaults = useMemo(() => {
    const read = services.agentDefaultModel ?? ((r: string) => agentDefaultModel(r));
    const out: Record<string, string | null> = {};
    for (const r of programs.split(",").filter(Boolean)) {
      try {
        out[r] = read(r);
      } catch {
        out[r] = null;
      }
    }
    return out;
  }, [programs, services.agentDefaultModel, changes]);
  const rows = useMemo(
    () => (loaded.org ? teamTree(loaded.org, pageAgents, collapsed, defaults) : []),
    [loaded.org, pageAgents, collapsed, defaults],
  );
  // Every role, folded or not: what x / r / m act on.
  const infoById = useMemo(() => {
    const all = loaded.org ? teamTree(loaded.org, pageAgents, new Set(), defaults) : [];
    return new Map(all.flatMap((r) => (r.kind === "role" ? [[r.key, r.info] as const] : [])));
  }, [loaded.org, pageAgents, defaults]);
  // The cursor follows its row across reloads; a removed row leaves it
  // where it was. It starts on the first role.
  const byKey = selected.key === null ? -1 : rows.findIndex((r) => rowKey(r) === selected.key);
  const firstRole = Math.max(0, rows.findIndex((r) => r.kind === "role"));
  const safe = byKey >= 0 ? byKey : selected.index >= 0 ? Math.min(selected.index, Math.max(0, rows.length - 1)) : firstRole;
  const pick = rows[safe];
  const select = (i: number): void => {
    const row = rows[i];
    setSelected({ key: row ? rowKey(row) : null, index: i });
  };
  const choices = teamChoices([], runtimes, op.kind === "pick" ? op.runsOn : {});

  const addInstance = async (id: string, type: TeamRuntime): Promise<string | null> => {
    if (services.addTeamAgent) return services.addTeamAgent(id, type);
    const errors: string[] = [];
    const code = await runAgentAddScripted(
      id,
      { type },
      { db: services.db, registry: services.registry, log: () => undefined, logError: (l) => errors.push(l) },
    );
    return code === 0 ? null : (errors.at(-1) ?? `couldn't add ${id}`);
  };

  const removeInstance = async (id: string): Promise<string | null> => {
    if (services.removeTeamAgent) return services.removeTeamAgent(id);
    try {
      removeAgentAndWiring(services.registry, services.secretStore, id);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message.split("\n")[0]! : String(err);
    }
  };

  const deps: TeamActionDeps = {
    orgConfigPath: orgPath,
    registry: services.registry,
    addAgent: addInstance,
    removeAgent: removeInstance,
  };

  /** Run a change, then say what happened and show the chart as it is now. */
  const act = (label: string, action: "remove" | "runtime" | "model", target: Target, run: () => Promise<TeamActionResult>): void => {
    setOp({ kind: "busy", label });
    void run()
      .catch((err: unknown): TeamActionResult => ({
        ok: false,
        message: err instanceof Error ? err.message.split("\n")[0]! : String(err),
      }))
      .then((result) => {
        services.audit?.logEvent("team_changed", {
          action,
          roles: target.roleIds,
          ...(target.department !== undefined ? { department: target.department || null } : {}),
          ok: result.ok,
          message: result.message,
        });
        setNotice(`${result.ok ? theme.symbols.check : theme.symbols.cross} ${result.message}`);
        setChanges((n) => n + 1);
        reload();
        setOp({ kind: "list" });
      });
  };

  /** Add the picked roles (and their department) to org.yaml. */
  const addMembers = (picked: TeamChoice[], departments: TeamDepartment[], label: string): void => {
    const roles = existingRoleIds(orgPath);
    const manager = roles.includes("manager") ? "manager" : undefined;
    const members = planTeam(
      picked,
      roles,
      agents.map((a) => a.id),
      manager,
      departments,
      existingDepartmentIds(orgPath),
    );
    setOp({ kind: "busy", label: `Adding ${label}…` });
    void applyTeam(members, { orgConfigPath: orgPath, company: "My team", addAgent: addInstance }).then((result) => {
      setNotice(addedNotice(result));
      reload();
      setOp({ kind: "list" });
    });
  };

  const add = (custom: TeamCustomRole | null, pickKey: string | null, runsOn: Record<string, TeamRuntime>): void => {
    const all = teamChoices(custom ? [custom] : [], runtimes, runsOn);
    const picked = all.filter((c) => (custom ? c.key === "custom:0" : c.key === pickKey));
    addMembers(picked, [], picked[0]?.title ?? "the role");
  };

  /** A whole department: a ready-made one's roles, or yours with its first role. */
  const addDept = (draft: DeptDraft, first: TeamCustomRole | null): void => {
    const department: TeamDepartment = { ...draft, key: DEPT_KEY };
    const custom = first ? [{ ...first, department: DEPT_KEY }] : [];
    const picked = teamChoices(custom, runtimes, {}, [department]).filter((c) => c.department === DEPT_KEY);
    addMembers(picked, [department], draft.name);
  };

  /** Ask which agent runs the department when both are registered. */
  const chooseRuntime = (draft: DeptDraft): void => {
    const runsOn = runtimes.includes(draft.runsOn) ? draft.runsOn : (runtimes[0] ?? draft.runsOn);
    if (runtimes.length < 2) {
      if (draft.presetId) addDept({ ...draft, runsOn }, null);
      else setOp({ kind: "own-title", department: { ...draft, runsOn } });
    } else setOp({ kind: "dept-runtime", draft: { ...draft, runsOn }, cursor: runtimes.indexOf(runsOn) });
  };

  const canAdd = (): boolean => {
    setNotice(null);
    if (runtimes.length === 0) {
      setNotice("Roles run on Claude Code or Codex: add one first (foreman agent add claude-code).");
      return false;
    }
    if (loaded.error) {
      setNotice(`Fix org.yaml first: ${loaded.error}`);
      return false;
    }
    return true;
  };

  // --- x / r / m on the selected row -----------------------------------------

  const roleInfos = (ids: readonly string[]): TeamRoleInfo[] =>
    ids.flatMap((id) => {
      const info = infoById.get(id);
      return info ? [info] : [];
    });

  const targetOf = (row: TeamTreeRow): Target =>
    row.kind === "department"
      ? { roleIds: row.roleIds, label: row.name, department: row.key }
      : { roleIds: [row.key], label: row.info.role.title };

  const onRemove = (row: TeamTreeRow): void => {
    const t = targetOf(row);
    if (t.roleIds.length === 0 && row.kind === "department" && row.key !== NO_DEPARTMENT) {
      // Not in a valid org.yaml (a department's head is one of its roles).
      setNotice(`${theme.symbols.cross} ${row.name} has no roles: edit org.yaml to remove it.`);
      return;
    }
    const dept = row.kind === "department" && row.key !== NO_DEPARTMENT ? [row.key] : [];
    const n = t.roleIds.length;
    const question =
      row.kind === "role"
        ? `Remove ${oneLine(t.label)}?`
        : row.key === NO_DEPARTMENT
          ? `Remove ${targetWords(t)}?`
          : `Remove ${oneLine(t.label)} and its ${n} role${n === 1 ? "" : "s"}?`;
    setNotice(null);
    setOp({
      kind: "confirm",
      question,
      busy: `Removing ${oneLine(t.label)}…`,
      action: "remove",
      target: t,
      run: () => removeRoles(deps, t.roleIds, dept),
    });
  };

  const onSwitch = (row: TeamTreeRow): void => {
    setNotice(null);
    const t = targetOf(row);
    if (runtimes.length < 2) {
      const have = runtimes[0];
      const missing = have === "codex" ? "claude-code" : "codex";
      setNotice(
        have
          ? `${theme.symbols.cross} Only ${TEAM_RUNTIME_NAMES[have]} is set up: add ${missing} first (foreman agent add ${missing}).`
          : `${theme.symbols.cross} Roles run on Claude Code or Codex: add both to switch between them (foreman agent add codex).`,
      );
      return;
    }
    const infos = roleInfos(t.roleIds);
    const target = switchTarget(
      infos.map((i) => i.runtime),
      runtimes,
    );
    if (!target) {
      const why = infos.some((i) => i.registered) ? "doesn't run on Claude Code or Codex" : "has no registered agent to switch";
      setNotice(`${theme.symbols.cross} ${oneLine(t.label)} ${why}.`);
      return;
    }
    const busy = `Moving ${oneLine(t.label)} to ${TEAM_RUNTIME_NAMES[target]}…`;
    const run = (): Promise<TeamActionResult> => switchRuntime(deps, t.roleIds, target);
    if (t.roleIds.length > 1) {
      setOp({
        kind: "confirm",
        question: `Switch ${targetWords(t)} to ${TEAM_RUNTIME_NAMES[target]}?`,
        busy,
        action: "runtime",
        target: t,
        run,
      });
    } else act(busy, "runtime", t, run);
  };

  const onModel = (row: TeamTreeRow): void => {
    setNotice(null);
    const t = targetOf(row);
    const infos = roleInfos(t.roleIds).filter((i) => i.registered);
    if (infos.length === 0) {
      setNotice(`${theme.symbols.cross} ${oneLine(t.label)}: no registered agent to set a model for.`);
      return;
    }
    setOp({ kind: "model", target: t, cursor: 0 });
  };

  /** The picker's entries for `t`: the agent's own model, the provider's
   *  usual ones (when its roles share one provider), then "Type a model…". */
  const modelChoices = (t: Target): ModelChoice[] => {
    const infos = roleInfos(t.roleIds).filter((i) => i.registered);
    const runtimesIn = [...new Set(infos.map((i) => i.runtime ?? ""))];
    const providers = [...new Set(runtimesIn.map((r) => AGENT_PROVIDER[r] ?? ""))];
    const one = runtimesIn.length === 1 ? runtimesIn[0]! : null;
    const own = one ? defaults[one] : null;
    const first: ModelChoice = {
      label: one ? `Default (${runtimeDisplayName(one)}'s own setting)` : "Default (each agent's own setting)",
      ...(own ? { hint: own } : {}),
      model: null,
    };
    const provider = providers.length === 1 ? providers[0]! : "";
    const quick = provider ? quickModels(provider).map((m) => ({ label: m.id, hint: m.hint, model: m.id })) : [];
    return [first, ...quick, { label: "Type a model…", model: undefined }];
  };

  const applyModel = (t: Target, model: string | null): void => {
    const what = model ?? "the agent's own model";
    const busy = `Setting ${oneLine(t.label)}'s model…`;
    const run = (): Promise<TeamActionResult> => setRolesModel(deps, t.roleIds, model);
    if (t.roleIds.length > 1) {
      setOp({ kind: "confirm", question: `Set ${what} for ${targetWords(t)}?`, busy, action: "model", target: t, run });
    } else act(busy, "model", t, run);
  };

  useInput((input, key) => {
    if (op.kind === "busy" || typing) {
      if (typing && key.escape) setOp(op.kind === "model-type" ? { kind: "model", target: op.target, cursor: 0 } : { kind: "list" });
      return;
    }
    if (op.kind === "confirm") {
      if (input === "y" || input === "Y") act(op.busy, op.action, op.target, op.run);
      else if (input === "n" || input === "N" || key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "details") {
      if (key.escape || key.return) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "model") {
      const options = modelChoices(op.target);
      const n = options.length;
      if (key.upArrow) setOp({ ...op, cursor: (op.cursor + n - 1) % n });
      else if (key.downArrow) setOp({ ...op, cursor: (op.cursor + 1) % n });
      else if (key.return) {
        const chosen = options[op.cursor];
        if (!chosen) return;
        if (chosen.model === undefined) setOp({ kind: "model-type", target: op.target, error: null });
        else applyModel(op.target, chosen.model);
      } else if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "own-can") {
      const n = ROLE_CAPABILITIES.length;
      if (key.upArrow) setOp({ ...op, cursor: (op.cursor + n - 1) % n });
      else if (key.downArrow) setOp({ ...op, cursor: (op.cursor + 1) % n });
      else if (input === " ") {
        const cap = ROLE_CAPABILITIES[op.cursor]!;
        const can = op.draft.can.includes(cap) ? op.draft.can.filter((c) => c !== cap) : [...op.draft.can, cap];
        setOp({ ...op, draft: { ...op.draft, can: ROLE_CAPABILITIES.filter((c) => can.includes(c)) } });
      } else if (key.return) {
        if (op.department) addDept(op.department, op.draft);
        else add(op.draft, null, {});
      } else if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "dept-pick") {
      const count = DEPARTMENT_PRESETS.length + 1;
      if (key.upArrow) setOp({ ...op, cursor: (op.cursor + count - 1) % count });
      else if (key.downArrow) setOp({ ...op, cursor: (op.cursor + 1) % count });
      else if (key.return) {
        const preset = DEPARTMENT_PRESETS[op.cursor];
        if (preset) chooseRuntime({ presetId: preset.id, name: preset.name, runsOn: preset.runsOn });
        else setOp({ kind: "dept-name" });
      } else if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "dept-runtime") {
      const count = runtimes.length;
      if (key.upArrow) setOp({ ...op, cursor: (op.cursor + count - 1) % count });
      else if (key.downArrow) setOp({ ...op, cursor: (op.cursor + 1) % count });
      else if (key.return) {
        const draft = { ...op.draft, runsOn: runtimes[op.cursor] ?? op.draft.runsOn };
        if (draft.presetId) addDept(draft, null);
        else setOp({ kind: "own-title", department: draft });
      } else if (key.escape) setOp({ kind: "dept-pick", cursor: 0 });
      return;
    }
    if (op.kind === "pick") {
      // The roles, then "+ Your own role…" and "+ Add a department…".
      const count = choices.length + 2;
      const focused = choices[op.cursor];
      if (key.upArrow) setOp({ ...op, cursor: (op.cursor + count - 1) % count });
      else if (key.downArrow) setOp({ ...op, cursor: (op.cursor + 1) % count });
      else if (input === "r" && focused && runtimes.length > 1) {
        setOp({ ...op, runsOn: { ...op.runsOn, [focused.key]: nextRuntime(focused.runsOn, runtimes) } });
      } else if (key.return) {
        if (focused) add(null, focused.key, op.runsOn);
        else if (op.cursor === choices.length) setOp({ kind: "own-title" });
        else setOp({ kind: "dept-pick", cursor: 0 });
      } else if (key.escape) setOp({ kind: "list" });
      return;
    }
    // list
    const fold = (row: TeamDepartmentRow, shut: boolean): void => {
      const next = new Set(collapsed);
      if (shut) next.add(row.key);
      else next.delete(row.key);
      setCollapsed(next);
      setSelected({ key: rowKey(row), index: safe });
    };
    if (key.escape) onLeave();
    else if (key.upArrow) select(Math.max(0, safe - 1));
    else if (key.downArrow) select(Math.min(rows.length - 1, safe + 1));
    else if (input === "n") {
      if (canAdd()) setOp({ kind: "pick", cursor: 0, runsOn: {} });
    } else if (input === "d") {
      if (canAdd()) setOp({ kind: "dept-pick", cursor: 0 });
    } else if (!pick) return;
    else if (key.leftArrow) {
      if (pick.kind === "department") fold(pick, true);
      else {
        // To its department's header.
        const header = rows.findIndex((r) => r.kind === "department" && r.key === pick.department);
        if (header >= 0) select(header);
      }
    } else if (key.rightArrow) {
      if (pick.kind === "department") fold(pick, false);
    } else if (key.return) {
      if (pick.kind === "department") fold(pick, !pick.collapsed);
      else setOp({ kind: "details", roleId: pick.key });
    } else if (input === "x") onRemove(pick);
    else if (input === "r") onSwitch(pick);
    else if (input === "m") onModel(pick);
  });

  const frame = (children: JSX.Element): JSX.Element => (
    <Box flexDirection="column" borderStyle={roundBorder()} borderDimColor paddingX={1} flexGrow={1}>
      {children}
    </Box>
  );
  const option = (label: string, focused: boolean, hint?: string): JSX.Element => (
    <Text key={label} wrap="truncate-end">
      <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
        {focused ? `${theme.symbols.cursor} ` : "  "}
        {hint ? `${label}  `.padEnd(24) : label}
      </Text>
      {hint ? <Text color={theme.fg.muted}>{hint}</Text> : null}
    </Text>
  );

  if (op.kind === "busy") {
    return frame(
      <>
        <PageHeader title="Team" />
        <Text color={theme.fg.muted}>
          {theme.symbols.loading} {op.label}
        </Text>
      </>,
    );
  }

  if (op.kind === "details" && loaded.org) {
    const org = loaded.org;
    const info = roleInfos([op.roleId])[0];
    if (info) {
      const role = info.role;
      const dept = role.department ? org.departments[role.department] : undefined;
      const reports = Object.entries(org.roles)
        .filter(([, r]) => r.reports_to === op.roleId)
        .map(([, r]) => r.title);
      const line = (label: string, value: string): JSX.Element => (
        <Text key={label} wrap="truncate-end">
          <Text color={theme.fg.muted}>{label.padEnd(12)}</Text>
          {oneLine(value)}
        </Text>
      );
      return frame(
        <>
          <PageHeader title="Team" subtitle={oneLine(role.title)} right={`role ${info.roleId}`} />
          <Box flexDirection="column" marginTop={1}>
            {line("Department", dept ? `${dept.name}${info.head ? " (leads it)" : ""}` : "none")}
            {line("Reports to", reportsToWords(org, role))}
            {line("Its reports", reports.length > 0 ? reports.join(", ") : "none")}
            {line(
              "Runs as",
              info.registered
                ? `${info.agentId} · ${info.runsOn ?? ""}${info.instance ? " (its own instance)" : ""}${info.status ? ` · ${info.status}` : ""}`
                : `${info.agentId} (not registered: foreman agent add ${info.agentId})`,
            )}
            {line("Model", info.model.text)}
            {line("May", canWords(role))}
          </Box>
          <Box marginTop={1}>
            <Text wrap="wrap" color={theme.fg.muted}>
              {oneLine(role.instructions ?? role.responsibility ?? "No instructions: it works from the task it's given.")}
            </Text>
          </Box>
          <Text color={theme.fg.muted}>[Esc] back</Text>
        </>,
      );
    }
  }

  if (op.kind === "model" || op.kind === "model-type") {
    const t = op.target;
    const org = loaded.org;
    const infos = roleInfos(t.roleIds).filter((i) => i.registered);
    const now = infos.length === 1 ? infos[0]!.model.text : null;
    const also = org ? sharingRoles(org, infos.map((i) => i.roleId)) : [];
    const inSet = new Set(infos.map((i) => i.roleId));
    const agentsIn = [...new Set(infos.map((i) => i.agentId))].filter((a) =>
      Object.entries(org?.roles ?? {}).some(([id, r]) => !inSet.has(id) && r.agent === a),
    );
    return frame(
      <>
        <PageHeader title="Team" subtitle={`model for ${targetWords(t)}`} />
        {now ? <Text color={theme.fg.muted} wrap="truncate-end">now: {oneLine(now)}</Text> : null}
        {also.length > 0 ? (
          <Text color={theme.accent.warning} wrap="truncate-end">
            {oneLine(`${agentsIn.join(", ")} also run${agentsIn.length === 1 ? "s" : ""} ${also.join(", ")}: the model changes there too.`)}
          </Text>
        ) : null}
        {op.kind === "model" ? (
          <>
            <Box flexDirection="column" marginTop={1}>
              {modelChoices(t).map((c, i) => option(c.label, i === op.cursor, c.hint))}
            </Box>
            <Text color={theme.fg.muted}>[↑↓] move · [Enter] use it · [Esc] cancel</Text>
          </>
        ) : (
          <>
            <Text color={theme.fg.muted}>A model id the agent knows, like gpt-6-sol or claude-sonnet-5.</Text>
            <TextInput
              key="model-type"
              placeholder="gpt-6-sol"
              onSubmit={(value) => {
                const checked = checkModelId(value);
                if ("error" in checked) setOp({ ...op, error: checked.error });
                else applyModel(t, checked.model);
              }}
            />
            {op.error ? <Text color={theme.accent.danger}>{theme.symbols.cross} {op.error}</Text> : null}
            <Text color={theme.fg.muted}>[Enter] use it · [Esc] back</Text>
          </>
        )}
      </>,
    );
  }

  if (op.kind === "dept-pick") {
    return frame(
      <>
        <PageHeader title="Team" subtitle="add a department" />
        <Text color={theme.fg.muted}>
          All its roles are added at once. Its first role leads it and reports to the Manager (or you); the rest report to the lead.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {DEPARTMENT_PRESETS.map((d, i) =>
            option(d.name, i === op.cursor, `${d.summary} · ${TEAM_RUNTIME_NAMES[runtimes.includes(d.runsOn) ? d.runsOn : (runtimes[0] ?? d.runsOn)]}`),
          )}
          {option("Your own department…", op.cursor === DEPARTMENT_PRESETS.length)}
        </Box>
        <Text color={theme.fg.muted}>[↑↓] move · [Enter] add · [Esc] cancel</Text>
      </>,
    );
  }

  if (op.kind === "dept-name") {
    return frame(
      <>
        <PageHeader title="Team" subtitle="your own department" />
        <Text color={theme.fg.muted}>A name, like &quot;Sales&quot;, &quot;Design&quot; or &quot;Operations&quot;. Its first role comes next.</Text>
        <TextInput
          key="dept-name"
          placeholder="Sales"
          onSubmit={(value) => {
            const name = value.trim().slice(0, 80);
            if (name) chooseRuntime({ name, runsOn: runtimes[0] ?? "claude-code" });
          }}
        />
        <Text color={theme.fg.muted}>[Enter] next · [Esc] cancel</Text>
      </>,
    );
  }

  if (op.kind === "dept-runtime") {
    const name = op.draft.name;
    return frame(
      <>
        <PageHeader title="Team" subtitle={`which agent runs ${name}?`} />
        <Text color={theme.fg.muted}>Every {name} role runs as its own instance of it.</Text>
        <Box flexDirection="column" marginTop={1}>
          {runtimes.map((r, i) => option(TEAM_RUNTIME_NAMES[r], i === op.cursor))}
        </Box>
        <Text color={theme.fg.muted}>[↑↓] move · [Enter] add {name} · [Esc] back</Text>
      </>,
    );
  }

  if (op.kind === "own-title" || op.kind === "own-describe") {
    const titleStep = op.kind === "own-title";
    const dept = op.department;
    return frame(
      <>
        <PageHeader title="Team" subtitle={dept ? `${dept.name}'s first role (it leads ${dept.name})` : "your own role"} />
        <Text color={theme.fg.muted}>
          {titleStep
            ? 'A short job title, like "Chores", "Social media" or "Release manager".'
            : `What should ${op.kind === "own-describe" ? op.draft.title : "it"} do? The agent is told this when it gets work.`}
        </Text>
        <TextInput
          key={op.kind}
          placeholder={titleStep ? "Chores" : "Tidy the issue tracker: label new issues, close duplicates."}
          onSubmit={(value) => {
            const v = value.trim();
            if (op.kind === "own-title") {
              if (v) {
                setOp({
                  kind: "own-describe",
                  draft: { title: v.slice(0, 80), instructions: "", can: ["read"] },
                  ...(dept ? { department: dept } : {}),
                });
              }
            } else {
              setOp({
                kind: "own-can",
                draft: { ...op.draft, instructions: v.slice(0, 4000) },
                cursor: 0,
                ...(dept ? { department: dept } : {}),
              });
            }
          }}
        />
        <Text color={theme.fg.muted}>[Enter] next · [Esc] cancel</Text>
      </>,
    );
  }

  if (op.kind === "own-can") {
    const runsOn = op.department?.runsOn ?? (runtimes.includes("claude-code") ? "claude-code" : "codex");
    return frame(
      <>
        <PageHeader title="Team" subtitle={`what may ${op.draft.title} do?`} />
        <Text color={theme.fg.muted}>Anything not ticked is refused, whatever your policy allows.</Text>
        {ROLE_CAPABILITIES.map((cap, i) => {
          const focused = i === op.cursor;
          return (
            <Text key={cap} color={focused ? theme.accent.primary : undefined} bold={focused}>
              {focused ? `${theme.symbols.cursor} ` : "  "}[{op.draft.can.includes(cap) ? theme.symbols.check : " "}]{" "}
              {CAPABILITY_LABELS[cap]}
            </Text>
          );
        })}
        <Text color={theme.fg.muted}>
          [↑↓] move · [Space] tick · [Enter] add{op.department ? ` ${op.department.name}` : ""} on {TEAM_RUNTIME_NAMES[runsOn]} · [Esc]
          cancel
        </Text>
      </>,
    );
  }

  if (op.kind === "pick") {
    const both = runtimes.length > 1;
    return frame(
      <>
        <PageHeader title="Team" subtitle="add a role" />
        <Box flexDirection="column" marginTop={1}>
          {choices.map((c, i) => {
            const focused = i === op.cursor;
            return (
              <Text key={c.key} wrap="truncate-end">
                <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
                  {focused ? `${theme.symbols.cursor} ` : "  "}
                  {c.title.slice(0, 16).padEnd(17)}
                </Text>
                <Text color={focused && both ? theme.accent.info : undefined} bold={focused && both}>
                  {TEAM_RUNTIME_NAMES[c.runsOn].padEnd(12)}
                </Text>
                <Text color={theme.fg.muted}>
                  · may {c.can.join(", ")} · {c.summary}
                </Text>
              </Text>
            );
          })}
          {option("+ Your own role…", op.cursor === choices.length)}
          {option("+ Add a department…", op.cursor === choices.length + 1)}
        </Box>
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] add{both ? " · [r] Claude Code ⇄ Codex" : ""} · [Esc] cancel
        </Text>
      </>,
    );
  }

  // list (and a confirm question under it)
  const org = loaded.org;
  // Inside the border and its padding, then the cursor's two columns.
  const inner = Math.max(24, cols - 4);
  const rowWidth = inner - 2;
  // Columns sized for every role, folded or not, so folding doesn't move them.
  const columns = teamColumns(rowWidth, columnNeeds([...infoById.values()]));
  const both = runtimes.length > 1;
  const switchWord = (row: TeamTreeRow): string | null => {
    if (!both) return null;
    const t = switchTarget(
      roleInfos(targetOf(row).roleIds).map((i) => i.runtime),
      runtimes,
    );
    return t ? TEAM_RUNTIME_NAMES[t] : null;
  };
  const keys = (() => {
    // What acts on the selection; n, d and Esc are on the status bar.
    if (!pick) return "[n] add a role · [d] add a department";
    const to = switchWord(pick);
    if (pick.kind === "department") {
      const dept = oneLine(pick.name);
      const name = pick.key === NO_DEPARTMENT ? "them" : `all of ${dept}`;
      return [
        "[↑↓] move",
        `[←→] ${pick.collapsed ? "open" : "fold"}`,
        `[x] remove ${pick.key === NO_DEPARTMENT ? "these roles" : dept}`,
        to ? `[r] ${name} → ${to}` : null,
        `[m] model for ${name}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    return ["[↑↓] move · [Enter] details · [x] remove", to ? `[r] → ${to}` : null, "[m] model · [←] its department"]
      .filter(Boolean)
      .join(" · ");
  })();
  // Border (2), header (2), top margin and "you" (2), then under the rows
  // either the details (margin + 3) and the keys, or the question (margin
  // + 1); a notice or an org.yaml error takes a line each. The rest is rows.
  const below =
    op.kind === "confirm" ? 2 : 4 + wrappedLines(keys, inner) + (notice ? 1 : 0);
  const view = scrollWindow(rows.length, safe, Math.max(3, height - 6 - below - (loaded.error ? 1 : 0)));
  const folded = isAsciiMode() ? "+" : "▸";
  const open = isAsciiMode() ? "-" : "▾";
  const renderRow = (r: TeamTreeRow, i: number): JSX.Element => {
    const focused = i === safe;
    const pointer = focused ? `${theme.symbols.cursor} ` : "  ";
    if (r.kind === "department") {
      return (
        <Text key={rowKey(r)} wrap="truncate-end" color={focused ? theme.accent.primary : undefined} bold>
          {pointer}
          {fitWidth(`${r.collapsed ? folded : open} ${oneLine(departmentLine(r))}`, rowWidth)}
        </Text>
      );
    }
    const c = roleCells(r.info, rowWidth, columns);
    const tone = r.info.registered ? (r.info.status ? theme.accent.warning : theme.accent.info) : theme.accent.warning;
    return (
      <Text key={rowKey(r)} wrap="truncate-end">
        <Text color={focused ? theme.accent.primary : undefined}>{pointer}</Text>
        <Text color={theme.fg.muted}>{c.prefix}</Text>
        <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
          {c.title}
        </Text>
        <Text color={theme.fg.muted}>{c.id}</Text>
        <Text color={tone}>{c.runtime}</Text>
        <Text color={r.info.model.source === "set-here" ? undefined : theme.fg.muted}>{c.model}</Text>
      </Text>
    );
  };
  const details = (): JSX.Element | null => {
    if (!org || !pick) return null;
    if (pick.kind === "department") {
      const infos = roleInfos(pick.roleIds);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text bold>{oneLine(pick.name)}</Text>
            <Text color={theme.fg.muted}>
              {" "}
              · {pick.key === NO_DEPARTMENT ? "roles in no department" : `department ${pick.key}`}
              {pick.head ? oneLine(` · led by ${pick.head}`) : ""}
            </Text>
          </Text>
          <Text wrap="truncate-end" color={theme.fg.muted}>
            Roles: {infos.length > 0 ? oneLine(infos.map((i) => i.role.title).join(", ")) : "none"}
          </Text>
          <Text wrap="truncate-end" color={theme.fg.muted}>
            x, r and m act on all of its roles.
          </Text>
        </Box>
      );
    }
    const info = pick.info;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          <Text bold>{oneLine(info.role.title)}</Text>
          <Text color={theme.fg.muted}>
            {" "}
            · role {info.roleId} · reports to {reportsToWords(org, info.role)}
            {info.role.department ? oneLine(` · ${info.head ? "leads " : ""}${org.departments[info.role.department]?.name ?? info.role.department}`) : ""}
          </Text>
        </Text>
        <Text wrap="truncate-end" color={theme.fg.muted}>
          May: {canWords(info.role)}
        </Text>
        <Text wrap="truncate-end" color={theme.fg.muted}>
          {info.registered
            ? oneLine(info.role.instructions ?? info.role.responsibility ?? "No instructions: it works from the task it's given.")
            : `${info.agentId} isn't registered: foreman agent add ${info.agentId}`}
        </Text>
      </Box>
    );
  };
  return frame(
    <>
      <PageHeader title="Team" subtitle={org ? oneLine(org.company) : undefined} right={org ? teamCounts(org) : undefined} />
      {loaded.error ? (
        <Text color={theme.accent.danger}>
          {theme.symbols.cross} org.yaml doesn&apos;t parse: {loaded.error} (foreman org validate)
        </Text>
      ) : null}
      {!org && !loaded.error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>No team yet.</Text>
          <Text color={theme.fg.muted}>
            Give your agents jobs: press n to add a role (a manager, a developer, a code reviewer… or your own), or d to add a
            department (IT, Marketing, Customer Support… or your own), each role on its own Claude Code or Codex with only the
            permissions it needs.
          </Text>
          <Text color={theme.fg.muted}>Or start from a template: foreman org init --template startup</Text>
        </Box>
      ) : null}
      {org ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.fg.muted}>you{org.human.title ? ` (${oneLine(org.human.title)})` : ""}</Text>
          {view.above > 0 ? <Text color={theme.fg.muted}>{`  ↑ ${view.above} more`}</Text> : null}
          {rows.slice(view.start, view.end).map((r, i) => renderRow(r, view.start + i))}
          {view.below > 0 ? <Text color={theme.fg.muted}>{`  ↓ ${view.below} more`}</Text> : null}
          {rows.length === 0 ? <Text color={theme.fg.muted}>No roles yet: press n to add one, or d for a department.</Text> : null}
        </Box>
      ) : null}
      {op.kind === "confirm" ? null : details()}
      {op.kind === "confirm" ? (
        <Box marginTop={1}>
          <Text wrap="truncate-end" color={theme.accent.warning} bold>
            {op.question} y / n
          </Text>
        </Box>
      ) : notice ? (
        <Text wrap="truncate-end" color={notice.startsWith(theme.symbols.cross) ? theme.accent.danger : theme.accent.success}>
          {notice}
        </Text>
      ) : null}
      {op.kind === "confirm" ? null : <Text color={theme.fg.muted}>{keys}</Text>}
    </>,
  );
}
