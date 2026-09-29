import { existsSync } from "node:fs";
import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { Key } from "ink";
import { type JSX, useEffect } from "react";
import { runAgentAddScripted } from "../../cli/agent-add.js";
import { getForemanPaths } from "../../utils/config.js";
import { WizardProgress } from "../components/wizard-progress.js";
import { theme } from "../theme.js";
import type { WizardContext } from "./context.js";
import { stepProgress } from "./progress.js";
import {
  addDepartment,
  applyTeam,
  CAPABILITY_LABELS,
  DEPARTMENT_PRESETS,
  departmentRuntime,
  existingDepartmentIds,
  existingRoleIds,
  nextRuntime,
  planTeam,
  removeDepartment,
  reportingLine,
  ROLE_CAPABILITIES,
  scrollWindow,
  switchDepartmentRuntime,
  TEAM_RUNTIME_NAMES,
  teamChoices,
  teamPickRows,
  toggleDepartment,
  wrappedLines,
  type TeamChoice,
  type TeamCustomRole,
  type TeamDepartment,
  type TeamPickRow,
  type TeamRuntime,
} from "./team-logic.js";

// ---------------- Your team (optional) ----------------
// Roles run on Claude Code or Codex instances, so the step only shows when
// one of them is registered; otherwise it moves straight on to Done.

function orgPath(ctx: WizardContext): string {
  return ctx.services.orgConfigPath ?? getForemanPaths().orgConfigPath;
}

/** Add one instance, quietly: null when added, else why not. */
async function addInstance(ctx: WizardContext, agentId: string, runsOn: TeamRuntime): Promise<string | null> {
  if (ctx.services.addTeamAgent) return ctx.services.addTeamAgent(agentId, runsOn);
  const errors: string[] = [];
  const code = await runAgentAddScripted(
    agentId,
    { type: runsOn },
    {
      db: ctx.services.db,
      registry: ctx.services.registry,
      // Quiet: the step shows the outcome, and stdout would tear Ink's frame.
      log: () => undefined,
      logError: (line) => errors.push(line),
    },
  );
  return code === 0 ? null : (errors.at(-1) ?? `couldn't add ${agentId}`);
}

function choices(ctx: WizardContext): TeamChoice[] {
  return teamChoices(ctx.state.teamCustom, ctx.teamRuntimes, ctx.state.teamRunsOn, ctx.state.teamDepartments);
}

function pickRows(ctx: WizardContext): TeamPickRow[] {
  return teamPickRows(choices(ctx), ctx.state.teamDepartments, ctx.state.teamPicked);
}

function rowIndex(rows: readonly TeamPickRow[], match: (row: TeamPickRow) => boolean): number {
  return Math.max(0, rows.findIndex(match));
}

export function useTeamAutoSkip(ctx: WizardContext): void {
  const { currentStep, advance, teamRuntimes } = ctx;
  useEffect(() => {
    if (currentStep === "team" && teamRuntimes.length === 0) advance("team");
  }, [currentStep, teamRuntimes.length]);
}

function start(ctx: WizardContext, company: string): void {
  const { set, state } = ctx;
  const picked = choices(ctx).filter((c) => state.teamPicked.includes(c.key));
  const path = orgPath(ctx);
  const members = planTeam(
    picked,
    existingRoleIds(path),
    ctx.services.registry.list().map((a) => a.id),
    undefined,
    state.teamDepartments,
    existingDepartmentIds(path),
  );
  set.setTeamPhase("applying");
  void applyTeam(members, {
    orgConfigPath: path,
    company,
    addAgent: (id, runsOn) => addInstance(ctx, id, runsOn),
  }).then((result) => {
    set.setTeamResult(result);
    set.setTeamPhase("result");
  });
}

/** Your own role joins the list, picked, with the cursor on it. */
function addCustom(ctx: WizardContext, draft: TeamCustomRole): void {
  const { set, state } = ctx;
  const key = `custom:${state.teamCustom.length}`;
  const custom = [...state.teamCustom, draft];
  const picked = [...state.teamPicked, key];
  set.setTeamCustom(custom);
  set.setTeamPicked(picked);
  const rows = teamPickRows(
    teamChoices(custom, ctx.teamRuntimes, state.teamRunsOn, state.teamDepartments),
    state.teamDepartments,
    picked,
  );
  set.setTeamCursor(rowIndex(rows, (r) => r.kind === "role" && r.choice.key === key));
  set.setTeamDraft(null);
  set.setTeamPhase("pick");
}

/** The department joins the list: a ready-made one with all its roles
 *  picked; yours goes straight on to its first role. */
function finishDepartment(ctx: WizardContext, draft: Omit<TeamDepartment, "key">): void {
  const { set, state } = ctx;
  const { departments, key } = addDepartment(state.teamDepartments, draft);
  const all = teamChoices(state.teamCustom, ctx.teamRuntimes, state.teamRunsOn, departments);
  const picked = draft.presetId ? toggleDepartment(state.teamPicked, all, key) : state.teamPicked;
  set.setTeamDepartments(departments);
  set.setTeamPicked(picked);
  set.setTeamDeptDraft(null);
  const rows = teamPickRows(all, departments, picked);
  set.setTeamCursor(rowIndex(rows, (r) => r.kind === "department" && r.department.key === key));
  if (draft.presetId) {
    set.setTeamPhase("pick");
  } else {
    set.setTeamDraft({ title: "", instructions: "", can: ["read"], department: key });
    set.setTeamCanCursor(0);
    set.setTeamPhase("custom-title");
  }
}

/** Ask which agent runs the department when there's a choice. */
function chooseDepartmentRuntime(ctx: WizardContext, draft: Omit<TeamDepartment, "key">): void {
  const { set, teamRuntimes } = ctx;
  const runsOn = teamRuntimes.includes(draft.runsOn) ? draft.runsOn : (teamRuntimes[0] ?? draft.runsOn);
  if (teamRuntimes.length < 2) {
    finishDepartment(ctx, { ...draft, runsOn });
    return;
  }
  set.setTeamDeptDraft({ ...draft, runsOn });
  set.setTeamDeptCursor(teamRuntimes.indexOf(runsOn));
  set.setTeamPhase("dept-runtime");
}

function cycle(cursor: number, count: number, delta: number): number {
  return count === 0 ? 0 : (cursor + count + delta) % count;
}

export function handleTeamInput(ctx: WizardContext, input: string, key: Key): boolean {
  const { currentStep, advance, set, state } = ctx;
  if (currentStep !== "team") return false;
  const phase = state.teamPhase;
  if (phase === "custom-title" || phase === "custom-describe" || phase === "company" || phase === "dept-name") {
    // TextInput has the keys; Esc goes back to the list.
    if (key.escape) {
      set.setTeamDraft(null);
      set.setTeamDeptDraft(null);
      set.setTeamPhase("pick");
    }
    return true;
  }
  if (phase === "custom-can") {
    const draft = state.teamDraft;
    if (!draft) return true;
    if (key.upArrow) set.setTeamCanCursor((c) => cycle(c, ROLE_CAPABILITIES.length, -1));
    else if (key.downArrow) set.setTeamCanCursor((c) => cycle(c, ROLE_CAPABILITIES.length, 1));
    else if (input === " ") {
      const cap = ROLE_CAPABILITIES[state.teamCanCursor]!;
      const can = draft.can.includes(cap) ? draft.can.filter((c) => c !== cap) : [...draft.can, cap];
      set.setTeamDraft({ ...draft, can: ROLE_CAPABILITIES.filter((c) => can.includes(c)) });
    } else if (key.return) {
      if (draft.department === undefined && state.teamDepartments.length > 0) {
        set.setTeamDeptCursor(0);
        set.setTeamPhase("custom-dept");
      } else addCustom(ctx, draft);
    } else if (key.escape) {
      set.setTeamPhase("custom-describe");
    }
    return true;
  }
  if (phase === "custom-dept") {
    const draft = state.teamDraft;
    if (!draft) return true;
    const count = state.teamDepartments.length + 1;
    if (key.upArrow) set.setTeamDeptCursor((c) => cycle(c, count, -1));
    else if (key.downArrow) set.setTeamDeptCursor((c) => cycle(c, count, 1));
    else if (key.return) {
      const dept = state.teamDepartments[state.teamDeptCursor - 1];
      addCustom(ctx, dept ? { ...draft, department: dept.key } : draft);
    } else if (key.escape) set.setTeamPhase("custom-can");
    return true;
  }
  if (phase === "dept-pick") {
    const count = DEPARTMENT_PRESETS.length + 1;
    if (key.upArrow) set.setTeamDeptCursor((c) => cycle(c, count, -1));
    else if (key.downArrow) set.setTeamDeptCursor((c) => cycle(c, count, 1));
    else if (key.return) {
      const preset = DEPARTMENT_PRESETS[state.teamDeptCursor];
      if (preset) chooseDepartmentRuntime(ctx, { presetId: preset.id, name: preset.name, runsOn: preset.runsOn });
      else set.setTeamPhase("dept-name");
    } else if (key.escape) set.setTeamPhase("pick");
    return true;
  }
  if (phase === "dept-runtime") {
    const draft = state.teamDeptDraft;
    if (!draft) return true;
    const count = ctx.teamRuntimes.length;
    if (key.upArrow) set.setTeamDeptCursor((c) => cycle(c, count, -1));
    else if (key.downArrow) set.setTeamDeptCursor((c) => cycle(c, count, 1));
    else if (key.return) {
      finishDepartment(ctx, { ...draft, runsOn: ctx.teamRuntimes[state.teamDeptCursor] ?? draft.runsOn });
    } else if (key.escape) {
      set.setTeamDeptDraft(null);
      set.setTeamDeptCursor(0);
      set.setTeamPhase("dept-pick");
    }
    return true;
  }
  if (phase === "applying") return true;
  if (phase === "result") {
    if (key.return) advance("team");
    return true;
  }
  // pick
  const all = choices(ctx);
  const rows = teamPickRows(all, state.teamDepartments, state.teamPicked);
  const cursor = Math.min(state.teamCursor, rows.length - 1);
  const row = rows[cursor];
  const both = ctx.teamRuntimes.length > 1;
  if (key.upArrow) set.setTeamCursor(cycle(cursor, rows.length, -1));
  else if (key.downArrow) set.setTeamCursor(cycle(cursor, rows.length, 1));
  else if (input === " " && row?.kind === "role") {
    const k = row.choice.key;
    set.setTeamPicked((prev) => (prev.includes(k) ? prev.filter((p) => p !== k) : [...prev, k]));
  } else if (input === " " && row?.kind === "department") {
    set.setTeamPicked(toggleDepartment(state.teamPicked, all, row.department.key));
  } else if (input === "r" && both && row?.kind === "role") {
    const c = row.choice;
    set.setTeamRunsOn((prev) => ({ ...prev, [c.key]: nextRuntime(c.runsOn, ctx.teamRuntimes) }));
  } else if (input === "r" && both && row?.kind === "department") {
    const next = switchDepartmentRuntime(
      state.teamDepartments,
      state.teamRunsOn,
      all,
      row.department.key,
      ctx.teamRuntimes,
    );
    set.setTeamDepartments(next.departments);
    set.setTeamRunsOn(next.runsOn);
  } else if (input === "x" && row?.kind === "department") {
    const next = removeDepartment(
      {
        departments: state.teamDepartments,
        custom: state.teamCustom,
        picked: state.teamPicked,
        runsOn: state.teamRunsOn,
      },
      row.department.key,
    );
    set.setTeamDepartments(next.departments);
    set.setTeamCustom(next.custom);
    set.setTeamPicked(next.picked);
    set.setTeamRunsOn(next.runsOn);
    // The row that took its place: what came after the department.
    set.setTeamCursor(cursor);
  } else if (input === "s") {
    advance("team");
  } else if (key.return) {
    if (row?.kind === "own-role") {
      set.setTeamDraft({ title: "", instructions: "", can: ["read"] });
      set.setTeamCanCursor(0);
      set.setTeamPhase("custom-title");
    } else if (row?.kind === "add-department") {
      set.setTeamDeptDraft(null);
      set.setTeamDeptCursor(0);
      set.setTeamPhase("dept-pick");
    } else if (state.teamPicked.length === 0) {
      advance("team");
    } else if (!existsSync(orgPath(ctx))) {
      set.setTeamPhase("company");
    } else {
      start(ctx, "");
    }
  }
  return true;
}

const HINT = theme.fg.muted;
const TITLE_WIDTH = 28;
const RUNTIME_WIDTH = 12;

function canText(can: readonly string[]): string {
  return can.length > 0 ? can.join(", ") : "talk only";
}

/** `text` in exactly `width` columns: padded, or cut with an ellipsis. */
function fit(text: string, width: number): string {
  return text.length < width ? text.padEnd(width) : `${text.slice(0, width - 2)}… `;
}

function whoName(reportsTo: string): string {
  return reportsTo === "human" ? "you" : reportsTo;
}

/** A list of options with a cursor (the department screens). */
function OptionList({ items, cursor }: { items: { label: string; hint?: string }[]; cursor: number }): JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const focused = i === cursor;
        return (
          <Text key={item.label} wrap="truncate-end">
            <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
              {focused ? `${theme.symbols.cursor} ` : "  "}
              {item.hint ? fit(item.label, 22) : item.label}
            </Text>
            {item.hint ? <Text color={HINT}>{item.hint}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

export function renderTeamStep(ctx: WizardContext): JSX.Element {
  const { state, set } = ctx;
  const progress = <WizardProgress {...stepProgress("team")} label="Your team" phase="optional" />;
  const phase = state.teamPhase;
  const both = ctx.teamRuntimes.length > 1;

  if (phase === "custom-title" || phase === "custom-describe") {
    const draft = state.teamDraft ?? { title: "", instructions: "", can: ["read"] };
    const titleStep = phase === "custom-title";
    const dept = state.teamDepartments.find((d) => d.key === draft.department);
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>{dept ? `Your own role in ${dept.name}` : "Your own role"}</Text>
        <Text color={HINT}>
          {titleStep
            ? 'A short job title, like "Chores", "Social media" or "Release manager".'
            : `What should ${draft.title} do? In your own words: the agent is told this when it gets work.`}
        </Text>
        <TextInput
          key={`team:${phase}`}
          placeholder={titleStep ? "Chores" : "Tidy the issue tracker: label new issues, close duplicates."}
          defaultValue={titleStep ? draft.title : draft.instructions}
          onSubmit={(value) => {
            const v = value.trim();
            if (titleStep) {
              if (!v) return;
              set.setTeamDraft({ ...draft, title: v.slice(0, 80) });
              set.setTeamPhase("custom-describe");
            } else {
              set.setTeamDraft({ ...draft, instructions: v.slice(0, 4000) });
              set.setTeamPhase("custom-can");
            }
          }}
        />
        <Text color={HINT}>[Enter] next · [Esc] back to the list</Text>
      </Box>
    );
  }

  if (phase === "custom-can") {
    const draft = state.teamDraft;
    const more = draft?.department === undefined && state.teamDepartments.length > 0;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>What may {draft?.title ?? "it"} do?</Text>
        <Text color={HINT}>Anything not ticked is refused, whatever your policy allows. It can always talk to its colleagues.</Text>
        <Box flexDirection="column">
          {ROLE_CAPABILITIES.map((cap, i) => {
            const on = draft?.can.includes(cap) ?? false;
            const focused = i === state.teamCanCursor;
            return (
              <Text key={cap} color={focused ? theme.accent.primary : undefined} bold={focused}>
                {focused ? `${theme.symbols.cursor} ` : "  "}[{on ? theme.symbols.check : " "}] {CAPABILITY_LABELS[cap]}
              </Text>
            );
          })}
        </Box>
        <Text color={HINT}>[↑↓] move · [Space] tick · [Enter] {more ? "next" : "add the role"} · [Esc] back</Text>
      </Box>
    );
  }

  if (phase === "custom-dept") {
    const title = state.teamDraft?.title ?? "it";
    const items = [
      { label: "None", hint: "on its own: reports to the Manager, or to you" },
      ...state.teamDepartments.map((d) => ({ label: d.name, hint: `reports to ${d.name}'s lead (or leads it, if first)` })),
    ];
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>Which department does {title} join?</Text>
        <OptionList items={items} cursor={state.teamDeptCursor} />
        <Text color={HINT}>[↑↓] move · [Enter] add the role · [Esc] back</Text>
      </Box>
    );
  }

  if (phase === "dept-pick") {
    const items = [
      ...DEPARTMENT_PRESETS.map((d) => ({ label: d.name, hint: `${d.summary} · ${TEAM_RUNTIME_NAMES[d.runsOn]}` })),
      { label: "Your own department…" },
    ];
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>Add a department</Text>
        <Text color={HINT}>
          A department groups roles: its first role leads it and reports to the Manager (or you); the rest of the department reports to
          its lead.
        </Text>
        <OptionList items={items} cursor={state.teamDeptCursor} />
        <Text color={HINT}>[↑↓] move · [Enter] add · [Esc] back to the list</Text>
      </Box>
    );
  }

  if (phase === "dept-name") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>Your own department</Text>
        <Text color={HINT}>A name, like &quot;Sales&quot;, &quot;Design&quot; or &quot;Operations&quot;. You add its roles next.</Text>
        <TextInput
          key="team:dept-name"
          placeholder="Sales"
          onSubmit={(value) => {
            const name = value.trim().slice(0, 80);
            if (name) chooseDepartmentRuntime(ctx, { name, runsOn: ctx.teamRuntimes[0] ?? "claude-code" });
          }}
        />
        <Text color={HINT}>[Enter] next · [Esc] back to the list</Text>
      </Box>
    );
  }

  if (phase === "dept-runtime") {
    const draft = state.teamDeptDraft;
    const name = draft?.name ?? "it";
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>Which agent runs {name}?</Text>
        <Text color={HINT}>
          Every {name} role runs as its own instance of it. Later, [r] on one role&apos;s row switches just that role; [r] on the {name} row
          switches all of them.
        </Text>
        <OptionList items={ctx.teamRuntimes.map((r) => ({ label: TEAM_RUNTIME_NAMES[r] }))} cursor={state.teamDeptCursor} />
        <Text color={HINT}>[↑↓] move · [Enter] add {name} · [Esc] back</Text>
      </Box>
    );
  }

  if (phase === "company") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>Your company or team's name</Text>
        <Text color={HINT}>Your agents are told they work here. It goes in org.yaml.</Text>
        <TextInput key="team:company" placeholder="My team" onSubmit={(value) => start(ctx, value)} />
        <Text color={HINT}>[Enter] create the team · [Esc] back</Text>
      </Box>
    );
  }

  if (phase === "applying") {
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text color={HINT}>{theme.symbols.loading} Adding your team…</Text>
      </Box>
    );
  }

  if (phase === "result") {
    const result = state.teamResult;
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Box flexDirection="column">
          {result?.added.map((m) => (
            <Text key={m.roleId} wrap="truncate-end">
              <Text color={theme.accent.success}>{theme.symbols.check}</Text> {fit(m.title, 22)}
              <Text color={theme.accent.info} bold>
                {TEAM_RUNTIME_NAMES[m.runsOn].padEnd(RUNTIME_WIDTH)}
              </Text>
              <Text color={HINT}>
                {m.departmentName ? `${m.departmentName}${m.lead ? " lead" : ""} · ` : ""}reports to {whoName(m.reportsTo)} · runs as{" "}
                {m.agentId} · may {canText(m.can)}
              </Text>
            </Text>
          ))}
          {result?.failed.map((f) => (
            <Text key={f.title} wrap="truncate-end">
              <Text color={theme.accent.danger}>{theme.symbols.cross}</Text> {f.title}
              <Text color={HINT}>
                {"  "}
                {f.reason}
              </Text>
            </Text>
          ))}
          {result?.orgError ? (
            <Text color={theme.accent.danger}>
              {theme.symbols.cross} org.yaml wasn't changed: {result.orgError}
            </Text>
          ) : null}
        </Box>
        <Text color={HINT}>
          See it with `foreman org show`; add more with `foreman org add-role`. Give work with {'`foreman write <agent> "…"`'} or /foreman from chat.
        </Text>
        <Text>[Enter] continue</Text>
      </Box>
    );
  }

  // pick
  const all = choices(ctx);
  const rows = teamPickRows(all, state.teamDepartments, state.teamPicked);
  const cursor = Math.min(state.teamCursor, rows.length - 1);
  const focusedRow = rows[cursor];
  const picked = all.filter((c) => state.teamPicked.includes(c.key));
  const runtimeWord = both ? "Claude Code or Codex" : TEAM_RUNTIME_NAMES[ctx.teamRuntimes[0] ?? "claude-code"];
  const intro =
    `Give your agents jobs, on their own or in departments (IT, Marketing… or your own). Each role runs as its own ${runtimeWord}, ` +
    "with the role's instructions and only the permissions it needs.";
  const status =
    picked.length === 0 ? "Nothing picked: Enter skips this step." : `${picked.length} picked. ${reportingLine(picked, state.teamDepartments)}`;
  const dept = focusedRow?.kind === "department" ? focusedRow.department.name : null;
  const enter =
    focusedRow?.kind === "own-role"
      ? "your own role"
      : focusedRow?.kind === "add-department"
        ? "add a department"
        : picked.length === 0
          ? "skip"
          : "create";
  const keys = [
    "[↑↓] move",
    dept ? `[Space] pick all of ${dept}` : "[Space] pick",
    both ? `[r] ${dept ? `all of ${dept}: ` : ""}Claude Code ⇄ Codex` : null,
    dept ? `[x] remove ${dept}` : null,
    `[Enter] ${enter}`,
    "[s] skip",
  ]
    .filter(Boolean)
    .join(" · ");
  // Everything but the list: padding (2), progress, the gaps between the
  // four blocks (3), and one spare line so Ink never fills the screen.
  const width = ctx.terminal.cols;
  const chrome = 2 + 1 + 3 + wrappedLines(intro, width) + wrappedLines(status, width) + wrappedLines(keys, width) + 1;
  const view = scrollWindow(rows.length, cursor, Math.max(3, ctx.terminal.rows - chrome));

  const runtimeCell = (name: string, focused: boolean): JSX.Element => (
    <Text color={focused && both ? theme.accent.info : undefined} bold={focused && both}>
      {name.padEnd(RUNTIME_WIDTH)}
    </Text>
  );
  const row = (r: TeamPickRow, i: number): JSX.Element => {
    const focused = i === cursor;
    const pointer = focused ? `${theme.symbols.cursor} ` : "  ";
    const color = focused ? theme.accent.primary : undefined;
    if (r.kind === "own-role") {
      return (
        <Text key="own-role" color={color} bold={focused}>
          {pointer}+ Your own role…
        </Text>
      );
    }
    if (r.kind === "add-department") {
      return (
        <Text key="add-department" wrap="truncate-end">
          <Text color={color} bold={focused}>
            {pointer}+ Add a department…
          </Text>
          <Text color={HINT}>{"  "}IT, Marketing, Customer Support or your own</Text>
        </Text>
      );
    }
    if (r.kind === "department") {
      const { department: d, roles } = r;
      const on = roles.filter((c) => state.teamPicked.includes(c.key)).length;
      const mark = on === 0 ? " " : on === roles.length ? theme.symbols.check : "-";
      const runtime = departmentRuntime(d, roles);
      return (
        <Text key={d.key} wrap="truncate-end">
          <Text color={color} bold>
            {pointer}[{mark}] {fit(`${d.name} department`, TITLE_WIDTH)}
          </Text>
          {runtimeCell(runtime === "mixed" ? "mixed" : TEAM_RUNTIME_NAMES[runtime], focused)}
          <Text color={HINT}>
            · {roles.length === 0 ? "no roles yet: + Your own role… adds one" : `${on} of ${roles.length} picked · the first leads it`}
          </Text>
        </Text>
      );
    }
    const c = r.choice;
    const on = state.teamPicked.includes(c.key);
    const indent = c.department ? "  " : "";
    // One Text per row, so a long summary truncates instead of wrapping.
    return (
      <Text key={c.key} wrap="truncate-end">
        <Text color={color} bold={focused}>
          {pointer}
          {indent}[{on ? theme.symbols.check : " "}] {fit(`${c.title}${r.lead ? " (lead)" : ""}`, TITLE_WIDTH - indent.length)}
        </Text>
        {runtimeCell(TEAM_RUNTIME_NAMES[c.runsOn], focused)}
        <Text color={HINT}>
          · may {canText(c.can)} · {c.summary}
        </Text>
      </Text>
    );
  };
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      {progress}
      <Text color={HINT}>{intro}</Text>
      <Box flexDirection="column">
        {view.above > 0 ? <Text color={HINT}>{`  ↑ ${view.above} more`}</Text> : null}
        {rows.slice(view.start, view.end).map((r, i) => row(r, view.start + i))}
        {view.below > 0 ? <Text color={HINT}>{`  ↓ ${view.below} more`}</Text> : null}
      </Box>
      <Box flexDirection="column">
        <Text color={HINT}>{status}</Text>
        <Text color={HINT}>{keys}</Text>
      </Box>
    </Box>
  );
}
