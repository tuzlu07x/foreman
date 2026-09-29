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
  applyTeam,
  CAPABILITY_LABELS,
  existingRoleIds,
  nextRuntime,
  planTeam,
  reportingLine,
  ROLE_CAPABILITIES,
  TEAM_RUNTIME_NAMES,
  teamChoices,
  type TeamChoice,
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
  return teamChoices(ctx.state.teamCustom, ctx.teamRuntimes, ctx.state.teamRunsOn);
}

/** Rows: the choices, then "Your own role…". */
function rowCount(ctx: WizardContext): number {
  return choices(ctx).length + 1;
}

export function useTeamAutoSkip(ctx: WizardContext): void {
  const { currentStep, advance, teamRuntimes } = ctx;
  useEffect(() => {
    if (currentStep === "team" && teamRuntimes.length === 0) advance("team");
  }, [currentStep, teamRuntimes.length]);
}

function start(ctx: WizardContext, company: string): void {
  const { set } = ctx;
  const picked = choices(ctx).filter((c) => ctx.state.teamPicked.includes(c.key));
  const members = planTeam(picked, existingRoleIds(orgPath(ctx)), ctx.services.registry.list().map((a) => a.id));
  set.setTeamPhase("applying");
  void applyTeam(members, {
    orgConfigPath: orgPath(ctx),
    company,
    addAgent: (id, runsOn) => addInstance(ctx, id, runsOn),
  }).then((result) => {
    set.setTeamResult(result);
    set.setTeamPhase("result");
  });
}

export function handleTeamInput(ctx: WizardContext, input: string, key: Key): boolean {
  const { currentStep, advance, set, state } = ctx;
  if (currentStep !== "team") return false;
  const phase = state.teamPhase;
  if (phase === "custom-title" || phase === "custom-describe" || phase === "company") {
    // TextInput has the keys; Esc goes back to the list.
    if (key.escape) {
      set.setTeamDraft(null);
      set.setTeamPhase("pick");
    }
    return true;
  }
  if (phase === "custom-can") {
    const draft = state.teamDraft;
    if (!draft) return true;
    if (key.upArrow) set.setTeamCanCursor((c) => (c + ROLE_CAPABILITIES.length - 1) % ROLE_CAPABILITIES.length);
    else if (key.downArrow) set.setTeamCanCursor((c) => (c + 1) % ROLE_CAPABILITIES.length);
    else if (input === " ") {
      const cap = ROLE_CAPABILITIES[state.teamCanCursor]!;
      const can = draft.can.includes(cap) ? draft.can.filter((c) => c !== cap) : [...draft.can, cap];
      set.setTeamDraft({ ...draft, can: ROLE_CAPABILITIES.filter((c) => can.includes(c)) });
    } else if (key.return) {
      const index = state.teamCustom.length;
      set.setTeamCustom((prev) => [...prev, draft]);
      set.setTeamPicked((prev) => [...prev, `custom:${index}`]);
      set.setTeamCursor(choices(ctx).length);
      set.setTeamDraft(null);
      set.setTeamPhase("pick");
    } else if (key.escape) {
      set.setTeamPhase("custom-describe");
    }
    return true;
  }
  if (phase === "applying") return true;
  if (phase === "result") {
    if (key.return) advance("team");
    return true;
  }
  // pick
  const rows = rowCount(ctx);
  const list = choices(ctx);
  const focused = list[state.teamCursor];
  if (key.upArrow) set.setTeamCursor((c) => (c + rows - 1) % rows);
  else if (key.downArrow) set.setTeamCursor((c) => (c + 1) % rows);
  else if (input === " " && focused) {
    set.setTeamPicked((prev) => (prev.includes(focused.key) ? prev.filter((k) => k !== focused.key) : [...prev, focused.key]));
  } else if (input === "r" && focused && ctx.teamRuntimes.length > 1) {
    set.setTeamRunsOn((prev) => ({ ...prev, [focused.key]: nextRuntime(focused.runsOn, ctx.teamRuntimes) }));
  } else if (input === "s") {
    advance("team");
  } else if (key.return) {
    if (!focused) {
      set.setTeamDraft({ title: "", instructions: "", can: ["read"] });
      set.setTeamCanCursor(0);
      set.setTeamPhase("custom-title");
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

function canText(can: readonly string[]): string {
  return can.length > 0 ? can.join(", ") : "talk only";
}

export function renderTeamStep(ctx: WizardContext): JSX.Element {
  const { state, set } = ctx;
  const progress = <WizardProgress {...stepProgress("team")} label="Your team" phase="optional" />;
  const phase = state.teamPhase;

  if (phase === "custom-title" || phase === "custom-describe") {
    const draft = state.teamDraft ?? { title: "", instructions: "", can: ["read"] };
    const titleStep = phase === "custom-title";
    return (
      <Box flexDirection="column" gap={1} paddingY={1}>
        {progress}
        <Text bold>Your own role</Text>
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
        <Text color={HINT}>[↑↓] move · [Space] tick · [Enter] add the role · [Esc] back</Text>
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
            <Text key={m.roleId}>
              <Text color={theme.accent.success}>{theme.symbols.check}</Text> {m.title}
              <Text color={HINT}>
                {"  "}runs as {m.agentId} ({TEAM_RUNTIME_NAMES[m.runsOn]}) · may {canText(m.can)} · reports to{" "}
                {m.reportsTo === "human" ? "you" : m.reportsTo}
              </Text>
            </Text>
          ))}
          {result?.failed.map((f) => (
            <Text key={f.title}>
              <Text color={theme.accent.danger}>{theme.symbols.cross}</Text> {f.title}
              <Text color={HINT}>{"  "}{f.reason}</Text>
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
  const list = choices(ctx);
  const picked = list.filter((c) => state.teamPicked.includes(c.key));
  const both = ctx.teamRuntimes.length > 1;
  const row = (c: TeamChoice | null, i: number): JSX.Element => {
    const focused = i === state.teamCursor;
    const cursor = focused ? `${theme.symbols.cursor} ` : "  ";
    if (!c) {
      return (
        <Text key="custom" color={focused ? theme.accent.primary : undefined} bold={focused}>
          {cursor}+ Your own role…
        </Text>
      );
    }
    const on = state.teamPicked.includes(c.key);
    // One Text per row, so a long summary truncates instead of wrapping.
    return (
      <Text key={c.key} wrap="truncate-end">
        <Text color={focused ? theme.accent.primary : undefined} bold={focused}>
          {cursor}[{on ? theme.symbols.check : " "}] {c.title.slice(0, 16).padEnd(17)}
        </Text>
        <Text color={HINT}>
          {TEAM_RUNTIME_NAMES[c.runsOn]} · may {canText(c.can)} · {c.summary}
        </Text>
      </Text>
    );
  };
  return (
    <Box flexDirection="column" gap={1} paddingY={1}>
      {progress}
      <Text color={HINT}>
        Give your agents jobs. Each role runs as its own {both ? "Claude Code or Codex" : TEAM_RUNTIME_NAMES[ctx.teamRuntimes[0] ?? "claude-code"]}, with the
        role's instructions and only the permissions it needs. Change it any time in org.yaml or with `foreman org add-role`.
      </Text>
      <Box flexDirection="column">
        {list.map((c, i) => row(c, i))}
        {row(null, list.length)}
      </Box>
      <Text color={HINT}>
        {picked.length === 0 ? "Nothing picked: Enter skips this step." : `${picked.length} picked. ${reportingLine(picked)}`}
      </Text>
      <Text color={HINT}>
        [↑↓] move · [Space] pick{both ? " · [r] Claude Code/Codex" : ""} · [Enter] {picked.length === 0 ? "skip" : "create"} · [s] skip
      </Text>
    </Box>
  );
}
