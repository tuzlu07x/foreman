import { Box, Text, useApp, useInput, useStdin } from "ink";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequest } from "../core/approval.js";
import { loadOrg } from "../core/org/org.js";
import { revokeAgentToken } from "../core/agent-token.js";
import { unwireAgent } from "../core/agent-wiring.js";
import { findAgent, loadActiveRegistry, type AgentEntry } from "../core/registry-catalog.js";
import { isUntrustedSource } from "../core/agent-identity.js";
import { rememberScope } from "../core/remember-scope.js";
import type { BootInfo } from "./boot-info.js";
import { AppHeader, NavTabs, nextTab, Toast } from "./components/app-header.js";
import { CommandBar, type ConsoleEntry } from "./components/command-bar.js";
import { ConfirmBar, type PendingConfirm } from "./components/confirm-bar.js";
import { InboxPage } from "./pages/inbox-page.js";
import { secondsLeft } from "./approval-queue.js";
import { ApprovalQueueStrip } from "./components/approval-queue-strip.js";
import type { CommandEnv, TuiPage } from "./tui-commands.js";
import { useApprovalQueue } from "./use-approval-queue.js";
import { useInbox } from "./use-inbox.js";
import { useDashboardState } from "./use-dashboard-state.js";
import { useTerminalSize } from "./hooks.js";
import {
  ApprovalModal,
  type ApprovalResolution,
  type ResolvedBy,
} from "./components/approval-modal.js";
import { ActivityFeed } from "./components/activity-feed.js";
import { AgentList } from "./components/agent-list.js";
import { BootBanner } from "./components/boot-banner.js";
import { HelpOverlay } from "./components/help-overlay.js";
import { theme } from "./theme.js";
import { InspectView } from "./components/inspect-view.js";
import { StatsPanel } from "./components/stats-panel.js";
import { StatusBar } from "./components/status-bar.js";
import {
  DashboardProvider,
  useDashboardServices,
  type DashboardServices,
} from "./dashboard-context.js";
import { useLayout } from "./hooks.js";
import { exportLogs, LogsPage } from "./pages/logs-page.js";
import {
  DEFAULT_FILTERS,
  queryLogs,
  type LogFilters,
} from "./pages/logs-query.js";
import {
  ChatPage,
  parseChatPrompt,
  type ChatScrollbackEntry,
} from "./pages/chat-page.js";
import { PolicyPage } from "./pages/policy-page.js";
import { keysPageSecrets, REVEAL_AUTO_HIDE_MS, SecretsPage } from "./pages/secrets-page.js";
import { AgentsPage } from "./pages/agents-page.js";
import { ProvidersPage } from "./pages/providers-page.js";
import { ServicesPage } from "./pages/services-page.js";
import { DelegationsPage } from "./pages/delegations-page.js";
import { SessionsPage } from "./pages/sessions-page.js";
import { buildSettingsItems, SettingsPage } from "./pages/settings-page.js";
import { launchEditor } from "./launch-editor.js";
import { resolveAgentLoginSteps } from "../core/agent-login.js";

/** The boot banner shows this long (or until the first key). */
const BOOT_BANNER_MS = 3_500;
/** How long letter keys are ignored after the approval on screen changes. */
const KEY_SETTLE_MS = 600;

export type Page = TuiPage;

export interface AppProps {
  bootInfo: BootInfo;
  services: DashboardServices;
}

export function App({ bootInfo, services }: AppProps): JSX.Element {
  return (
    <DashboardProvider {...services}>
      <Shell bootInfo={bootInfo} />
    </DashboardProvider>
  );
}

function Shell({ bootInfo }: { bootInfo: BootInfo }): JSX.Element {
  const layout = useLayout();
  const { isRawModeSupported } = useStdin();
  const {
    bus,
    mediator,
    sqlite,
    policy,
    policyPath,
    sessionManager,
    soulPath,
    secretStore,
    registry,
    runInteractiveLogin,
    inbox: inboxService,
    pendingApprovals,
    approvalRecommendations,
    keySettleMs = KEY_SETTLE_MS,
    commandRouter,
    commandContext,
    audit,
    orgConfigPath,
  } = useDashboardServices();
  const { exit } = useApp();

  const [page, setPage] = useState<Page>("dashboard");
  const [quitConfirm, setQuitConfirm] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<{
    current: string;
    latest: string;
  } | null>(null);
  const [agentUpdates, setAgentUpdates] = useState<
    Array<{ id: string; displayName: string; current: string; latest: string }>
  >([]);
  const [agentOvershoots, setAgentOvershoots] = useState<
    Array<{
      id: string;
      displayName: string;
      installed: string;
      supportedRange: string;
    }>
  >([]);
  const [budgetAlertNotice, setBudgetAlertNotice] = useState<{
    kind: "threshold" | "exhausted";
    spentUsd: number;
    capUsd: number;
    spentPct: number;
    daysUntilReset: number;
  } | null>(null);
  const [daemonCrashes, setDaemonCrashes] = useState<
    Array<{
      agentId: string;
      exitCode: number;
      stderrHint: string;
      crashedAt: number;
    }>
  >([]);

  useEffect(() => {
    const offUpdate = bus.on("update:available", (e) => {
      setUpdateNotice({ current: e.current, latest: e.latest });
    });
    const offAgentUpdate = bus.on("agent-update:available", (e) => {
      setAgentUpdates(e.updates);
    });
    const offAgentOvershoot = bus.on("agent-update:overshoot", (e) => {
      setAgentOvershoots(e.warnings);
    });
    const offBudgetAlert = bus.on("llm:budget-alert", (e) => {
      setBudgetAlertNotice({
        kind: e.kind,
        spentUsd: e.spentUsd,
        capUsd: e.capUsd,
        spentPct: e.spentPct,
        daysUntilReset: e.daysUntilReset,
      });
    });
    const offDaemonCrashed = bus.on("agent:daemon-crashed", (e) => {
      // First non-empty line of stderr — keeps the banner narrow + actionable.
      const stderrHint =
        (e.stderr ?? "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? "";
      setDaemonCrashes((prev) => {
        // Dedupe by agentId — latest crash wins.
        const filtered = prev.filter((c) => c.agentId !== e.agentId);
        return [
          ...filtered,
          {
            agentId: e.agentId,
            exitCode: e.exitCode,
            stderrHint,
            crashedAt: e.crashedAt,
          },
        ];
      });
    });
    const offDaemonStarted = bus.on("agent:daemon-started", (e) => {
      setDaemonCrashes((prev) => prev.filter((c) => c.agentId !== e.agentId));
    });
    return () => {
      offUpdate();
      offAgentUpdate();
      offAgentOvershoot();
      offBudgetAlert();
      offDaemonCrashed();
      offDaemonStarted();
    };
  }, [bus]);

  const [policySelectedIdx, setPolicySelectedIdx] = useState(0);
  const [policyExpanded, setPolicyExpanded] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);

  const [sessionSelectedIdx, setSessionSelectedIdx] = useState(0);
  const [sessionExpanded, setSessionExpanded] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  // Delegations page state — mirrors the sessions page shape so the
  // selected-row / expanded / notice patterns stay uniform across
  // pages.
  const [delegationsSelectedIdx, setDelegationsSelectedIdx] = useState(0);
  const [delegationsExpanded, setDelegationsExpanded] = useState(false);
  const [delegationsNotice, setDelegationsNotice] = useState<string | null>(
    null,
  );

  const [chatAgentIdx, setChatAgentIdx] = useState(0);
  const [chatInputMode, setChatInputMode] = useState(false);
  const [chatInputBuffer, setChatInputBuffer] = useState("");
  const [chatScrollback, setChatScrollback] = useState<ChatScrollbackEntry[]>(
    [],
  );
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [settingsSelectedIdx, setSettingsSelectedIdx] = useState(0);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [secretsSelectedIdx, setSecretsSelectedIdx] = useState(0);
  const [secretsExpanded, setSecretsExpanded] = useState(false);
  const [secretsNotice, setSecretsNotice] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    name: string;
    value: string;
  } | null>(null);
  const [rotateMode, setRotateMode] = useState<{ name: string } | null>(null);
  const [addSecretMode, setAddSecretMode] = useState<
    { phase: "name" } | { phase: "value"; name: string } | null
  >(null);
  const [agentsSelectedIdx, setAgentsSelectedIdx] = useState(0);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [agentsNotice, setAgentsNotice] = useState<string | null>(null);
  const [agentsEditMode, setAgentsEditMode] = useState<"none" | "note" | "llm">(
    "none",
  );
  const [agentsLlmDraft, setAgentsLlmDraft] = useState<string | null>(null);
  // A delete / remove / regenerate waiting for y/N (#657).
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  // Every pending approval, oldest deadline first (#614).
  const queue = useApprovalQueue(bus, pendingApprovals, approvalRecommendations);
  const pendingApproval: ApprovalRequest | null = queue.current?.request ?? null;
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectOffset, setInspectOffset] = useState(0);
  const [technicalExpanded, setTechnicalExpanded] = useState(false);
  // A decision that waits for `y` (#656): "deny always" shows what it will
  // remember first.
  const [approvalConfirm, setApprovalConfirm] = useState<ApprovalResolution | null>(null);
  const inbox = useInbox(inboxService, bus);
  const [commandOpen, setCommandOpen] = useState(false);
  /** Providers / Services pages are taking typed text (they own their keys). */
  const [pageEditing, setPageEditing] = useState(false);
  useEffect(() => setPageEditing(false), [page]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [booting, setBooting] = useState(true);
  const terminal = useTerminalSize();

  const [logSearch, setLogSearch] = useState("");
  const [logSearchMode, setLogSearchMode] = useState(false);
  const [logFilters, setLogFilters] = useState<LogFilters>(DEFAULT_FILTERS);
  const [logSelectedIdx, setLogSelectedIdx] = useState(0);
  const [logExpanded, setLogExpanded] = useState(false);
  const [logExportNotice, setLogExportNotice] = useState<string | null>(null);
  const [logReplayNotice, setLogReplayNotice] = useState<string | null>(null);

  const pendingRef = useRef(pendingApproval);
  pendingRef.current = pendingApproval;

  // The boot banner gives way to the compact header after a moment.
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), BOOT_BANNER_MS);
    return () => clearTimeout(t);
  }, []);

  // A different approval on screen starts with its details collapsed.
  const currentApprovalId = pendingApproval?.requestId ?? null;

  // A letter key that lands right after the approval on screen changed was
  // meant for what was there before: a double tap, key repeat, or an
  // approval decided elsewhere a moment ago. Without this, `A A` would
  // always-allow two different requests, and a `d` meant for a vanished
  // approval would reach the page underneath (delete a key, disable a rule).
  const shownApprovalRef = useRef<string | null>(null);
  const approvalChangedAtRef = useRef(0);
  if (shownApprovalRef.current !== currentApprovalId) {
    shownApprovalRef.current = currentApprovalId;
    approvalChangedAtRef.current = Date.now();
  }
  const swallowUnsettledKey = useCallback((): boolean => {
    const now = Date.now();
    if (now - approvalChangedAtRef.current >= keySettleMs) return false;
    // Keep swallowing while keys keep coming (a held key).
    approvalChangedAtRef.current = now;
    return true;
  }, [keySettleMs]);
  useEffect(() => {
    setInspectOpen(false);
    setInspectOffset(0);
    setTechnicalExpanded(false);
    setApprovalConfirm(null);
  }, [currentApprovalId]);
  // What `A` / `D` would remember for the call on screen, from the same
  // function the mediator writes the rule with.
  const rememberText = useMemo(() => {
    if (!pendingApproval?.targetTool) return undefined;
    const scope = rememberScope(pendingApproval.sourceAgent, pendingApproval.targetTool, pendingApproval.args).summary;
    return isUntrustedSource(pendingApproval.sourceAgent)
      ? `${scope} (deny only: nothing is always-allowed for an unverified agent)`
      : scope;
  }, [pendingApproval]);

  // Decisions always name the request that was on screen when the key was
  // pressed. The TUI never times approvals out itself: the service that
  // asked owns the deadline and announces the outcome.
  const resolveApproval = useCallback(
    (resolution: ApprovalResolution, _by?: ResolvedBy): void => {
      const current = pendingRef.current;
      if (!current) return;
      queue.resolve(current.requestId, resolution);
    },
    [queue.resolve],
  );

  const onHaltSessionFromApproval = useCallback((): void => {
    const current = pendingRef.current;
    if (!current?.sessionId || !sessionManager) return;
    if (!current.riskFactors?.some((f) => f.category === "loop")) return;
    sessionManager.halt(current.sessionId, "loop_detection");
    resolveApproval({ decision: "denied" });
  }, [sessionManager, resolveApproval]);

  const remainingSeconds = queue.current ? secondsLeft(queue.current, queue.now) : 0;

  const selectedRequestId = useMemo(() => {
    if (page !== "logs") return null;
    const rows = queryLogs(sqlite, {
      search: logSearch,
      filters: logFilters,
      limit: 200,
    }).rows;
    return rows[logSelectedIdx]?.id ?? null;
  }, [page, sqlite, logSearch, logFilters, logSelectedIdx]);

  const onLogReplay = useCallback(async (): Promise<void> => {
    if (!mediator || !selectedRequestId) {
      setLogReplayNotice("replay unavailable");
      return;
    }
    try {
      const result = await mediator.replay(selectedRequestId);
      setLogReplayNotice(
        `replayed ${selectedRequestId} → ${result.decision} (${result.decidedBy})`,
      );
    } catch (err) {
      setLogReplayNotice(
        `replay failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [mediator, selectedRequestId]);

  const onLogExport = useCallback((): void => {
    const rows = queryLogs(sqlite, {
      search: logSearch,
      filters: logFilters,
      limit: 10_000,
    }).rows;
    const { path, count } = exportLogs(rows);
    setLogExportNotice(`exported ${count} rows → ${path}`);
  }, [sqlite, logSearch, logFilters]);

  const onPolicyToggle = useCallback((): void => {
    if (!policy) {
      setPolicyNotice("policy engine unavailable");
      return;
    }
    const rules = policy.list();
    const target = rules[policySelectedIdx];
    if (!target) return;
    try {
      policy.setEnabled(target.id, target.enabled === 0);
      setPolicyNotice(
        `rule #${target.id} ${target.enabled === 0 ? "enabled" : "disabled"}`,
      );
    } catch (err) {
      setPolicyNotice(
        `toggle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [policy, policySelectedIdx]);

  const onPolicyEdit = useCallback(async (): Promise<void> => {
    if (!policy || !policyPath) {
      setPolicyNotice("policy yaml path unavailable");
      return;
    }
    try {
      await launchEditor(policyPath);
      const result = policy.loadFromYaml(policyPath);
      setPolicyNotice(
        `reloaded ${result.rulesAdded} rule${result.rulesAdded === 1 ? "" : "s"} from yaml`,
      );
    } catch (err) {
      setPolicyNotice(
        `editor / reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [policy, policyPath]);

  const onSessionHalt = useCallback((): void => {
    if (!sessionManager) {
      setSessionNotice("session manager unavailable");
      return;
    }
    const all = sessionManager.list();
    const target = all[sessionSelectedIdx];
    if (!target) return;
    if (target.status !== "active") {
      setSessionNotice(`session ${target.id} already ${target.status}`);
      return;
    }
    sessionManager.halt(target.id, "manual");
    setSessionNotice(`session ${target.id} halted`);
  }, [sessionManager, sessionSelectedIdx]);

  const onChatSubmit = useCallback(
    async (raw: string): Promise<void> => {
      if (!mediator) {
        setChatNotice("mediator unavailable");
        setChatInputMode(false);
        return;
      }
      const agents = registry.list();
      const picked = agents[chatAgentIdx];
      if (!picked) {
        setChatNotice("no registered agent to send through");
        setChatInputMode(false);
        return;
      }
      const { tool, args } = parseChatPrompt(raw);
      if (!tool) {
        setChatNotice("input parses as empty — type a tool name first");
        return;
      }
      try {
        const result = await mediator.handleRequest({
          sourceAgent: picked.id,
          targetTool: tool,
          message: {
            jsonrpc: "2.0" as const,
            id: Date.now(),
            method: "tools/call",
            params: { name: tool, arguments: args ?? {} },
          } as never,
        });
        const entry: ChatScrollbackEntry = {
          id: result.requestId,
          ts: Date.now(),
          sourceAgent: picked.id,
          rawPrompt: raw,
          parsedTool: tool,
          parsedArgs: args,
          decision: result.decision,
          decidedBy: result.decidedBy,
          riskScore: result.riskScore,
          riskReasons: result.riskReasons,
          durationMs: result.durationMs,
        };
        setChatScrollback((prev) => [...prev, entry]);
        setChatInputBuffer("");
        setChatNotice(null);
      } catch (err) {
        setChatScrollback((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            ts: Date.now(),
            sourceAgent: picked.id,
            rawPrompt: raw,
            parsedTool: tool,
            parsedArgs: args,
            decision: "error" as const,
            decidedBy: "exception",
            riskScore: 0,
            riskReasons: [],
            durationMs: 0,
          },
        ]);
        setChatNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setChatInputMode(false);
      }
    },
    [mediator, registry, chatAgentIdx],
  );

  const onEditSoul = useCallback(async (): Promise<void> => {
    if (!soulPath) {
      setSettingsNotice("Foreman SOUL.md path unavailable");
      return;
    }
    try {
      await launchEditor(soulPath);
      setSettingsNotice(
        `✓ saved ${soulPath} — run 'foreman identity push' to propagate to agents`,
      );
    } catch (err) {
      setSettingsNotice(
        `editor failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [soulPath]);

  const onEditPolicyFromSettings = useCallback(async (): Promise<void> => {
    if (!policy || !policyPath) {
      setSettingsNotice("policy yaml path unavailable");
      return;
    }
    try {
      await launchEditor(policyPath);
      const result = policy.loadFromYaml(policyPath);
      setSettingsNotice(
        `✓ saved ${policyPath} — reloaded ${result.rulesAdded} rule${result.rulesAdded === 1 ? "" : "s"}`,
      );
    } catch (err) {
      setSettingsNotice(
        `editor / reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [policy, policyPath]);

  const onWizardInstruction = useCallback((): void => {
    setSettingsNotice(
      "press q to quit, then run: foreman setup --resume (or --reset for a clean wizard)",
    );
  }, []);
  const onSecretReveal = useCallback((): void => {
    if (!secretStore) return;
    const all = keysPageSecrets(secretStore);
    const target = all[secretsSelectedIdx];
    if (!target) return;
    try {
      const value = secretStore.get(target.name);
      setRevealedSecret({ name: target.name, value });
      setSecretsNotice(
        `revealing ${target.name} for ${REVEAL_AUTO_HIDE_MS / 1000}s`,
      );
    } catch (err) {
      setSecretsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [secretStore, secretsSelectedIdx]);

  // Auto-hide revealed secret after the configured TTL.
  useEffect(() => {
    if (!revealedSecret) return;
    const t = setTimeout(() => {
      setRevealedSecret(null);
      setSecretsNotice("value auto-hidden");
    }, REVEAL_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [revealedSecret]);

  const onSecretRotate = useCallback((): void => {
    if (!secretStore) return;
    const all = keysPageSecrets(secretStore);
    const target = all[secretsSelectedIdx];
    if (!target) return;
    setRotateMode({ name: target.name });
    setRevealedSecret(null);
  }, [secretStore, secretsSelectedIdx]);

  const onSubmitRotate = useCallback(
    (value: string): void => {
      if (!secretStore || !rotateMode) return;
      try {
        if (value.length === 0) {
          setSecretsNotice("rotate cancelled (empty input)");
        } else {
          secretStore.rotate(rotateMode.name, value);
          setSecretsNotice(`✓ ${rotateMode.name} rotated`);
        }
      } catch (err) {
        setSecretsNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setRotateMode(null);
      }
    },
    [secretStore, rotateMode],
  );

  // `d` only asks; the secret named in the question is the one deleted.
  const onSecretRemove = useCallback((): void => {
    if (!secretStore) return;
    // Agent identity tokens are not on this page, so `d` can't reach one.
    const target = keysPageSecrets(secretStore)[secretsSelectedIdx];
    if (!target) return;
    const name = target.name;
    setPendingConfirm({
      question: `Delete secret "${name}"? This can't be undone.`,
      yesLabel: "delete",
      run: () => {
        try {
          secretStore.remove(name);
          setSecretsNotice(`✓ ${name} removed`);
          setRevealedSecret(null);
          setSecretsSelectedIdx((idx) => Math.max(0, idx - 1));
        } catch (err) {
          setSecretsNotice(
            `error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });
  }, [secretStore, secretsSelectedIdx]);

  const onSecretAddStart = useCallback((): void => {
    setSecretsNotice(null);
    setAddSecretMode({ phase: "name" });
  }, []);

  const onSecretAddNameSubmit = useCallback((name: string): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setAddSecretMode(null);
      setSecretsNotice("add cancelled (empty name)");
      return;
    }
    setAddSecretMode({ phase: "value", name: trimmed });
  }, []);

  const onSecretAddValueSubmit = useCallback(
    (value: string): void => {
      if (!secretStore) return;
      if (!addSecretMode || addSecretMode.phase !== "value") return;
      const name = addSecretMode.name;
      if (value.length === 0) {
        setAddSecretMode(null);
        setSecretsNotice(`add ${name} cancelled (empty value)`);
        return;
      }
      try {
        if (secretStore.exists(name)) {
          secretStore.rotate(name, value);
          setSecretsNotice(`✓ ${name} already existed — value rotated instead`);
        } else {
          secretStore.add(name, value);
          setSecretsNotice(`✓ stored ${name}`);
        }
      } catch (err) {
        setSecretsNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      setAddSecretMode(null);
    },
    [secretStore, addSecretMode],
  );
  const onAgentToggleBlock = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    try {
      if (target.status === "blocked") {
        registry.unblock(target.id);
        setAgentsNotice(`✓ ${target.id} unblocked`);
      } else {
        registry.block(target.id);
        setAgentsNotice(`✓ ${target.id} blocked`);
      }
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentRegenKey = useCallback((): void => {
    const target = registry.listAll()[agentsSelectedIdx];
    if (!target) return;
    const id = target.id;
    setPendingConfirm({
      question: `Regenerate ${id}'s keypair? Its old key stops working at once.`,
      yesLabel: "regenerate",
      run: () => {
        try {
          const result = registry.regenerateKey(id);
          const hex = result.privateKey.toString("hex");
          setAgentsNotice(
            `✓ ${id} new private key (shown once): ${hex.slice(0, 16)}…${hex.slice(-8)}`,
          );
        } catch (err) {
          setAgentsNotice(
            `error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });
  }, [registry, agentsSelectedIdx]);

  // Removing here unregisters and takes Foreman's own wiring (its MCP
  // entry, the Claude Code hook) out of the agent's config; the binary
  // and the rest of its config stay (`foreman agent remove --uninstall` is
  // the only way Foreman uninstalls anything).
  const onAgentRemove = useCallback((): void => {
    const target = registry.listAll()[agentsSelectedIdx];
    if (!target) return;
    const id = target.id;
    const registryId =
      typeof target.metadata?.registryId === "string" ? target.metadata.registryId : null;
    setPendingConfirm({
      question: `Remove agent "${id}"? Foreman unregisters it, revokes its key and identity token and removes its foreman MCP entry. Its binary stays installed.`,
      yesLabel: "remove",
      run: () => {
        try {
          registry.remove(id);
          // A removed agent's identity token must not keep proving it (#618).
          if (secretStore) revokeAgentToken(secretStore, id);
          // Best-effort: never blocks the removal, only reports.
          let entry: AgentEntry | null = null;
          try {
            entry = registryId ? findAgent(loadActiveRegistry().doc, registryId) : null;
          } catch {
            entry = null;
          }
          const unwired = unwireAgent(id, entry);
          setAgentsNotice(
            `✓ ${id} removed (binary left installed)` +
              (unwired.removed.length > 0 ? ` · removed ${unwired.removed.join(", ")}` : "") +
              (unwired.notes.length > 0 ? ` · note: ${unwired.notes.join("; ")}` : ""),
          );
          setAgentsSelectedIdx((idx) => Math.max(0, idx - 1));
        } catch (err) {
          setAgentsNotice(
            `error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });
  }, [registry, secretStore, agentsSelectedIdx]);

  const onAgentDisable = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (target.status === "disabled") {
      setAgentsNotice(`${target.id} is already disabled`);
      return;
    }
    if (target.status === "blocked") {
      setAgentsNotice(`${target.id} is blocked — unblock first`);
      return;
    }
    try {
      registry.disable(target.id);
      setAgentsNotice(`✓ ${target.id} disabled`);
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentEnable = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (target.status !== "disabled") {
      setAgentsNotice(
        `${target.id} is not disabled (status: ${target.status})`,
      );
      return;
    }
    try {
      registry.enable(target.id);
      setAgentsNotice(`✓ ${target.id} enabled`);
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [registry, agentsSelectedIdx]);

  const onAgentLogin = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (!secretStore) {
      setAgentsNotice("secret store unavailable — cannot resolve login");
      return;
    }
    if (!runInteractiveLogin) {
      setAgentsNotice("interactive login is only available inside the TUI");
      return;
    }
    const registryId =
      typeof target.metadata?.registryId === "string"
        ? target.metadata.registryId
        : target.id;
    let steps;
    try {
      steps = resolveAgentLoginSteps(
        { registryId, llmProvider: target.llmProvider ?? null },
        secretStore,
      );
    } catch (err) {
      setAgentsNotice(
        `login lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (steps.length === 0) {
      setAgentsNotice(
        target.llmProvider
          ? `${target.id} authenticates via API key — add/rotate it on the Providers page [v]`
          : `${target.id} has no LLM provider set — press [L] to choose one first`,
      );
      return;
    }
    const results = runInteractiveLogin(
      steps.map((s) => ({
        agentId: s.agentId,
        command: s.command,
        verify: s.verify,
        mandatory: s.mandatory,
        reason: s.reason,
      })),
    );
    const ok = results.filter((r) => r.succeeded).length;
    setAgentsNotice(
      `login: ${ok}/${results.length} step(s) succeeded — run 'foreman doctor' to confirm`,
    );
  }, [registry, agentsSelectedIdx, secretStore, runInteractiveLogin]);

  const onAgentStartNoteEdit = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    setAgentsExpanded(true);
    setAgentsEditMode("note");
    setAgentsNotice(null);
  }, [registry, agentsSelectedIdx]);

  const onAgentStartLlmEdit = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    setAgentsExpanded(true);
    setAgentsLlmDraft(target.llmProvider ?? null);
    setAgentsEditMode("llm");
    setAgentsNotice(null);
  }, [registry, agentsSelectedIdx]);

  const onAgentSaveNote = useCallback(
    (value: string): void => {
      const all = registry.listAll();
      const target = all[agentsSelectedIdx];
      if (!target) return;
      try {
        const trimmed = value.length > 0 ? value : null;
        registry.setResponsibilityNote(target.id, trimmed);
        setAgentsNotice(
          trimmed
            ? `✓ ${target.id} responsibility updated`
            : `✓ ${target.id} responsibility cleared`,
        );
      } catch (err) {
        setAgentsNotice(
          `error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      setAgentsEditMode("none");
    },
    [registry, agentsSelectedIdx],
  );

  const onAgentSaveLlm = useCallback((): void => {
    const all = registry.listAll();
    const target = all[agentsSelectedIdx];
    if (!target) return;
    if (!agentsLlmDraft) {
      setAgentsEditMode("none");
      return;
    }
    try {
      registry.setLlmProvider(target.id, agentsLlmDraft);
      setAgentsNotice(`✓ ${target.id} LLM provider → ${agentsLlmDraft}`);
    } catch (err) {
      setAgentsNotice(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    setAgentsEditMode("none");
    setAgentsLlmDraft(null);
  }, [registry, agentsSelectedIdx, agentsLlmDraft]);

  const onAgentCancelEdit = useCallback((): void => {
    setAgentsEditMode("none");
    setAgentsLlmDraft(null);
  }, []);

  const queueCount = queue.state.items.length;
  const queueCountRef = useRef(queueCount);
  queueCountRef.current = queueCount;
  const queueItemsRef = useRef(queue.state.items);
  queueItemsRef.current = queue.state.items;
  const commandEnv = useMemo<CommandEnv>(
    () => ({
      dispatch: async (verb, args) => {
        if (!commandRouter || !commandContext) {
          return { ok: false, text: "Chat commands are not available in this session.", errorCode: "NOT_AVAILABLE" };
        }
        // The TUI is the owner at the host: no Telegram id to check.
        const result = await commandRouter.dispatch(verb, args, {
          ...commandContext,
          sourceAgent: "tui",
          sourceUser: "owner",
          trustedOwner: true,
        });
        audit?.logEvent("foreman:command", {
          command: verb,
          args,
          sourceAgent: "tui",
          sourceUser: "owner",
          ok: result.ok,
          errorCode: result.errorCode ?? null,
        });
        return result;
      },
      verbs: () => commandRouter?.listVerbs() ?? [],
      navigate: (next) => {
        setCommandOpen(false);
        setPage(next);
      },
      approvals: {
        current: () => pendingRef.current?.requestId ?? null,
        describe: (id) => {
          const req = queueItemsRef.current.find((q) => q.request.requestId === id)?.request;
          return req ? `${req.targetTool ?? req.targetAgent ?? "a tool"} for ${req.sourceAgent}` : null;
        },
        count: () => queueCountRef.current,
        resolve: (id, decision) => queue.resolve(id, decision),
      },
      inbox: { markAllRead: () => inbox.markAllRead() },
      agentIds: () => registry.list().map((a) => a.id),
      orgTargets: () => {
        try {
          const org = orgConfigPath ? loadOrg(orgConfigPath) : null;
          return org ? [...Object.keys(org.departments), ...Object.keys(org.roles)] : [];
        } catch {
          return [];
        }
      },
      quit: () => exit(),
    }),
    [commandRouter, commandContext, audit, queue.resolve, inbox.markAllRead, registry, orgConfigPath, exit],
  );

  const dashboard = useDashboardState();
  const headerStats = {
    agentsOnline: dashboard.agents.filter((a) => a.status === "active").length,
    agentsTotal: dashboard.agents.length,
    pendingApprovals: queueCount,
    unread: inbox.unread,
    allowedToday: dashboard.todayStats.allowed,
    deniedToday: dashboard.todayStats.denied,
  };
  // Rows left for the page between the chrome (header, tabs, toast, bar).
  const pageHeight = Math.max(8, terminal.rows - 6 - (inbox.toast ? 1 : 0));

  return (
    <Box flexDirection="column">
      {isRawModeSupported && (
        <KeyboardHandler
          page={page}
          setPage={setPage}
          quitConfirm={quitConfirm}
          setQuitConfirm={setQuitConfirm}
          helpOpen={helpOpen}
          setHelpOpen={setHelpOpen}
          pendingApproval={pendingApproval}
          inspectOpen={inspectOpen}
          setInspectOpen={setInspectOpen}
          inspectOffset={inspectOffset}
          setInspectOffset={setInspectOffset}
          technicalExpanded={technicalExpanded}
          setTechnicalExpanded={setTechnicalExpanded}
          onResolveApproval={resolveApproval}
          approvalConfirm={approvalConfirm}
          setApprovalConfirm={setApprovalConfirm}
          onHaltSessionFromApproval={onHaltSessionFromApproval}
          logSearch={logSearch}
          setLogSearch={setLogSearch}
          logSearchMode={logSearchMode}
          setLogSearchMode={setLogSearchMode}
          logFilters={logFilters}
          setLogFilters={setLogFilters}
          logSelectedIdx={logSelectedIdx}
          setLogSelectedIdx={setLogSelectedIdx}
          logExpanded={logExpanded}
          setLogExpanded={setLogExpanded}
          onLogReplay={onLogReplay}
          onLogExport={onLogExport}
          policySelectedIdx={policySelectedIdx}
          setPolicySelectedIdx={setPolicySelectedIdx}
          policyExpanded={policyExpanded}
          setPolicyExpanded={setPolicyExpanded}
          onPolicyToggle={onPolicyToggle}
          onPolicyEdit={onPolicyEdit}
          sessionSelectedIdx={sessionSelectedIdx}
          setSessionSelectedIdx={setSessionSelectedIdx}
          sessionExpanded={sessionExpanded}
          setSessionExpanded={setSessionExpanded}
          onSessionHalt={onSessionHalt}
          delegationsSelectedIdx={delegationsSelectedIdx}
          setDelegationsSelectedIdx={setDelegationsSelectedIdx}
          delegationsExpanded={delegationsExpanded}
          setDelegationsExpanded={setDelegationsExpanded}
          setDelegationsNotice={setDelegationsNotice}
          chatAgentIdx={chatAgentIdx}
          setChatAgentIdx={setChatAgentIdx}
          chatInputMode={chatInputMode}
          setChatInputMode={setChatInputMode}
          registeredAgentCount={registry.list().length}
          settingsSelectedIdx={settingsSelectedIdx}
          setSettingsSelectedIdx={setSettingsSelectedIdx}
          onEditSoul={onEditSoul}
          onEditPolicyFromSettings={onEditPolicyFromSettings}
          onWizardInstruction={onWizardInstruction}
          settingsItemCount={
            buildSettingsItems(soulPath ?? null, policyPath ?? null).length
          }
          secretsSelectedIdx={secretsSelectedIdx}
          setSecretsSelectedIdx={setSecretsSelectedIdx}
          secretsExpanded={secretsExpanded}
          setSecretsExpanded={setSecretsExpanded}
          rotateMode={rotateMode}
          setRotateMode={setRotateMode}
          addSecretMode={addSecretMode}
          setAddSecretMode={setAddSecretMode}
          onSecretReveal={onSecretReveal}
          onSecretRotate={onSecretRotate}
          onSecretRemove={onSecretRemove}
          onSecretAddStart={onSecretAddStart}
          agentsSelectedIdx={agentsSelectedIdx}
          setAgentsSelectedIdx={setAgentsSelectedIdx}
          agentsExpanded={agentsExpanded}
          setAgentsExpanded={setAgentsExpanded}
          onAgentToggleBlock={onAgentToggleBlock}
          onAgentRegenKey={onAgentRegenKey}
          onAgentRemove={onAgentRemove}
          onAgentDisable={onAgentDisable}
          onAgentEnable={onAgentEnable}
          onAgentLogin={onAgentLogin}
          agentsEditMode={agentsEditMode}
          pageEditing={pageEditing}
          onAgentStartNoteEdit={onAgentStartNoteEdit}
          onAgentStartLlmEdit={onAgentStartLlmEdit}
          onAgentSaveLlm={onAgentSaveLlm}
          onAgentCancelEdit={onAgentCancelEdit}
          commandOpen={commandOpen}
          openCommand={() => {
            setBooting(false);
            setCommandOpen(true);
          }}
          pendingConfirm={pendingConfirm !== null}
          onConfirmAnswer={(yes) => {
            const current = pendingConfirm;
            setPendingConfirm(null);
            if (yes) current?.run();
          }}
          onMoveApproval={queue.move}
          onAnyKey={() => setBooting(false)}
          swallowUnsettledKey={swallowUnsettledKey}
        />
      )}
      {booting && !pendingApproval ? (
        // Splash: the banner alone, until a key or a moment passes.
        <BootBanner
          info={bootInfo}
          animationsEnabled={isRawModeSupported}
          updateNotice={updateNotice}
          agentUpdates={agentUpdates}
          agentOvershoots={agentOvershoots}
          daemonCrashes={daemonCrashes.map((c) => ({
            agentId: c.agentId,
            exitCode: c.exitCode,
            stderrHint: c.stderrHint,
          }))}
        />
      ) : (
        <>
      <AppHeader stats={headerStats} width={terminal.cols} />
      <NavTabs page={page} unread={inbox.unread} width={terminal.cols} />
      {inbox.toast && page !== "inbox" && !pendingApproval ? <Toast item={inbox.toast} /> : null}
      {budgetAlertNotice ? (
        <Box paddingX={1}>
          <Text
            color={
              budgetAlertNotice.kind === "exhausted"
                ? theme.accent.danger
                : theme.accent.warning
            }
          >
            {budgetAlertNotice.kind === "exhausted" ? "✗" : "⚠"} LLM budget{" "}
            {budgetAlertNotice.kind === "exhausted"
              ? "EXHAUSTED"
              : `${budgetAlertNotice.spentPct.toFixed(0)}% spent`}
            {" — "}${budgetAlertNotice.spentUsd.toFixed(2)} of $
            {budgetAlertNotice.capUsd.toFixed(2)}, resets in{" "}
            {budgetAlertNotice.daysUntilReset} day
            {budgetAlertNotice.daysUntilReset === 1 ? "" : "s"}
          </Text>
        </Box>
      ) : null}
      {helpOpen ? (
        <HelpOverlay width={terminal.cols} height={pageHeight + 1} />
      ) : commandOpen ? (
        <Box flexDirection="column">
          {pendingApproval ? (
            <Box paddingX={1}>
              <Text color={theme.accent.warning} bold>
                {`${theme.symbols.warn} ${queueCount} approval${queueCount === 1 ? "" : "s"} waiting`}
              </Text>
              <Text color={theme.fg.muted}>
                {` — ${pendingApproval.sourceAgent} → ${pendingApproval.targetTool ?? pendingApproval.targetAgent ?? "?"} · type approve / deny, or Esc to see it`}
              </Text>
            </Box>
          ) : null}
          <CommandBar
            env={commandEnv}
            onClose={() => setCommandOpen(false)}
            width={terminal.cols}
            height={pageHeight + 1 - (pendingApproval ? 1 : 0)}
            history={commandHistory}
            onHistory={setCommandHistory}
            scrollback={consoleEntries}
            onScrollback={setConsoleEntries}
          />
        </Box>
      ) : pendingApproval ? (
        <Box flexDirection="column">
          <ApprovalQueueStrip state={queue.state} now={queue.now} />
          {inspectOpen ? (
            <InspectView
              request={pendingApproval}
              offset={inspectOffset}
              setOffset={setInspectOffset}
              remainingSeconds={remainingSeconds}
            />
          ) : (
            <ApprovalModal
              request={pendingApproval}
              remainingSeconds={remainingSeconds}
              technicalExpanded={technicalExpanded}
              recommendations={queue.current?.recommendations ?? []}
              {...(rememberText ? { rememberScope: rememberText } : {})}
              confirm={approvalConfirm ? confirmText(approvalConfirm, rememberText, pendingApproval) : null}
              maxRows={pageHeight + 1 - (queueCount > 1 ? 1 : 0)}
            />
          )}
        </Box>
      ) : page === "inbox" ? (
        <InboxPage
          items={inbox.items}
          unread={inbox.unread}
          onMarkRead={inbox.markRead}
          onMarkAllRead={() => {
            inbox.markAllRead();
          }}
          active={!commandOpen && !helpOpen && !quitConfirm}
          height={pageHeight}
        />
      ) : page === "logs" ? (
        <LogsPage
          search={logSearch}
          searchMode={logSearchMode}
          filters={logFilters}
          selectedIdx={logSelectedIdx}
          expanded={logExpanded}
          exportNotice={logExportNotice}
          replayNotice={logReplayNotice}
        />
      ) : page === "policy" ? (
        <PolicyPage
          selectedIdx={policySelectedIdx}
          expanded={policyExpanded}
          notice={policyNotice}
        />
      ) : page === "sessions" ? (
        <SessionsPage
          selectedIdx={sessionSelectedIdx}
          expanded={sessionExpanded}
          notice={sessionNotice}
        />
      ) : page === "delegations" ? (
        <DelegationsPage
          selectedIdx={delegationsSelectedIdx}
          expanded={delegationsExpanded}
          notice={delegationsNotice}
        />
      ) : page === "chat" ? (
        <ChatPage
          selectedAgentIdx={chatAgentIdx}
          inputMode={chatInputMode}
          inputBuffer={chatInputBuffer}
          setInputBuffer={setChatInputBuffer}
          scrollback={chatScrollback}
          onSubmit={(raw) => void onChatSubmit(raw)}
          notice={chatNotice}
        />
      ) : page === "settings" ? (
        <SettingsPage
          selectedIdx={settingsSelectedIdx}
          notice={settingsNotice}
        />
      ) : page === "secrets" ? (
        <SecretsPage
          selectedIdx={secretsSelectedIdx}
          expanded={secretsExpanded}
          notice={secretsNotice}
          revealedName={revealedSecret?.name ?? null}
          revealedValue={revealedSecret?.value ?? null}
          rotateMode={rotateMode}
          onSubmitRotate={onSubmitRotate}
          addSecretMode={addSecretMode}
          onAddSecretNameSubmit={onSecretAddNameSubmit}
          onAddSecretValueSubmit={onSecretAddValueSubmit}
        />
      ) : page === "agents" ? (
        <AgentsPage
          selectedIdx={agentsSelectedIdx}
          expanded={agentsExpanded}
          notice={agentsNotice}
          editMode={agentsEditMode}
          llmDraft={agentsLlmDraft}
          onLlmDraftChange={setAgentsLlmDraft}
          onNoteSubmit={onAgentSaveNote}
          daemonCrashes={daemonCrashes}
        />
      ) : page === "providers" ? (
        <ProvidersPage onLeave={() => setPage("dashboard")} onEditingChange={setPageEditing} />
      ) : page === "services" ? (
        <ServicesPage onLeave={() => setPage("dashboard")} onEditingChange={setPageEditing} />
      ) : (
        <Box height={pageHeight}>{renderPanels(layout)}</Box>
      )}
      {commandOpen ? null : pendingConfirm && !pendingApproval && !helpOpen ? (
        <ConfirmBar confirm={pendingConfirm} />
      ) : (
        <StatusBar quitConfirm={quitConfirm} page={page} approval={pendingApproval !== null && !helpOpen} />
      )}
        </>
      )}
    </Box>
  );
}

interface KeyboardHandlerProps {
  page: Page;
  setPage: (p: Page) => void;
  quitConfirm: boolean;
  setQuitConfirm: (v: boolean) => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
  pendingApproval: ApprovalRequest | null;
  inspectOpen: boolean;
  setInspectOpen: (v: boolean) => void;
  inspectOffset: number;
  setInspectOffset: (next: number) => void;
  technicalExpanded: boolean;
  setTechnicalExpanded: (v: boolean) => void;
  onResolveApproval: (r: ApprovalResolution, by: ResolvedBy) => void;
  approvalConfirm: ApprovalResolution | null;
  setApprovalConfirm: (next: ApprovalResolution | null) => void;
  onHaltSessionFromApproval: () => void;
  logSearch: string;
  setLogSearch: (next: string) => void;
  logSearchMode: boolean;
  setLogSearchMode: (v: boolean) => void;
  logFilters: LogFilters;
  setLogFilters: (next: LogFilters) => void;
  logSelectedIdx: number;
  setLogSelectedIdx: (next: number) => void;
  logExpanded: boolean;
  setLogExpanded: (v: boolean) => void;
  onLogReplay: () => Promise<void>;
  onLogExport: () => void;
  policySelectedIdx: number;
  setPolicySelectedIdx: (next: number) => void;
  policyExpanded: boolean;
  setPolicyExpanded: (v: boolean) => void;
  onPolicyToggle: () => void;
  onPolicyEdit: () => Promise<void>;
  sessionSelectedIdx: number;
  setSessionSelectedIdx: (next: number) => void;
  sessionExpanded: boolean;
  setSessionExpanded: (v: boolean) => void;
  onSessionHalt: () => void;
  delegationsSelectedIdx: number;
  setDelegationsSelectedIdx: (next: number) => void;
  delegationsExpanded: boolean;
  setDelegationsExpanded: (v: boolean) => void;
  setDelegationsNotice: (v: string | null) => void;
  chatAgentIdx: number;
  setChatAgentIdx: (next: number | ((prev: number) => number)) => void;
  chatInputMode: boolean;
  setChatInputMode: (v: boolean) => void;
  registeredAgentCount: number;
  settingsSelectedIdx: number;
  setSettingsSelectedIdx: (next: number) => void;
  settingsItemCount: number;
  onEditSoul: () => Promise<void>;
  onEditPolicyFromSettings: () => Promise<void>;
  onWizardInstruction: () => void;
  secretsSelectedIdx: number;
  setSecretsSelectedIdx: (next: number | ((prev: number) => number)) => void;
  secretsExpanded: boolean;
  setSecretsExpanded: (v: boolean) => void;
  rotateMode: { name: string } | null;
  setRotateMode: (next: { name: string } | null) => void;
  addSecretMode: { phase: "name" } | { phase: "value"; name: string } | null;
  setAddSecretMode: (
    next: { phase: "name" } | { phase: "value"; name: string } | null,
  ) => void;
  onSecretReveal: () => void;
  onSecretRotate: () => void;
  onSecretRemove: () => void;
  onSecretAddStart: () => void;
  agentsSelectedIdx: number;
  setAgentsSelectedIdx: (next: number | ((prev: number) => number)) => void;
  agentsExpanded: boolean;
  setAgentsExpanded: (v: boolean) => void;
  onAgentToggleBlock: () => void;
  onAgentRegenKey: () => void;
  onAgentRemove: () => void;
  onAgentDisable: () => void;
  onAgentEnable: () => void;
  onAgentLogin: () => void;
  agentsEditMode: "none" | "note" | "llm";
  pageEditing: boolean;
  onAgentStartNoteEdit: () => void;
  onAgentStartLlmEdit: () => void;
  onAgentSaveLlm: () => void;
  onAgentCancelEdit: () => void;
  commandOpen: boolean;
  openCommand: () => void;
  /** A y/N question (delete, remove, regenerate) is open. */
  pendingConfirm: boolean;
  onConfirmAnswer: (yes: boolean) => void;
  onMoveApproval: (delta: number) => void;
  onAnyKey: () => void;
  /** True when a letter key should be ignored because the approval on
   *  screen just changed. */
  swallowUnsettledKey: () => boolean;
}

function KeyboardHandler(props: KeyboardHandlerProps): null {
  const { exit } = useApp();
  const {
    page,
    setPage,
    quitConfirm,
    setQuitConfirm,
    helpOpen,
    setHelpOpen,
    pendingApproval,
    inspectOpen,
    setInspectOpen,
    inspectOffset,
    setInspectOffset,
    technicalExpanded,
    setTechnicalExpanded,
    onResolveApproval,
    approvalConfirm,
    setApprovalConfirm,
    onHaltSessionFromApproval,
    logSearch,
    setLogSearch,
    logSearchMode,
    setLogSearchMode,
    logFilters,
    setLogFilters,
    logSelectedIdx,
    setLogSelectedIdx,
    logExpanded,
    setLogExpanded,
    onLogReplay,
    onLogExport,
    policySelectedIdx,
    setPolicySelectedIdx,
    policyExpanded,
    setPolicyExpanded,
    onPolicyToggle,
    onPolicyEdit,
    sessionSelectedIdx,
    setSessionSelectedIdx,
    sessionExpanded,
    setSessionExpanded,
    onSessionHalt,
    delegationsSelectedIdx,
    setDelegationsSelectedIdx,
    delegationsExpanded,
    setDelegationsExpanded,
    setDelegationsNotice,
    chatAgentIdx,
    setChatAgentIdx,
    chatInputMode,
    setChatInputMode,
    registeredAgentCount,
    settingsSelectedIdx,
    setSettingsSelectedIdx,
    settingsItemCount,
    onEditSoul,
    onEditPolicyFromSettings,
    onWizardInstruction,
    secretsSelectedIdx,
    setSecretsSelectedIdx,
    secretsExpanded,
    setSecretsExpanded,
    rotateMode,
    setRotateMode,
    addSecretMode,
    setAddSecretMode,
    onSecretReveal,
    onSecretRotate,
    onSecretRemove,
    onSecretAddStart,
    agentsSelectedIdx,
    setAgentsSelectedIdx,
    agentsExpanded,
    setAgentsExpanded,
    onAgentToggleBlock,
    onAgentRegenKey,
    onAgentRemove,
    onAgentDisable,
    onAgentEnable,
    onAgentLogin,
    agentsEditMode,
    pageEditing,
    onAgentStartNoteEdit,
    onAgentStartLlmEdit,
    onAgentSaveLlm,
    onAgentCancelEdit,
    commandOpen,
    openCommand,
    pendingConfirm,
    onConfirmAnswer,
    onMoveApproval,
    onAnyKey,
    swallowUnsettledKey,
  } = props;

  useInput((input, key) => {
    onAnyKey();
    // `q` and Ctrl-C quit the same way everywhere (#657): at once, or after
    // a y/n question while approvals are waiting (#637). Quitting never
    // decides anything: waiting calls fail closed when they time out.
    const requestQuit = (): void => {
      if (!pendingApproval) {
        exit();
        return;
      }
      // One y/n question at a time: an allow or "deny always" waiting for
      // its `y` (#656) is dropped, so the next `y` can only mean "quit";
      // `n` goes back to the call, nothing decided.
      setApprovalConfirm(null);
      setQuitConfirm(true);
    };
    const ctrlC = key.ctrl && input === "c";
    if (quitConfirm) {
      if (input === "y" || input === "Y") exit();
      else if (input === "n" || input === "N" || key.escape) setQuitConfirm(false);
      return;
    }
    if (ctrlC) {
      requestQuit();
      return;
    }
    // The command bar owns the keyboard while it is open.
    if (commandOpen) return;
    // Help overlay takes priority — when open, Esc / `?` / `h` close it.
    if (helpOpen) {
      if (key.escape || input === "?" || input === "h") setHelpOpen(false);
      return;
    }
    // Keys that work on every page, unless the page is taking typed text.
    const textEntry =
      (page === "logs" && logSearchMode) ||
      (page === "chat" && chatInputMode) ||
      (page === "secrets" && (addSecretMode !== null || rotateMode !== null)) ||
      (page === "agents" && agentsEditMode !== "none") ||
      ((page === "providers" || page === "services") && pageEditing);
    const letter = /^[a-zA-Z]$/.test(input) && !key.ctrl && !key.meta;
    if (letter && (pendingApproval || !textEntry) && swallowUnsettledKey()) return;
    // A delete / remove question on screen takes `q` as "no" (below).
    if (
      input === "q" &&
      !key.meta &&
      (pendingApproval || !textEntry) &&
      !(pendingConfirm && !pendingApproval)
    ) {
      requestQuit();
      return;
    }
    // A decision waiting for its confirmation: `y` decides, `n` / Esc go
    // back, anything else is ignored (#656).
    if (pendingApproval && approvalConfirm) {
      if (input === "y" || input === "Y") {
        setApprovalConfirm(null);
        onResolveApproval(approvalConfirm, "user");
      } else if (input === "n" || input === "N" || key.escape) {
        setApprovalConfirm(null);
      }
      return;
    }
    if (pendingApproval && inspectOpen) {
      if (key.escape) {
        setInspectOpen(false);
        return;
      }
      if (key.upArrow) {
        setInspectOffset(Math.max(0, inspectOffset - 1));
        return;
      }
      if (key.downArrow) {
        setInspectOffset(inspectOffset + 1);
        return;
      }
      if (key.pageUp) {
        setInspectOffset(Math.max(0, inspectOffset - 10));
        return;
      }
      if (key.pageDown) {
        setInspectOffset(inspectOffset + 10);
        return;
      }
      if (input === "a") {
        if (needsSecondKey(pendingApproval)) {
          // The question is on the modal, not the inspector.
          setInspectOpen(false);
          setApprovalConfirm({ decision: "allowed" });
        } else onResolveApproval({ decision: "allowed" }, "user");
      } else if (input === "d") onResolveApproval({ decision: "denied" }, "user");
      return;
    }
    if (pendingApproval) {
      if (key.leftArrow || input === "[") {
        onMoveApproval(-1);
        return;
      }
      if (key.rightArrow || input === "]") {
        onMoveApproval(1);
        return;
      }
      if (input === ":") {
        openCommand();
        return;
      }
      // Allowing a high- or critical-risk call takes a second, deliberate
      // key (#656): one stray `a` (the Agents hotkey elsewhere) must not
      // let `rm -rf /` through.
      if (input === "a") {
        if (needsSecondKey(pendingApproval)) setApprovalConfirm({ decision: "allowed" });
        else onResolveApproval({ decision: "allowed" }, "user");
      } else if (input === "A") {
        if (needsSecondKey(pendingApproval)) setApprovalConfirm({ decision: "allowed", remember: "allow" });
        else onResolveApproval({ decision: "allowed", remember: "allow" }, "user");
      } else if (input === "d") onResolveApproval({ decision: "denied" }, "user");
      else if (input === "D") setApprovalConfirm({ decision: "denied", remember: "deny" });
      else if (input === "i") setInspectOpen(true);
      else if (input === "t") setTechnicalExpanded(!technicalExpanded);
      else if (input === "k") onHaltSessionFromApproval();
      return;
    }
    // [y/N]: only `y` goes ahead; any other key keeps things as they are.
    if (pendingConfirm) {
      onConfirmAnswer(input === "y" || input === "Y");
      return;
    }
    if (!textEntry && !quitConfirm) {
      if (input === ":") {
        openCommand();
        return;
      }
      if (key.tab) {
        setPage(nextTab(page, key.shift ? -1 : 1));
        return;
      }
      // Secrets, Providers and Services use `n` for "new".
      if (input === "n" && page !== "secrets" && page !== "providers" && page !== "services") {
        setPage("inbox");
        return;
      }
    }
    if (page === "inbox") {
      // The page handles its own keys; only leaving is handled here.
      if (key.escape) setPage("dashboard");
      return;
    }
    if (page === "logs") {
      if (logSearchMode) {
        if (key.escape) {
          setLogSearchMode(false);
          setLogSearch("");
          return;
        }
        if (key.return) {
          setLogSearchMode(false);
          return;
        }
        if (key.backspace || key.delete) {
          setLogSearch(logSearch.slice(0, -1));
          return;
        }
        if (input && input.length === 1) {
          setLogSearch(logSearch + input);
        }
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        setLogExpanded(false);
        return;
      }
      if (input === "/") {
        setLogSearchMode(true);
        return;
      }
      if (input === "1")
        setLogFilters({ ...logFilters, allowed: !logFilters.allowed });
      else if (input === "2")
        setLogFilters({ ...logFilters, denied: !logFilters.denied });
      else if (input === "3")
        setLogFilters({ ...logFilters, ask: !logFilters.ask });
      else if (input === "4")
        setLogFilters({ ...logFilters, errored: !logFilters.errored });
      else if (key.upArrow) {
        setLogSelectedIdx(Math.max(0, logSelectedIdx - 1));
        setLogExpanded(false);
      } else if (key.downArrow) {
        setLogSelectedIdx(logSelectedIdx + 1);
        setLogExpanded(false);
      } else if (key.return) setLogExpanded(!logExpanded);
      else if (input === "r") void onLogReplay();
      else if (input === "e") onLogExport();
      return;
    }
    if (page === "policy") {
      if (key.escape) {
        setPage("dashboard");
        setPolicyExpanded(false);
        return;
      }
      if (key.upArrow) {
        setPolicySelectedIdx(Math.max(0, policySelectedIdx - 1));
        setPolicyExpanded(false);
      } else if (key.downArrow) {
        setPolicySelectedIdx(policySelectedIdx + 1);
        setPolicyExpanded(false);
      } else if (key.return) setPolicyExpanded(!policyExpanded);
      else if (input === "d") onPolicyToggle();
      else if (input === "e") void onPolicyEdit();
      return;
    }
    if (page === "sessions") {
      if (key.escape) {
        setPage("dashboard");
        setSessionExpanded(false);
        return;
      }
      if (key.upArrow) {
        setSessionSelectedIdx(Math.max(0, sessionSelectedIdx - 1));
        setSessionExpanded(false);
      } else if (key.downArrow) {
        setSessionSelectedIdx(sessionSelectedIdx + 1);
        setSessionExpanded(false);
      } else if (key.return) setSessionExpanded(!sessionExpanded);
      else if (input === "k") onSessionHalt();
      return;
    }
    if (page === "delegations") {
      if (key.escape) {
        setPage("dashboard");
        setDelegationsExpanded(false);
        setDelegationsNotice(null);
        return;
      }
      if (key.upArrow) {
        setDelegationsSelectedIdx(Math.max(0, delegationsSelectedIdx - 1));
        setDelegationsExpanded(false);
      } else if (key.downArrow) {
        setDelegationsSelectedIdx(delegationsSelectedIdx + 1);
        setDelegationsExpanded(false);
      } else if (key.return) {
        setDelegationsExpanded(!delegationsExpanded);
      }
      return;
    }
    if (page === "chat") {
      if (chatInputMode) {
        if (key.escape) setChatInputMode(false);
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        return;
      }
      if (input === "i") {
        setChatInputMode(true);
        return;
      }
      if (key.leftArrow) {
        setChatAgentIdx((idx) => Math.max(0, idx - 1));
        return;
      }
      if (key.rightArrow) {
        setChatAgentIdx((idx) =>
          Math.min(Math.max(0, registeredAgentCount - 1), idx + 1),
        );
        return;
      }
      return;
    }
    if (page === "settings") {
      if (key.escape) {
        setPage("dashboard");
        return;
      }
      if (key.upArrow) {
        setSettingsSelectedIdx(Math.max(0, settingsSelectedIdx - 1));
        return;
      }
      if (key.downArrow) {
        setSettingsSelectedIdx(
          Math.min(settingsItemCount - 1, settingsSelectedIdx + 1),
        );
        return;
      }
      if (input === "e") void onEditSoul();
      else if (input === "p") void onEditPolicyFromSettings();
      else if (input === "P") setPage("policy");
      else if (input === "w") onWizardInstruction();
      else if (key.return) {
        if (settingsSelectedIdx === 0) void onEditSoul();
        else if (settingsSelectedIdx === 1) void onEditPolicyFromSettings();
        else if (settingsSelectedIdx === 2) setPage("policy");
        else if (settingsSelectedIdx === 3) onWizardInstruction();
      }
      return;
    }
    if (page === "secrets") {
      if (addSecretMode) {
        // TextInput / PasswordInput inside the page handle Enter via their
        // own onSubmit; we only intercept Esc to cancel.
        if (key.escape) setAddSecretMode(null);
        return;
      }
      if (rotateMode) {
        if (key.escape) setRotateMode(null);
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        setSecretsExpanded(false);
        return;
      }
      if (key.upArrow) {
        setSecretsSelectedIdx(Math.max(0, secretsSelectedIdx - 1));
        setSecretsExpanded(false);
      } else if (key.downArrow) {
        setSecretsSelectedIdx(secretsSelectedIdx + 1);
        setSecretsExpanded(false);
      } else if (key.return) setSecretsExpanded(!secretsExpanded);
      else if (input === "v") onSecretReveal();
      else if (input === "r") onSecretRotate();
      else if (input === "d") onSecretRemove();
      else if (input === "n") onSecretAddStart();
      return;
    }
    if (page === "agents") {
      // While editing the responsibility note, TextInput handles Enter via
      // its own onSubmit; we only intercept Esc to cancel + restore focus.
      if (agentsEditMode === "note") {
        if (key.escape) onAgentCancelEdit();
        return;
      }
      // LLM Select has no onSubmit — Enter commits the staged draft.
      if (agentsEditMode === "llm") {
        if (key.escape) onAgentCancelEdit();
        else if (key.return) onAgentSaveLlm();
        return;
      }
      if (key.escape) {
        setPage("dashboard");
        setAgentsExpanded(false);
        return;
      }
      if (key.upArrow) {
        setAgentsSelectedIdx(Math.max(0, agentsSelectedIdx - 1));
        setAgentsExpanded(false);
      } else if (key.downArrow) {
        setAgentsSelectedIdx(agentsSelectedIdx + 1);
        setAgentsExpanded(false);
      } else if (key.return) setAgentsExpanded(!agentsExpanded);
      else if (input === "b") onAgentToggleBlock();
      else if (input === "d") onAgentDisable();
      else if (input === "e") onAgentEnable();
      else if (input === "x") onAgentRemove();
      else if (input === "r") onAgentRegenKey();
      else if (input === "N") onAgentStartNoteEdit();
      else if (input === "L") onAgentStartLlmEdit();
      else if (input === "o") onAgentLogin();
      return;
    }
    // ProvidersPage / ServicesPage run their own useInput; short-circuit
    // here so a key (e.g. `s` for show-value) isn't double-handled by the
    // global dispatch (which would simultaneously try to setPage('sessions')).
    if (page === "providers" || page === "services") return;
    if (input === "/") openCommand();
    else if (input === "?" || input === "h") setHelpOpen(true);
    else if (input === "c") setPage("chat");
    else if (input === "g") setPage("settings");
    else if (input === "k") setPage("secrets");
    else if (input === "a") setPage("agents");
    else if (input === "v") setPage("providers");
    else if (input === "V") setPage("services");
    else if (input === "l") setPage("logs");
    else if (input === "p") setPage("policy");
    else if (input === "s") setPage("sessions");
    else if (input === "d") setPage("delegations");
  });
  return null;
}

function renderPanels(layout: "wide" | "medium" | "narrow"): JSX.Element {
  if (layout === "wide") {
    return (
      <>
        <AgentList width="20%" />
        <ActivityFeed width="60%" />
        <StatsPanel width="20%" />
      </>
    );
  }
  if (layout === "medium") {
    return (
      <Box flexDirection="column" width="100%">
        <AgentList compact />
        <ActivityFeed />
      </Box>
    );
  }
  return <ActivityFeed minimal />;
}

/** Allowing a call at or above this risk takes `a` then `y` (#656). */
function needsSecondKey(request: ApprovalRequest): boolean {
  return request.riskBucket === "high" || request.riskBucket === "critical";
}

/** The question a decision waiting for `y` asks (#656). */
function confirmText(
  resolution: ApprovalResolution,
  scope: string | undefined,
  request: ApprovalRequest,
): string {
  const risk = request.riskBucket ? `${request.riskBucket.toUpperCase()}-risk ` : "";
  if (resolution.remember === "deny") return `Deny always: ${scope ?? "this call"}?`;
  if (resolution.remember === "allow") return `Always allow this ${risk}call: ${scope ?? "this call"}?`;
  return resolution.decision === "allowed"
    ? `Allow this ${risk}call (score ${request.riskScore}/100): ${request.sourceAgent} → ${request.targetTool ?? request.targetAgent ?? "?"}?`
    : "Deny this call?";
}
