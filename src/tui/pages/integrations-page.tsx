import { ConfirmInput, MultiSelect, PasswordInput, Select, Spinner, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { existsSync } from "node:fs";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import type { IntegrationEntry, IntegrationVariant } from "../../core/integrations/catalog.js";
import { IntegrationNotReadyError, type AccessChoice, type IntegrationActor } from "../../core/integrations/service.js";
import { describeAccess, launchFingerprint } from "../../core/integrations/status.js";
import { reviewIntegration } from "../../core/integrations/verify.js";
import { scopeForAgent } from "../../core/mcp-hub/boot.js";
import { findCatalogEntry } from "../../core/mcp-hub/catalog.js";
import { toolRuleLevel, type AccessLevelId, type HubConfig } from "../../core/mcp-hub/config.js";
import { ToolPinStore } from "../../core/mcp-hub/pins.js";
import { loadOrg } from "../../core/org/org.js";
import { openInBrowser } from "../../utils/browser-open.js";
import { getForemanPaths } from "../../utils/config.js";
import { PageHeader } from "../components/typography.js";
import { useDashboardServices } from "../dashboard-context.js";
import {
  accessFromSelection,
  addSteps,
  buildIntegrationRows,
  currentOverride,
  cycleToolRule,
  departmentOption,
  EVERYONE,
  orderedVariants,
  removalPlan,
  rowSummary,
  suggestedAgents,
  type AddStep,
  type ConfiguredRow,
  type IntegrationRow,
} from "../integrations-page-logic.js";
import { osc8 } from "../osc8.js";
import { roundBorder, theme } from "../theme.js";

// =============================================================================
// Integrations page (hotkey `i`) — GitHub, GitLab, Jira/Confluence, Trello,
// Linear, Notion. Every change goes through IntegrationService (via: tui),
// exactly like `foreman integrations` on the command line.
// =============================================================================

const TUI: IntegrationActor = { via: "tui", actor: "tui" };

interface AddDraft {
  entry: IntegrationEntry;
  variant: IntegrationVariant | null;
  params: Record<string, string>;
  paramIdx: number;
  accessLevel: AccessLevelId;
  access: AccessChoice | null;
  credentials: Record<string, string>;
  credIdx: number;
  username: string | null;
}

type Op =
  | { kind: "list" }
  | { kind: "pick-product" }
  | { kind: "add"; draft: AddDraft; step: AddStep }
  | { kind: "busy"; label: string }
  | { kind: "signin"; name: string; url: string | null }
  | { kind: "confirm-enable"; name: string; summary: string }
  | { kind: "edit"; name: string }
  | { kind: "edit-who"; name: string }
  | { kind: "rotate"; name: string; slot: string; label: string }
  | { kind: "tools"; name: string; index: number }
  | { kind: "remove"; name: string; keepSecrets: boolean };

export interface IntegrationsPageProps {
  onLeave: () => void;
  onEditingChange?: (editing: boolean) => void;
}

export function IntegrationsPage({ onLeave, onEditingChange }: IntegrationsPageProps): JSX.Element {
  const { registry, integrations, orgConfigPath } = useDashboardServices();
  const [config, setConfig] = useState<HubConfig | null>(() => safeConfig(integrations));
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [op, setOp] = useState<Op>({ kind: "list" });
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const editing = op.kind !== "list" && op.kind !== "tools";
  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  const refresh = useCallback(() => setConfig(safeConfig(integrations)), [integrations]);
  useEffect(() => {
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const rows: IntegrationRow[] = useMemo(() => {
    if (!integrations || !config) return [];
    return buildIntegrationRows(config, integrations.catalogs.integrations, (name) =>
      integrations.service.status(name, config),
    );
  }, [integrations, config]);
  const safeSelected = Math.max(0, Math.min(selectedIdx, rows.length - 1));
  const selected = rows[safeSelected];
  const registered = registry.list().map((a) => a.id);
  const departments = useMemo(() => orgDepartments(orgConfigPath), [orgConfigPath]);

  const fail = (err: unknown): void => {
    setOp({ kind: "list" });
    setNotice({ text: describe(err), error: true });
    refresh();
  };
  const done = (text: string): void => {
    setOp({ kind: "list" });
    setNotice({ text, error: false });
    refresh();
  };

  // ---- flows -----------------------------------------------------------------

  const startAdd = (entry: IntegrationEntry): void => {
    const variant = entry.variants.length === 1 ? entry.variants[0]! : null;
    const draft: AddDraft = {
      entry,
      variant,
      params: {},
      paramIdx: 0,
      accessLevel: "read-only",
      access: null,
      credentials: {},
      credIdx: 0,
      username: null,
    };
    setOp({ kind: "add", draft, step: addSteps(entry, variant, integrations!.catalogs.mcp)[0]! });
  };

  const advance = (draft: AddDraft, from: AddStep): void => {
    const steps = addSteps(draft.entry, draft.variant, integrations!.catalogs.mcp);
    const next = steps[steps.indexOf(from) + 1];
    if (next) setOp({ kind: "add", draft, step: next });
    else void save(draft);
  };

  const save = async (draft: AddDraft): Promise<void> => {
    if (!integrations || !draft.variant || !draft.access) return;
    setOp({ kind: "busy", label: `Saving ${draft.entry.name}…` });
    try {
      const auth = draft.variant.auth;
      const added = await integrations.service.add(
        {
          id: draft.entry.id,
          variant: draft.variant.id,
          accessLevel: draft.accessLevel,
          access: draft.access,
          params: draft.params,
          ...(auth.kind === "basic" && draft.username
            ? { basicAuth: { username: draft.username, password: draft.credentials[auth.secret] ?? "" } }
            : Object.keys(draft.credentials).length > 0
              ? { credentials: draft.credentials }
              : {}),
        },
        TUI,
      );
      refresh();
      if (auth.kind === "oauth") await signIn(added.name, added.server.url!);
      else await review(added.name);
    } catch (err) {
      fail(err);
    }
  };

  const signIn = async (name: string, url: string): Promise<void> => {
    if (!integrations) return;
    setOp({ kind: "signin", name, url: null });
    try {
      await integrations.signIn(name, url, (authUrl) => {
        setOp({ kind: "signin", name, url: authUrl });
        void openInBrowser(authUrl);
      });
      integrations.service.record("integration:login", name, TUI);
      await review(name);
    } catch (err) {
      fail(err);
    }
  };

  const review = async (name: string): Promise<void> => {
    if (!integrations) return;
    setOp({ kind: "busy", label: `Reviewing ${name}'s tools…` });
    try {
      const res = await reviewIntegration(integrations.service.config(), name, integrations.makeHub);
      integrations.service.record("integration:reviewed", name, TUI, {
        tools: res.tools.length,
        quarantined: res.quarantined.map((t) => t.name),
      });
      refresh();
      const withheld = res.quarantined.length > 0 ? ` · ${res.quarantined.length} withheld by the scanner` : "";
      const server = integrations.service.config().servers[name];
      if (server?.enabled) done(`${name}: ${res.tools.length} tools reviewed and pinned${withheld}`);
      else setOp({ kind: "confirm-enable", name, summary: `${res.tools.length} tools reviewed and pinned${withheld}` });
    } catch (err) {
      fail(new Error(`${name}: couldn't review its tools — ${describe(err)}. It stays disabled; fix the credential ([e]) or sign in ([o]), then [r].`));
    }
  };

  const setEnabled = async (name: string, on: boolean): Promise<void> => {
    if (!integrations) return;
    try {
      if (on) {
        await integrations.service.enable(name, TUI);
        done(`${name} enabled — connected agents see it now`);
      } else {
        await integrations.service.disable(name, TUI);
        done(`${name} disabled — connected agents lost it`);
      }
    } catch (err) {
      if (err instanceof IntegrationNotReadyError) {
        fail(new Error(`${name} stays disabled: ${err.status.problems.map((p) => p.detail).join("; ")}`));
      } else fail(err);
    }
  };

  const update = async (name: string, changes: Parameters<NonNullable<typeof integrations>["service"]["update"]>[1]): Promise<void> => {
    if (!integrations) return;
    try {
      const res = await integrations.service.update(name, changes, TUI);
      const shadow = res.ignoredOverrides.map((o) => `${o.tool}: the catalog's '${o.effective}' wins`).join("; ");
      done(`${name} updated${shadow ? ` (${shadow})` : ""}${res.needsReview ? " — disabled until reviewed [r]" : ""}`);
    } catch (err) {
      fail(err);
    }
  };

  // ---- keys ----------------------------------------------------------------

  useInput((input, key) => {
    if (!integrations) {
      if (key.escape) onLeave();
      return;
    }
    if (op.kind === "busy" || op.kind === "signin") return;
    if (op.kind === "confirm-enable") {
      if (key.return) void setEnabled(op.name, true);
      else if (key.escape) done(`${op.name} saved disabled — enable it with [space]`);
      return;
    }
    if (op.kind === "remove") {
      if (key.escape) setOp({ kind: "list" });
      else if (input === "k") setOp({ ...op, keepSecrets: !op.keepSecrets });
      return;
    }
    if (op.kind === "tools") {
      const tools = pinnedTools(config, op.name);
      if (key.escape) setOp({ kind: "list" });
      else if (key.upArrow) setOp({ ...op, index: Math.max(0, op.index - 1) });
      else if (key.downArrow) setOp({ ...op, index: Math.min(tools.length - 1, op.index + 1) });
      else if ((key.leftArrow || key.rightArrow) && tools[op.index]) {
        const tool = tools[op.index]!;
        const server = config!.servers[op.name]!;
        const choice = cycleToolRule(currentOverride(server, tool), key.rightArrow ? 1 : -1);
        void integrations.service
          .update(op.name, { toolOverride: { tool, choice } }, TUI)
          .then(() => refresh())
          .catch((err: unknown) => setNotice({ text: describe(err), error: true }));
      }
      return;
    }
    if (op.kind !== "list") {
      if (key.escape) setOp({ kind: "list" });
      return;
    }

    if (key.escape) return onLeave();
    if (key.upArrow) {
      setSelectedIdx(Math.max(0, safeSelected - 1));
      setExpanded(false);
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(Math.min(rows.length - 1, safeSelected + 1));
      setExpanded(false);
      return;
    }
    if (key.return) {
      setExpanded((v) => !v);
      return;
    }
    if (input === "n") {
      setNotice(null);
      if (selected?.kind === "available") startAdd(selected.entry);
      else setOp({ kind: "pick-product" });
      return;
    }
    if (selected?.kind !== "configured") return;
    const name = selected.name;
    if (input === " ") void setEnabled(name, !selected.server.enabled);
    else if (input === "e") setOp({ kind: "edit", name });
    else if (input === "t") setOp({ kind: "tools", name, index: 0 });
    else if (input === "r") void review(name);
    else if (input === "o" && selected.server.auth === "oauth" && selected.server.url) void signIn(name, selected.server.url);
    else if (input === "d") setOp({ kind: "remove", name, keepSecrets: false });
  });

  // ---- render ----------------------------------------------------------------

  if (!integrations) {
    return (
      <Box flexDirection="column" borderStyle={roundBorder()} borderDimColor paddingX={1} flexGrow={1}>
        <PageHeader title="Integrations" />
        <Text color={theme.accent.danger}>Integrations are not available in this session.</Text>
        <Text color={theme.fg.muted}>Use `foreman integrations` on the command line. [Esc] back</Text>
      </Box>
    );
  }

  const configuredCount = rows.filter((r) => r.kind === "configured").length;
  const firstAvailable = rows.findIndex((r) => r.kind === "available");

  return (
    <Box flexDirection="column" borderStyle={roundBorder()} borderDimColor paddingX={1} flexGrow={1}>
      <PageHeader
        title="Integrations"
        right={`${configuredCount} configured · ${rows.length - configuredCount} available`}
      />
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) => (
          <Box key={row.kind === "configured" ? row.name : `+${row.entry.id}`} flexDirection="column">
            {i === firstAvailable && (
              <Text color={theme.fg.muted}>{configuredCount > 0 ? "\nAvailable:" : "Available:"}</Text>
            )}
            <IntegrationLine row={row} selected={i === safeSelected} />
            {expanded && i === safeSelected && row.kind === "configured" && (
              <Details row={row} registered={registered} orgConfigPath={orgConfigPath} config={config!} />
            )}
          </Box>
        ))}
      </Box>

      {op.kind === "pick-product" && (
        <Overlay title="Add an integration">
          <Select
            options={integrations.catalogs.integrations.integrations.map((e) => ({ label: `${e.name} — ${e.description}`, value: e.id }))}
            onChange={(id) => startAdd(integrations.catalogs.integrations.integrations.find((e) => e.id === id)!)}
          />
        </Overlay>
      )}

      {op.kind === "add" && (
        <AddStepView
          draft={op.draft}
          step={op.step}
          registered={registered}
          departments={departments}
          mcp={integrations.catalogs.mcp}
          onDraft={(draft, from) => advance(draft, from)}
          onStay={(draft) => setOp({ kind: "add", draft, step: op.step })}
          onVariant={(variant) => {
            const draft = { ...op.draft, variant };
            advance(draft, "variant");
          }}
          onError={(text) => setNotice({ text, error: true })}
        />
      )}

      {op.kind === "busy" && (
        <Box marginTop={1}>
          <Spinner label={op.label} />
        </Box>
      )}

      {op.kind === "signin" && (
        <Overlay title={`Sign in to ${op.name}`}>
          {op.url ? (
            <>
              <Text>Finish signing in in your browser. If it didn't open:</Text>
              <Text color={theme.accent.primary}>{osc8(op.url, op.url)}</Text>
            </>
          ) : null}
          <Spinner label="Waiting for the sign-in to come back to this machine…" />
        </Overlay>
      )}

      {op.kind === "confirm-enable" && (
        <Overlay title={`${op.name} is ready`}>
          <Text>{op.summary}.</Text>
          <Text color={theme.fg.muted}>[Enter] enable it now · [Esc] keep it disabled</Text>
        </Overlay>
      )}

      {op.kind === "edit" && config?.servers[op.name] && (
        <EditMenu
          name={op.name}
          config={config}
          variant={rows.find((r): r is ConfiguredRow => r.kind === "configured" && r.name === op.name)?.variant ?? null}
          onPick={(pick) => {
            const server = config.servers[op.name]!;
            if (pick === "level") {
              void update(op.name, {
                accessLevel: server.integration!.access_level === "read-only" ? "read-write" : "read-only",
              });
            } else if (pick === "who") setOp({ kind: "edit-who", name: op.name });
            else if (pick === "signin" && server.url) void signIn(op.name, server.url);
            else if (pick.startsWith("rotate:")) {
              const slot = pick.slice("rotate:".length);
              setOp({ kind: "rotate", name: op.name, slot, label: slot });
            }
          }}
        />
      )}

      {op.kind === "edit-who" && config?.servers[op.name] && (
        <Overlay title={`Who may use ${op.name}`}>
          <WhoPicker
            registered={registered}
            departments={departments}
            initial={initialWho(config.servers[op.name]!.access, registered)}
            onSubmit={(access) => void update(op.name, { access })}
            onError={(text) => setNotice({ text, error: true })}
          />
        </Overlay>
      )}

      {op.kind === "rotate" && (
        <Overlay title={`New value for ${op.label}`}>
          <PasswordInput
            placeholder="paste it here — never shown"
            onSubmit={(value) => {
              if (!value.trim()) return setOp({ kind: "list" });
              void integrations.service
                .rotateSecret(op.name, op.slot, value.trim(), TUI)
                .then((stored) => done(`${stored} replaced — the hub uses it on its next connection`))
                .catch(fail);
            }}
          />
        </Overlay>
      )}

      {op.kind === "tools" && config?.servers[op.name] && (
        <ToolsView config={config} name={op.name} index={op.index} />
      )}

      {op.kind === "remove" && config?.servers[op.name] && (
        <RemoveView
          config={config}
          name={op.name}
          keepSecrets={op.keepSecrets}
          variant={rows.find((r): r is ConfiguredRow => r.kind === "configured" && r.name === op.name)?.variant ?? null}
          onConfirm={() => {
            void integrations.service
              .remove(op.name, TUI, { keepSecrets: op.keepSecrets })
              .then((res) =>
                done(`${res.name} removed${res.removedSecrets.length > 0 ? ` · deleted ${res.removedSecrets.join(", ")}` : ""}${res.revokeUrl ? ` · revoke at ${res.revokeUrl}` : ""}`),
              )
              .catch(fail);
          }}
          onCancel={() => setOp({ kind: "list" })}
        />
      )}

      {notice && op.kind === "list" && (
        <Box marginTop={1}>
          <Text color={notice.error ? theme.accent.danger : theme.accent.success}>{notice.text}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.fg.muted}>{"─".repeat(60)}</Text>
      </Box>
      <Text color={theme.fg.muted}>
        {op.kind === "tools"
          ? "[↑↓] tool · [←→] rule: default / allow / ask / confirm / deny · [Esc] back"
          : "[↑↓] move · [Enter] details · [n] add · [space] on/off · [e] edit · [t] tools · [r] review · [o] sign in · [d] delete · [Esc] back"}
      </Text>
    </Box>
  );
}

// -----------------------------------------------------------------------------
// pieces
// -----------------------------------------------------------------------------

function IntegrationLine({ row, selected }: { row: IntegrationRow; selected: boolean }): JSX.Element {
  const cursor = <Text color={selected ? theme.accent.primary : theme.fg.muted}>{selected ? "▸ " : "  "}</Text>;
  if (row.kind === "available") {
    return (
      <Text wrap="truncate-end">
        {cursor}
        <Text color={theme.fg.muted}>+ </Text>
        <Text>{row.entry.name}</Text> <Text color={theme.fg.muted}>{clip(row.entry.description, 64)}</Text>
      </Text>
    );
  }
  const attention = row.status.state === "attention";
  const dot = attention ? theme.symbols.warn : row.server.enabled ? theme.symbols.activeDot : theme.symbols.idleDot;
  const color = attention ? theme.accent.warning : row.server.enabled ? theme.accent.success : theme.fg.muted;
  return (
    <Text wrap="truncate-end">
      {cursor}
      <Text color={color}>{dot}</Text> <Text color={theme.accent.primary}>{row.name}</Text>{" "}
      <Text color={theme.fg.muted}>
        {rowSummary(row)} · {describeAccess(row.server.access)}
      </Text>
    </Text>
  );
}

function Details({
  row,
  registered,
  orgConfigPath,
  config,
}: {
  row: ConfiguredRow;
  registered: string[];
  orgConfigPath: string | undefined;
  config: HubConfig;
}): JSX.Element {
  const meta = row.server.integration!;
  const secrets = Object.values(meta.secrets);
  const who = agentAccess(registered, row.name, config, orgConfigPath);
  return (
    <Box flexDirection="column" marginLeft={4} marginY={1}>
      <KV k="product" v={`${row.entry?.name ?? meta.id} — ${row.variant?.label ?? meta.variant}`} />
      <KV k="server" v={row.server.url ?? `${row.server.command} ${row.server.args.join(" ")}`} />
      <KV k="access" v={`${meta.access_level}${meta.products ? ` · ${meta.products.join(", ")}` : ""}`} />
      {secrets.length > 0 && (
        <KV k="credentials" v={secrets.map((s) => `${s} ${row.status.missingSecrets.includes(s) ? "✗ missing" : "✓"}`).join(", ")} />
      )}
      {row.status.oauth && <KV k="sign-in" v={row.status.oauth.state} />}
      <KV k="agents" v={who.map((w) => `${w.allowed ? "✓" : "·"} ${w.agent}`).join("  ") || "(none registered)"} />
      {row.status.problems.map((p) => (
        <Text key={p.detail} color={theme.accent.warning}>
          {theme.symbols.warn} {p.detail}
        </Text>
      ))}
    </Box>
  );
}

function KV({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <Text color={theme.fg.muted}>
      {k.padEnd(12)} <Text color={theme.fg.default}>{v}</Text>
    </Text>
  );
}

function Overlay({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle={roundBorder()} borderColor={theme.accent.primary}>
      <Text bold>{title}</Text>
      {children}
      <Text color={theme.fg.muted}>[Esc] cancel</Text>
    </Box>
  );
}

function AddStepView({
  draft,
  step,
  registered,
  departments,
  mcp,
  onDraft,
  onStay,
  onVariant,
  onError,
}: {
  draft: AddDraft;
  step: AddStep;
  registered: string[];
  departments: string[];
  mcp: NonNullable<ReturnType<typeof useDashboardServices>["integrations"]>["catalogs"]["mcp"];
  /** The step is done: go on to the next one (or save). */
  onDraft: (draft: AddDraft, from: AddStep) => void;
  /** More input for the same step (the next param or credential). */
  onStay: (draft: AddDraft) => void;
  onVariant: (variant: IntegrationVariant) => void;
  onError: (text: string) => void;
}): JSX.Element {
  const title = `Add ${draft.entry.name}${draft.variant ? ` — ${draft.variant.label}` : ""}`;
  if (step === "variant") {
    return (
      <Overlay title={title}>
        <Text color={theme.fg.muted}>How should Foreman connect?</Text>
        <Select
          options={orderedVariants(draft.entry).map((v) => ({
            label: `${v.recommended ? "★ " : "  "}${v.label}${findCatalogEntry(mcp, v.server)?.status ? ` (${findCatalogEntry(mcp, v.server)!.status})` : ""}`,
            value: v.id,
          }))}
          onChange={(id) => onVariant(draft.entry.variants.find((v) => v.id === id)!)}
        />
      </Overlay>
    );
  }
  if (step === "params") {
    const params = findCatalogEntry(mcp, draft.variant!.server)?.user_params ?? [];
    const spec = params[draft.paramIdx]!;
    return (
      <Overlay title={title}>
        <Text>
          {spec.label} <Text color={theme.fg.muted}>(e.g. {spec.example})</Text>
        </Text>
        <TextInput
          key={spec.name}
          defaultValue={spec.default ?? ""}
          onSubmit={(value) => {
            const params2 = { ...draft.params, [spec.name]: value.trim() || spec.default || "" };
            if (draft.paramIdx + 1 < params.length) onStay({ ...draft, params: params2, paramIdx: draft.paramIdx + 1 });
            else onDraft({ ...draft, params: params2 }, "params");
          }}
        />
      </Overlay>
    );
  }
  if (step === "level") {
    return (
      <Overlay title={title}>
        <Text color={theme.fg.muted}>Read-only denies every write tool; read-write lets writes through to your approval.</Text>
        <Select
          options={[
            { label: "read-only (recommended)", value: "read-only" },
            { label: "read-write", value: "read-write" },
          ]}
          onChange={(v) => onDraft({ ...draft, accessLevel: v as AccessLevelId }, "level")}
        />
      </Overlay>
    );
  }
  if (step === "who") {
    return (
      <Overlay title={`${title}: who may use it`}>
        <WhoPicker
          registered={registered}
          departments={departments}
          initial={suggestedAgents(draft.entry, registered)}
          onSubmit={(access) => onDraft({ ...draft, access }, "who")}
          onError={onError}
        />
      </Overlay>
    );
  }
  // credentials
  const auth = draft.variant!.auth;
  if (auth.kind === "basic" && draft.username === null) {
    return (
      <Overlay title={title}>
        <Text>{auth.username_label}</Text>
        <TextInput onSubmit={(value) => value.trim() && onStay({ ...draft, username: value.trim() })} />
      </Overlay>
    );
  }
  const fields =
    auth.kind === "secrets"
      ? auth.fields.map((f) => ({ secret: f.secret, label: f.label, hint: f.format_hint, where: f.where_to_get }))
      : auth.kind === "basic"
        ? [{ secret: auth.secret, label: auth.password_label, hint: auth.format_hint, where: auth.where_to_get }]
        : [];
  const field = fields[draft.credIdx]!;
  return (
    <Overlay title={title}>
      <Text>
        {field.label} <Text color={theme.fg.muted}>— {field.hint}</Text>
      </Text>
      <Text color={theme.fg.muted}>
        Get it at <Text color={theme.accent.primary}>{osc8(field.where, field.where)}</Text>
      </Text>
      <PasswordInput
        key={field.secret}
        placeholder="paste it here — never shown"
        onSubmit={(value) => {
          if (!value.trim()) return;
          const credentials = { ...draft.credentials, [field.secret]: value.trim() };
          if (draft.credIdx + 1 < fields.length) onStay({ ...draft, credentials, credIdx: draft.credIdx + 1 });
          else onDraft({ ...draft, credentials }, "credentials");
        }}
      />
    </Overlay>
  );
}

function WhoPicker({
  registered,
  departments,
  initial,
  onSubmit,
  onError,
}: {
  registered: string[];
  departments: string[];
  initial: string[];
  onSubmit: (access: AccessChoice) => void;
  onError: (text: string) => void;
}): JSX.Element {
  const options = [
    { label: "Every verified agent", value: EVERYONE },
    ...registered.map((a) => ({ label: a, value: a })),
    ...departments.map((d) => ({ label: `department: ${d}`, value: departmentOption(d) })),
  ];
  return (
    <>
      <Text color={theme.fg.muted}>[space] toggle · [Enter] confirm</Text>
      <MultiSelect
        options={options}
        defaultValue={initial}
        onSubmit={(values) => {
          const access = accessFromSelection(values);
          if (!access) onError("pick at least one agent, a department or everyone");
          else onSubmit(access);
        }}
      />
    </>
  );
}

function EditMenu({
  name,
  config,
  variant,
  onPick,
}: {
  name: string;
  config: HubConfig;
  variant: IntegrationVariant | null;
  onPick: (pick: string) => void;
}): JSX.Element {
  const server = config.servers[name]!;
  const level = server.integration!.access_level;
  const options = [
    { label: `Access level: ${level} → ${level === "read-only" ? "read-write" : "read-only"}`, value: "level" },
    { label: `Who may use it: ${describeAccess(server.access)}`, value: "who" },
    ...(server.auth === "oauth" ? [{ label: "Sign in again", value: "signin" }] : []),
    ...(variant?.auth.kind === "secrets"
      ? variant.auth.fields.map((f) => ({ label: `Replace ${f.label}`, value: `rotate:${f.secret}` }))
      : variant?.auth.kind === "basic"
        ? [{ label: "Replace the stored user and token", value: `rotate:${variant.auth.secret}` }]
        : []),
  ];
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle={roundBorder()} borderColor={theme.accent.primary}>
      <Text bold>Edit {name}</Text>
      <Select options={options} onChange={onPick} />
      <Text color={theme.fg.muted}>Variant, params, products: `foreman integrations update {name}` · [Esc] cancel</Text>
    </Box>
  );
}

function ToolsView({ config, name, index }: { config: HubConfig; name: string; index: number }): JSX.Element {
  const server = config.servers[name]!;
  const tools = pinnedTools(config, name);
  if (tools.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.accent.warning}>No reviewed tools yet — press [r] on the list to review {name}.</Text>
      </Box>
    );
  }
  const start = Math.max(0, Math.min(index - 5, tools.length - 12));
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle={roundBorder()} borderColor={theme.accent.primary}>
      <Text bold>
        {name} tools <Text color={theme.fg.muted}>(effective rule · your override)</Text>
      </Text>
      {tools.slice(start, start + 12).map((tool, i) => {
        const at = start + i;
        const level = toolRuleLevel(server.tools, tool) ?? "ask";
        const override = currentOverride(server, tool);
        const color = level === "deny" ? theme.fg.muted : level === "allow" ? theme.accent.success : theme.accent.warning;
        return (
          <Text key={tool}>
            <Text color={at === index ? theme.accent.primary : theme.fg.muted}>{at === index ? "▸ " : "  "}</Text>
            <Text>{tool.padEnd(32)}</Text> <Text color={color}>{level.padEnd(8)}</Text>
            <Text color={theme.fg.muted}>{override === "default" ? "" : `override: ${override}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function RemoveView({
  config,
  name,
  keepSecrets,
  variant,
  onConfirm,
  onCancel,
}: {
  config: HubConfig;
  name: string;
  keepSecrets: boolean;
  variant: IntegrationVariant | null;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const plan = removalPlan(config, name, variant);
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle={roundBorder()} borderColor={theme.accent.danger}>
      <Text bold color={theme.accent.danger}>
        Remove {name}?
      </Text>
      <Text>• its mcp.yaml block and pinned tools{plan.signsOut ? " · its sign-in" : ""}</Text>
      {plan.deletes.length > 0 && (
        <Text>
          • credentials: {keepSecrets ? <Text color={theme.fg.muted}>kept ({plan.deletes.join(", ")})</Text> : plan.deletes.join(", ")}
        </Text>
      )}
      {plan.shared.length > 0 && <Text color={theme.fg.muted}>• kept, another server uses them: {plan.shared.join(", ")}</Text>}
      {plan.revokeUrl && <Text color={theme.fg.muted}>Then revoke Foreman's access at {plan.revokeUrl}</Text>}
      <Text color={theme.fg.muted}>[k] {keepSecrets ? "delete" : "keep"} the credentials</Text>
      <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />
    </Box>
  );
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function safeConfig(integrations: ReturnType<typeof useDashboardServices>["integrations"]): HubConfig | null {
  try {
    return integrations ? integrations.service.config() : null;
  } catch {
    return null;
  }
}

function pinnedTools(config: HubConfig | null, name: string): string[] {
  const server = config?.servers[name];
  if (!server) return [];
  const pins = new ToolPinStore(getForemanPaths().mcpPinsPath).get(name, launchFingerprint(server));
  return pins ? Object.keys(pins.tools).sort() : [];
}

function orgDepartments(orgConfigPath: string | undefined): string[] {
  if (!orgConfigPath || !existsSync(orgConfigPath)) return [];
  try {
    return Object.keys(loadOrg(orgConfigPath)?.departments ?? {});
  } catch {
    return [];
  }
}

function agentAccess(
  registered: string[],
  name: string,
  config: HubConfig,
  orgConfigPath: string | undefined,
): Array<{ agent: string; allowed: boolean }> {
  const org = orgConfigPath ?? getForemanPaths().orgConfigPath;
  return registered.map((agent) => ({
    agent,
    allowed: scopeAllows(org, agent, config, name),
  }));
}

function scopeAllows(orgPath: string, agent: string, config: HubConfig, name: string): boolean {
  return scopeForAgent(orgPath, agent, () => undefined, config).allowedServers?.has(name) === true;
}

function initialWho(access: HubConfig["servers"][string]["access"], registered: string[]): string[] {
  if (!access) return [EVERYONE];
  return [
    ...(access.agents ?? []).filter((a) => registered.includes(a)),
    ...(access.departments ?? []).map(departmentOption),
  ];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
