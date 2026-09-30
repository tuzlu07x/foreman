import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { type JSX, useEffect, useMemo, useState } from "react";
import { runAgentAddScripted } from "../../cli/agent-add.js";
import { loadOrg, type OrgDoc } from "../../core/org/org.js";
import { getForemanPaths } from "../../utils/config.js";
import { PageHeader } from "../components/typography.js";
import { useDashboardServices } from "../dashboard-context.js";
import { oneLine } from "../format.js";
import {
  applyTeam,
  CAPABILITY_LABELS,
  DEPARTMENT_PRESETS,
  existingDepartmentIds,
  existingRoleIds,
  nextRuntime,
  planTeam,
  ROLE_CAPABILITIES,
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
import { canWords, reportsToWords, teamCounts, teamRows } from "../team-page-logic.js";
import { roundBorder, theme } from "../theme.js";

// =============================================================================
// Team page (hotkey `t`): your org chart — who fills each role, on what, what
// it may do — `n` to add a role and `d` to add a department (all its roles at
// once), as in the setup wizard's Your team step.
// =============================================================================

/** A department about to be added (no key yet). */
type DeptDraft = Omit<TeamDepartment, "key">;

type Op =
  | { kind: "list" }
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

export function TeamPage({ onLeave, onEditingChange, height }: TeamPageProps): JSX.Element {
  const services = useDashboardServices();
  const orgPath = services.orgConfigPath ?? getForemanPaths().orgConfigPath;
  const [loaded, setLoaded] = useState<Loaded>(() => load(orgPath));
  const [agents, setAgents] = useState(() => services.registry.list());
  const [selected, setSelected] = useState(0);
  const [op, setOp] = useState<Op>({ kind: "list" });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      setLoaded(load(orgPath));
      setAgents(services.registry.list());
    }, 2000);
    return () => clearInterval(t);
  }, [orgPath, services.registry]);

  const typing = op.kind === "own-title" || op.kind === "own-describe" || op.kind === "dept-name";
  useEffect(() => {
    onEditingChange?.(op.kind !== "list");
    return () => onEditingChange?.(false);
  }, [op.kind]);

  const runtimes = useMemo(() => teamRuntimes(agents.map((a) => a.id)), [agents]);
  const rows = useMemo(
    () =>
      loaded.org
        ? teamRows(
            loaded.org,
            agents.map((a) => ({
              id: a.id,
              registryId: typeof a.metadata?.registryId === "string" ? a.metadata.registryId : undefined,
              displayName: a.displayName,
            })),
          )
        : [],
    [loaded.org, agents],
  );
  const safe = Math.min(selected, Math.max(0, rows.length - 1));
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
      setLoaded(load(orgPath));
      setAgents(services.registry.list());
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

  useInput((input, key) => {
    if (op.kind === "busy" || typing) {
      if (typing && key.escape) setOp({ kind: "list" });
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
    if (key.escape) onLeave();
    else if (key.upArrow) setSelected(Math.max(0, safe - 1));
    else if (key.downArrow) setSelected(Math.min(rows.length - 1, safe + 1));
    else if (input === "n") {
      if (canAdd()) setOp({ kind: "pick", cursor: 0, runsOn: {} });
    } else if (input === "d") {
      if (canAdd()) setOp({ kind: "dept-pick", cursor: 0 });
    }
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
        {hint ? label.padEnd(22) : label}
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

  // list
  const org = loaded.org;
  const pick = rows[safe];
  // Header, company, you, blank, details (4), notice: the rest is rows.
  const visibleRows = Math.max(3, height - 11);
  const start = Math.max(0, Math.min(safe - Math.floor(visibleRows / 2), rows.length - visibleRows));
  return frame(
    <>
      <PageHeader title="Team" subtitle={org ? org.company : undefined} right={org ? teamCounts(org) : undefined} />
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
          <Text color={theme.fg.muted}>you{org.human.title ? ` (${org.human.title})` : ""}</Text>
          {rows.slice(start, start + visibleRows).map((r, i) => {
            const focused = start + i === safe;
            return (
              <Text key={r.roleId} wrap="truncate-end">
                <Text color={theme.fg.muted}>{r.prefix}</Text>
                <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
                  {oneLine(r.role.title)}
                </Text>
                <Text color={theme.fg.muted}>
                  {"  "}
                  <Text color={r.registered ? theme.accent.success : theme.accent.warning}>
                    {r.registered ? theme.symbols.activeDot : theme.symbols.idleDot}
                  </Text>{" "}
                  {r.role.agent}
                  {r.runsOn && r.runsOn.toLowerCase() !== r.role.agent ? ` (${r.runsOn})` : ""}
                  {r.department ? oneLine(` · ${r.head ? `leads ${r.department}` : r.department}`) : ""}
                </Text>
              </Text>
            );
          })}
          {rows.length === 0 ? <Text color={theme.fg.muted}>No roles yet: press n to add one, or d for a department.</Text> : null}
        </Box>
      ) : null}
      {org && pick ? (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text bold>{oneLine(pick.role.title)}</Text>
            <Text color={theme.fg.muted}>
              {" "}
              · role {pick.roleId} · reports to {reportsToWords(org, pick.role)}
              {pick.department ? oneLine(` · ${pick.head ? "leads " : ""}${pick.department}`) : ""}
            </Text>
          </Text>
          <Text wrap="truncate-end" color={theme.fg.muted}>
            May: {canWords(pick.role)}
          </Text>
          <Text wrap="truncate-end" color={theme.fg.muted}>
            {pick.registered
              ? oneLine(pick.role.instructions ?? pick.role.responsibility ?? "No instructions: it works from the task it's given.")
              : `${pick.role.agent} isn't registered: foreman agent add ${pick.role.agent}`}
          </Text>
        </Box>
      ) : null}
      {notice ? (
        <Text wrap="truncate-end" color={notice.startsWith(theme.symbols.cross) ? theme.accent.danger : theme.accent.success}>
          {notice}
        </Text>
      ) : null}
    </>,
  );
}
