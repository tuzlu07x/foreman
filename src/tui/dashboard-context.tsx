import { createContext, useContext, type ReactNode } from "react";
import type { ForemanDb } from "../db/client.js";
import type { EventBus, ForemanEventMap } from "../core/event-bus.js";
import type { RegistryService } from "../core/registry.js";

export interface DashboardServices {
  db: ForemanDb;
  bus: EventBus<ForemanEventMap>;
  registry: RegistryService;
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
