import type Database from "better-sqlite3";
import { createContext, useContext, type ReactNode } from "react";
import type { ForemanDb } from "../db/client.js";
import type { EventBus, ForemanEventMap } from "../core/event-bus.js";
import type { MediatorService } from "../core/mediator.js";
import type { PolicyEngine } from "../core/policy-engine.js";
import type { RegistryService } from "../core/registry.js";
import type { SecretStore } from "../core/secret-store.js";
import type { SessionManager } from "../core/session.js";
import type { OauthFlowResult } from "../cli/run-oauth-flow.js";
import type { WizardOauthRunStep } from "./setup-wizard.js";

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
