import type Database from "better-sqlite3";
import { type JSX, createContext, useContext, type ReactNode } from "react";
import type { ForemanDb } from "../db/client.js";
import type { EventBus, ForemanEventMap } from "../core/event-bus.js";
import type { MediatorService } from "../core/mediator.js";
import type { PolicyEngine } from "../core/policy-engine.js";
import type { RegistryService } from "../core/registry.js";
import type { SecretStore } from "../core/secret-store.js";
import type { SessionManager } from "../core/session.js";
import type { OauthFlowResult } from "../cli/run-oauth-flow.js";
import type {
  ForemanCommandContext,
  ForemanCommandRouter,
} from "../core/foreman-command.js";
import type { InboxService } from "../core/inbox.js";
import type { WizardOauthRunStep } from "./setup-wizard.js";
import type { IntegrationWiring } from "../core/integrations/wiring.js";

export interface DashboardServices {
  db: ForemanDb;
  sqlite: Database.Database;
  bus: EventBus<ForemanEventMap>;
  registry: RegistryService;
  mediator?: MediatorService;
  policy?: PolicyEngine;
  policyPath?: string;
  /** Path to Foreman's canonical SOUL.md (identity propagated to agents). */
  soulPath?: string;
  sessionManager?: SessionManager;
  secretStore?: SecretStore;
  runInteractiveLogin?: (steps: WizardOauthRunStep[]) => OauthFlowResult[];
  /** Notification centre store (#613). */
  inbox?: InboxService;
  /** Approvals announced before the TUI mounted (see ApprovalBridge.pending). */
  pendingApprovals?: () => Array<ForemanEventMap["approval:requested"]>;
  /** Manager recommendations already recorded for an approval (#623). */
  approvalRecommendations?: (approvalId: string) => Array<ForemanEventMap["approval:recommended"]>;
  /** Milliseconds letter keys are ignored after the approval on screen
   *  changes (tests set 0). */
  keySettleMs?: number;
  /** Chat verbs for the TUI command bar (#612). The TUI adds the source
   *  and owner fields itself. */
  commandRouter?: ForemanCommandRouter;
  commandContext?: Omit<ForemanCommandContext, "sourceAgent" | "sourceUser" | "trustedOwner">;
  audit?: { logEvent(eventType: string, payload: unknown): void };
  orgConfigPath?: string;
  /** Team page: adds a role's Claude Code / Codex instance (null when added,
   *  else why not). Unset: `runAgentAddScripted`. Tests pass a fake. */
  addTeamAgent?: (agentId: string, runsOn: "claude-code" | "codex") => Promise<string | null>;
  /** Integrations page (`foreman integrations` in the TUI). */
  integrations?: IntegrationWiring;
  /** Set when this TUI is attached to the background gateway (`foreman
   *  service`): that gateway's pid while it runs, null once it stopped. */
  attachedGateway?: () => { pid: number } | null;
}

const DashboardContext = createContext<DashboardServices | null>(null);

export interface DashboardProviderProps extends DashboardServices {
  children: ReactNode;
}

export function DashboardProvider(props: DashboardProviderProps): JSX.Element {
  const { children, ...services } = props;
  return (
    <DashboardContext.Provider value={services}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboardServices(): DashboardServices {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error(
      "useDashboardServices must be used inside <DashboardProvider>",
    );
  }
  return ctx;
}
