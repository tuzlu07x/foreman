import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { type JSX, useEffect, useMemo, useState } from "react";
import { runAgentAddScripted } from "../../cli/agent-add.js";
import { loadOrg, type OrgDoc } from "../../core/org/org.js";
import { getForemanPaths } from "../../utils/config.js";
import { PageHeader } from "../components/typography.js";
import { useDashboardServices } from "../dashboard-context.js";
import {
  applyTeam,
  CAPABILITY_LABELS,
  existingRoleIds,
  nextRuntime,
  planTeam,
  ROLE_CAPABILITIES,
  TEAM_RUNTIME_NAMES,
  teamChoices,
  teamRuntimes,
  type TeamCustomRole,
  type TeamRuntime,
} from "../setup-wizard/team-logic.js";
import { canWords, reportsToWords, teamRows } from "../team-page-logic.js";
import { roundBorder, theme } from "../theme.js";

// =============================================================================
// Team page (hotkey `t`): your org chart — who fills each role, on what, what
// it may do — and `n` to add a role, as in the setup wizard's Your team step.
// =============================================================================

type Op =
  | { kind: "list" }
  | { kind: "pick"; cursor: number; runsOn: Record<string, TeamRuntime> }
  | { kind: "own-title" }
  | { kind: "own-describe"; draft: TeamCustomRole }
  | { kind: "own-can"; draft: TeamCustomRole; cursor: number }
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

  const typing = op.kind === "own-title" || op.kind === "own-describe";
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

  const add = (custom: TeamCustomRole | null, pickKey: string | null, runsOn: Record<string, TeamRuntime>): void => {
    const all = teamChoices(custom ? [custom] : [], runtimes, runsOn);
    const picked = all.filter((c) => (custom ? c.key === "custom:0" : c.key === pickKey));
    const roles = existingRoleIds(orgPath);
    const manager = roles.includes("manager") ? "manager" : undefined;
    const members = planTeam(picked, roles, agents.map((a) => a.id), manager);
    setOp({ kind: "busy", label: `Adding ${picked[0]?.title ?? "the role"}…` });
    void applyTeam(members, {
      orgConfigPath: orgPath,
      company: "My team",
      addAgent: async (id, type) => {
        const errors: string[] = [];
        const code = await runAgentAddScripted(
          id,
          { type },
          { db: services.db, registry: services.registry, log: () => undefined, logError: (l) => errors.push(l) },
        );
        return code === 0 ? null : (errors.at(-1) ?? `couldn't add ${id}`);
      },
    }).then((result) => {
      const m = result.added[0];
      setNotice(
        m
          ? `${theme.symbols.check} ${m.title} added: runs as ${m.agentId} (${TEAM_RUNTIME_NAMES[m.runsOn]}), reports to ${m.reportsTo === "human" ? "you" : m.reportsTo}`
          : `${theme.symbols.cross} ${result.orgError ?? result.failed[0]?.reason ?? "nothing was added"}`,
      );
      setLoaded(load(orgPath));
      setAgents(services.registry.list());
      setOp({ kind: "list" });
    });
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
      } else if (key.return) add(op.draft, null, {});
      else if (key.escape) setOp({ kind: "list" });
      return;
    }
    if (op.kind === "pick") {
      const count = choices.length + 1;
      const focused = choices[op.cursor];
      if (key.upArrow) setOp({ ...op, cursor: (op.cursor + count - 1) % count });
      else if (key.downArrow) setOp({ ...op, cursor: (op.cursor + 1) % count });
      else if (input === "r" && focused && runtimes.length > 1) {
        setOp({ ...op, runsOn: { ...op.runsOn, [focused.key]: nextRuntime(focused.runsOn, runtimes) } });
      } else if (key.return) {
        if (focused) add(null, focused.key, op.runsOn);
        else setOp({ kind: "own-title" });
      } else if (key.escape) setOp({ kind: "list" });
      return;
    }
    // list
    if (key.escape) onLeave();
    else if (key.upArrow) setSelected(Math.max(0, safe - 1));
    else if (key.downArrow) setSelected(Math.min(rows.length - 1, safe + 1));
    else if (input === "n") {
      setNotice(null);
      if (runtimes.length === 0) {
        setNotice("Roles run on Claude Code or Codex: add one first (foreman agent add claude-code).");
      } else if (loaded.error) {
        setNotice(`Fix org.yaml first: ${loaded.error}`);
      } else setOp({ kind: "pick", cursor: 0, runsOn: {} });
    }
  });

  const frame = (children: JSX.Element): JSX.Element => (
    <Box flexDirection="column" borderStyle={roundBorder()} borderDimColor paddingX={1} flexGrow={1}>
      {children}
    </Box>
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

  if (op.kind === "own-title" || op.kind === "own-describe") {
    const titleStep = op.kind === "own-title";
    return frame(
      <>
        <PageHeader title="Team" subtitle="your own role" />
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
              if (v) setOp({ kind: "own-describe", draft: { title: v.slice(0, 80), instructions: "", can: ["read"] } });
            } else {
              setOp({ kind: "own-can", draft: { ...op.draft, instructions: v.slice(0, 4000) }, cursor: 0 });
            }
          }}
        />
        <Text color={theme.fg.muted}>[Enter] next · [Esc] cancel</Text>
      </>,
    );
  }

  if (op.kind === "own-can") {
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
          [↑↓] move · [Space] tick · [Enter] add on {TEAM_RUNTIME_NAMES[runtimes.includes("claude-code") ? "claude-code" : "codex"]} ·
          [Esc] cancel
        </Text>
      </>,
    );
  }

  if (op.kind === "pick") {
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
                <Text color={theme.fg.muted}>
                  {TEAM_RUNTIME_NAMES[c.runsOn]} · may {c.can.join(", ")} · {c.summary}
                </Text>
              </Text>
            );
          })}
          <Text color={op.cursor === choices.length ? theme.accent.primary : undefined} bold={op.cursor === choices.length}>
            {op.cursor === choices.length ? `${theme.symbols.cursor} ` : "  "}+ Your own role…
          </Text>
        </Box>
        <Text color={theme.fg.muted}>
          [↑↓] move · [Enter] add{runtimes.length > 1 ? " · [r] Claude Code/Codex" : ""} · [Esc] cancel
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
      <PageHeader
        title="Team"
        subtitle={org ? org.company : undefined}
        right={org ? `${rows.length} role${rows.length === 1 ? "" : "s"}` : undefined}
      />
      {loaded.error ? (
        <Text color={theme.accent.danger}>
          {theme.symbols.cross} org.yaml doesn&apos;t parse: {loaded.error} (foreman org validate)
        </Text>
      ) : null}
      {!org && !loaded.error ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>No team yet.</Text>
          <Text color={theme.fg.muted}>
            Give your agents jobs: press n to add a role (a manager, a developer, a code reviewer… or your own),
            each on its own Claude Code or Codex with only the permissions it needs.
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
                  {r.role.title}
                </Text>
                <Text color={theme.fg.muted}>
                  {"  "}
                  <Text color={r.registered ? theme.accent.success : theme.accent.warning}>
                    {r.registered ? theme.symbols.activeDot : theme.symbols.idleDot}
                  </Text>{" "}
                  {r.role.agent}
                  {r.runsOn && r.runsOn.toLowerCase() !== r.role.agent ? ` (${r.runsOn})` : ""}
                  {r.department ? ` · ${r.department}` : ""}
                </Text>
              </Text>
            );
          })}
          {rows.length === 0 ? <Text color={theme.fg.muted}>No roles yet: press n to add one.</Text> : null}
        </Box>
      ) : null}
      {org && pick ? (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text bold>{pick.role.title}</Text>
            <Text color={theme.fg.muted}>
              {" "}
              · role {pick.roleId} · reports to {reportsToWords(org, pick.role)}
            </Text>
          </Text>
          <Text wrap="truncate-end" color={theme.fg.muted}>
            May: {canWords(pick.role)}
          </Text>
          <Text wrap="truncate-end" color={theme.fg.muted}>
            {pick.registered
              ? (pick.role.instructions ?? pick.role.responsibility ?? "No instructions: it works from the task it's given.")
              : `${pick.role.agent} isn't registered: foreman agent add ${pick.role.agent}`}
          </Text>
        </Box>
      ) : null}
      {notice ? <Text color={notice.startsWith(theme.symbols.cross) ? theme.accent.danger : theme.accent.success}>{notice}</Text> : null}
    </>,
  );
}
