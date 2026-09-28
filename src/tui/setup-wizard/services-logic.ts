import {
  defaultNotifyConfig,
  loadNotifyConfig,
  saveNotifyConfig,
} from "../../core/notification/notify-config.js";
import type { ServiceEntry } from "../../core/registry-catalog.js";
import { buildNotifyConfigFromWizard } from "../setup-wizard-notify-persist.js";
import type { WizardServices } from "./types.js";

export type ServicesPhase = "picker" | "values" | "summary";

export interface ServicesPickerSubmitResult {
  nextPhase: ServicesPhase;
  selected: string[];
}

export function applyServicesPickerSubmit(
  values: string[],
): ServicesPickerSubmitResult {
  if (values.length === 0) {
    return { nextPhase: "summary", selected: [] };
  }
  return { nextPhase: "values", selected: values };
}

// One value-entry prompt during Step 3. Each selected service expands into
// one prompt for its primary secret plus one per `extra_secrets` entry, so
// a service like Telegram (bot token + chat id) emits two prompts (#220).
export interface ServicePrompt {
  serviceId: string;
  secretName: string;
  kind: "primary" | "extra";
  /** Display label shown in the header / summary lists. */
  label: string;
  whereToGet: string | null;
  formatHint: string;
  setupSteps: string[];
  /** Skippable? Primary defaults to required (kept as today); extras default
   *  to optional so a fresh user can configure later from the Secrets page. */
  optional: boolean;
}

export function buildServicePromptList(
  serviceIds: string[],
  catalog: ServiceEntry[],
): ServicePrompt[] {
  const out: ServicePrompt[] = [];
  for (const id of serviceIds) {
    const svc = catalog.find((s) => s.id === id);
    if (!svc) continue;
    out.push({
      serviceId: svc.id,
      secretName: svc.secret_name,
      kind: "primary",
      label: svc.name,
      whereToGet: svc.where_to_get,
      formatHint: svc.format_hint,
      setupSteps: svc.setup_steps,
      // Primary is still skippable today (user can Enter on empty to bypass)
      // so we keep optional=true to match the existing UX message.
      optional: true,
    });
    for (const extra of svc.extra_secrets ?? []) {
      out.push({
        serviceId: svc.id,
        secretName: extra.name,
        kind: "extra",
        label: extra.description ?? `${svc.name} — ${extra.name}`,
        whereToGet: extra.where_to_get ?? null,
        formatHint: extra.format_hint,
        setupSteps: extra.setup_steps,
        optional: extra.optional,
      });
    }
  }
  return out;
}

export interface ServiceValueSubmitInput {
  serviceId: string;
  value: string;
  currentIdx: number;
  totalSelected: number;
}

export interface ServiceValueSubmitResult {
  shouldSave: boolean;
  warning: string | null;
  nextPhase: ServicesPhase;
  nextIdx: number;
}

export function applyServiceValueSubmit(
  input: ServiceValueSubmitInput,
): ServiceValueSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalSelected;
  if (input.value.length === 0) {
    return {
      shouldSave: false,
      warning: `Skipped ${input.serviceId} — empty value. Add it later from the Services page.`,
      nextPhase: isLast ? "summary" : "values",
      nextIdx: input.currentIdx + 1,
    };
  }
  return {
    shouldSave: true,
    warning: null,
    nextPhase: isLast ? "summary" : "values",
    nextIdx: input.currentIdx + 1,
  };
}

// Intersect a service's used_by_agents with the agents the user picked in
// Step 2 — the wizard hasn't installed them yet, so registry.list() would
// be empty here. Returns the matching ids in agent-catalog order.
export function consumingAgentsFor(
  service: ServiceEntry,
  agentsSelected: string[],
): string[] {
  return service.used_by_agents.filter((id) => agentsSelected.includes(id));
}

/** The secrets notify.yaml is wired from: the ones saved in this run, plus
 *  the selected services' secrets already in the vault (#657). Without the
 *  vault, a chat id entered now for a bot token stored in an earlier run
 *  (or a resumed run, which starts with nothing saved) never reached
 *  notify.yaml. */
export function notifyWiringNames(
  servicesSelected: readonly string[],
  servicesSaved: readonly string[],
  catalog: readonly ServiceEntry[],
  store: { exists(name: string): boolean },
): string[] {
  const names = new Set(servicesSaved);
  for (const svc of catalog) {
    if (!servicesSelected.includes(svc.id)) continue;
    for (const name of [svc.secret_name, ...(svc.extra_secrets ?? []).map((e) => e.name)]) {
      if (store.exists(name)) names.add(name);
    }
  }
  return [...names];
}

// Sibling of persistLlmConfigFromWizardState (#289) — writes notify.yaml
// after the services step so the wizard's "✓ wired N services" claim
// actually translates to enabled channels. Same best-effort semantics:
// merge into existing config, fall back to defaults on parse error, log
// but don't crash on write failure.
export function persistNotifyConfigFromWizardState(
  services: WizardServices,
  serviceCatalog: ServiceEntry[],
  savedStorageNames: string[],
): void {
  if (savedStorageNames.length === 0) return;
  try {
    const existing = loadNotifyConfig(services.notifyConfigPath);
    const { next, wiredChannels } = buildNotifyConfigFromWizard({
      savedStorageNames,
      serviceCatalog,
      secretStore: services.secretStore,
      existing,
    });
    if (wiredChannels.length === 0) return;
    saveNotifyConfig(services.notifyConfigPath, next);
  } catch (err) {
    try {
      const { next } = buildNotifyConfigFromWizard({
        savedStorageNames,
        serviceCatalog,
        secretStore: services.secretStore,
        existing: defaultNotifyConfig(),
      });
      saveNotifyConfig(services.notifyConfigPath, next);
    } catch (writeErr) {
      console.error(
        `⚠ failed to persist notify.yaml: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        `(original error: ${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}
