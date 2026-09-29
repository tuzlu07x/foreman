import {
  defaultNotifyConfig,
  loadNotifyConfig,
  saveNotifyConfig,
} from "../../core/notification/notify-config.js";
import type { ServiceEntry } from "../../core/registry-catalog.js";
import {
  buildNotifyConfigFromWizard,
  channelFinishCommand,
  type ChannelTargets,
  type SlackTwoWay,
  type UnwiredChannel,
} from "../setup-wizard-notify-persist.js";
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
// Slack and Discord bots also need the channel they post to: a "channel"
// prompt after the token, whose value goes into notify.yaml, not the vault.
export interface ServicePrompt {
  serviceId: string;
  /** The secret's vault name; for a "channel" prompt, the name it is listed
   *  under in the summary (it is never stored as a secret). */
  secretName: string;
  /** `app-token` and `member` are two-way Slack's optional prompts: the
   *  app-level token (a secret) and the owner's member id (notify.yaml). */
  kind: "primary" | "extra" | "channel" | "app-token" | "member";
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
    const channel = CHANNEL_PROMPTS[svc.id];
    if (channel) out.push({ ...channel, serviceId: svc.id, kind: "channel", optional: true });
    if (svc.id === "slack") {
      out.push(
        { ...SLACK_APP_TOKEN_PROMPT, serviceId: svc.id, kind: "app-token", optional: true },
        { ...SLACK_MEMBER_PROMPT, serviceId: svc.id, kind: "member", optional: true },
      );
    }
  }
  return out;
}

/** Vault name of two-way Slack's app-level token: the name
 *  `foreman notify slack-interactive` reads by default. */
export const SLACK_APP_TOKEN_SECRET = "slack-app-token";

/** Optional: turns on two-way Slack (approval buttons, `/foreman`) over
 *  Socket Mode, the same as `foreman notify slack-interactive`. */
const SLACK_APP_TOKEN_PROMPT: ChannelPromptSpec = {
  secretName: SLACK_APP_TOKEN_SECRET,
  label: "app-level token (optional, for two-way Slack)",
  whereToGet: null,
  formatHint: "starts with xapp-",
  setupSteps: [
    "Optional: lets you press Allow / Deny and run /foreman in Slack. Enter on empty input skips it (Slack then only posts)",
    "In api.slack.com/apps → your app: Socket Mode → on",
    "Basic Information → App-Level Tokens → Generate, with the connections:write scope → copy it (xapp-…)",
    "Interactivity & Shortcuts → on (no URL needed with Socket Mode), and Slash Commands → create /foreman",
    "Reinstall the app if Slack asks",
  ],
};

const SLACK_MEMBER_PROMPT: ChannelPromptSpec = {
  secretName: "slack-member-id",
  label: "your member id (optional, for two-way Slack)",
  whereToGet: null,
  formatHint: "starts with U, e.g. U0123ABCD",
  setupSteps: [
    "Only this Slack user may press Allow / Deny or run /foreman. Enter on empty input skips it",
    "In Slack click your profile picture → Profile → ⋮ (More) → Copy member ID",
  ],
};

export interface ServiceMemberSubmitInput {
  value: string;
  currentIdx: number;
  totalSelected: number;
}

export interface ServiceMemberSubmitResult {
  /** The member id for notify.yaml; null when skipped or refused. */
  memberId: string | null;
  /** The value can't be a member id: stay on the prompt and say why. */
  error: string | null;
  nextPhase: ServicesPhase;
  nextIdx: number;
}

/** Same shape `foreman notify slack-interactive --user` accepts. */
const SLACK_MEMBER_ID = /^[UW][A-Z0-9]{2,39}$/i;

/** Submit at the Slack member id prompt. Empty skips (two-way Slack stays
 *  as it was); a value that isn't a member id is refused. */
export function applyServiceMemberSubmit(
  input: ServiceMemberSubmitInput,
): ServiceMemberSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalSelected;
  const onward = {
    nextPhase: (isLast ? "summary" : "values") as ServicesPhase,
    nextIdx: input.currentIdx + 1,
  };
  const value = input.value.trim();
  if (value.length === 0) return { memberId: null, error: null, ...onward };
  if (!SLACK_MEMBER_ID.test(value)) {
    return {
      memberId: null,
      error:
        "a Slack member id starts with U (e.g. U0123ABCD): your profile picture → Profile → ⋮ (More) → Copy member ID.",
      nextPhase: "values",
      nextIdx: input.currentIdx,
    };
  }
  // Slack sends ids in upper case; a lower-case copy would never match.
  return { memberId: value.toUpperCase(), error: null, ...onward };
}

/** notify.yaml already has two-way Slack (an earlier run, or the
 *  slack-interactive command): an app token and at least one allowed user. */
export function slackTwoWayConfigured(notifyConfigPath: string): boolean {
  try {
    const slack = loadNotifyConfig(notifyConfigPath).channels.slack;
    return Boolean(slack?.app_token_ref) && (slack?.allowed_user_ids?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** What two-way Slack gets from the wizard: both values, or nothing. The
 *  app token counts when it was saved in this run or kept from an earlier
 *  one (`servicesSaved`). */
export function slackTwoWayFromWizard(
  servicesSaved: readonly string[],
  memberId: string | null,
): SlackTwoWay | undefined {
  if (!memberId || !servicesSaved.includes(SLACK_APP_TOKEN_SECRET)) return undefined;
  return { appTokenRef: SLACK_APP_TOKEN_SECRET, memberId };
}

type ChannelPromptSpec = Omit<ServicePrompt, "serviceId" | "kind" | "optional">;

/** The channel a Slack / Discord bot posts to (bot mode needs `channel` in
 *  notify.yaml, the field `foreman notify enable <app> --channel` sets). */
const CHANNEL_PROMPTS: Record<string, ChannelPromptSpec> = {
  slack: {
    secretName: "slack-channel",
    label: "channel",
    whereToGet: null,
    formatHint: "#foreman (or a channel id like C0123456789)",
    setupSteps: [
      "Pick the channel Foreman posts to (#foreman, or any channel you like)",
      "Invite the bot into it: type /invite @yourapp in that channel (Slack only delivers where the bot is a member)",
    ],
  },
  discord: {
    secretName: "discord-channel-id",
    label: "channel id",
    whereToGet: null,
    formatHint: "17–20 digits, e.g. 123456789012345678",
    setupSteps: [
      "In Discord open User Settings → Advanced and turn on Developer Mode",
      "Right-click the channel Foreman should post to → Copy Channel ID",
      "Make sure the bot is in that server and may send messages in the channel",
    ],
  },
};

/** The value a channel prompt starts with (Enter accepts it). */
export function channelPromptDefault(serviceId: string): string {
  return serviceId === "slack" ? "#foreman" : "";
}

export interface ServiceValueSubmitInput {
  serviceId: string;
  value: string;
  currentIdx: number;
  totalSelected: number;
  /** The secret is already in the vault (an earlier run, a resume). */
  alreadyStored?: boolean;
  /** servicePasteWarning for this value: it doesn't have the usual shape. */
  pasteWarning?: string | null;
  /** The value last submitted at this prompt and held back for its paste
   *  warning; submitting that same value again saves it anyway. */
  pendingValue?: string | null;
}

export interface ServiceValueSubmitResult {
  shouldSave: boolean;
  /** Empty input on a stored secret: keep it, count it as configured. */
  keepStored?: boolean;
  /** The value failed its paste check: nothing saved, the prompt stays
   *  and waits for Enter again (same value) or the right value. */
  confirm?: boolean;
  warning: string | null;
  nextPhase: ServicesPhase;
  nextIdx: number;
}

export function applyServiceValueSubmit(
  input: ServiceValueSubmitInput,
): ServiceValueSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalSelected;
  const pasteWarning = input.value.length > 0 ? (input.pasteWarning ?? null) : null;
  // A value with the wrong shape (a Discord public key pasted as the bot
  // token) is held back once; the same value submitted again is saved.
  if (pasteWarning && input.value !== input.pendingValue) {
    return {
      shouldSave: false,
      confirm: true,
      warning: `${pasteWarning} Press Enter again to save it anyway, or paste the right value.`,
      nextPhase: "values",
      nextIdx: input.currentIdx,
    };
  }
  if (input.value.length === 0 && input.alreadyStored) {
    return {
      shouldSave: false,
      keepStored: true,
      warning: null,
      nextPhase: isLast ? "summary" : "values",
      nextIdx: input.currentIdx + 1,
    };
  }
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
    warning: pasteWarning
      ? `${pasteWarning} Saved anyway — fix it with \`foreman secrets rotate ${input.serviceId}\` if it was a paste error.`
      : null,
    nextPhase: isLast ? "summary" : "values",
    nextIdx: input.currentIdx + 1,
  };
}

/** Prompts that mean nothing once an earlier one of the same service was
 *  skipped: the channel needs the bot token, two-way Slack needs the bot
 *  and its channel, the member id needs the app token. */
const DEPENDENT_PROMPT_KINDS: ReadonlySet<ServicePrompt["kind"]> = new Set([
  "channel",
  "app-token",
  "member",
]);

/** Where to go after a token (or the Slack channel) prompt was skipped:
 *  past that service's prompts that depend on it. */
export function nextIdxAfterSkippedToken(
  prompts: readonly ServicePrompt[],
  nextIdx: number,
  serviceId: string,
): number {
  let idx = nextIdx;
  while (
    prompts[idx] !== undefined &&
    DEPENDENT_PROMPT_KINDS.has(prompts[idx]!.kind) &&
    prompts[idx]!.serviceId === serviceId
  ) {
    idx++;
  }
  return idx;
}

export interface ServiceChannelSubmitInput {
  serviceId: string;
  value: string;
  currentIdx: number;
  totalSelected: number;
}

export interface ServiceChannelSubmitResult {
  /** The channel to write into notify.yaml; null when skipped or refused. */
  target: string | null;
  /** The value can't be a channel: stay on the prompt and say why. */
  error: string | null;
  warning: string | null;
  nextPhase: ServicesPhase;
  nextIdx: number;
}

const DISCORD_CHANNEL_ID = /^\d{17,20}$/;
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Submit at a Slack channel / Discord channel id prompt. Empty skips (the
 *  chat app then stays off in notify.yaml); a malformed value is refused. */
export function applyServiceChannelSubmit(
  input: ServiceChannelSubmitInput,
): ServiceChannelSubmitResult {
  const isLast = input.currentIdx + 1 >= input.totalSelected;
  const onward = {
    nextPhase: (isLast ? "summary" : "values") as ServicesPhase,
    nextIdx: input.currentIdx + 1,
  };
  const stay = { nextPhase: "values" as ServicesPhase, nextIdx: input.currentIdx };
  const value = input.value.trim();
  const app = input.serviceId === "slack" ? "Slack" : input.serviceId === "discord" ? "Discord" : input.serviceId;
  if (value.length === 0) {
    return {
      target: null,
      error: null,
      warning: `Skipped the ${app} channel, so ${app} stays off. Finish later with \`${channelFinishCommand(input.serviceId)}\`.`,
      ...onward,
    };
  }
  if (input.serviceId === "discord" && !DISCORD_CHANNEL_ID.test(value)) {
    return {
      target: null,
      error:
        "a Discord channel id is 17–20 digits: turn on Developer Mode, then right-click the channel → Copy Channel ID.",
      warning: null,
      ...stay,
    };
  }
  if (/\s/.test(value)) {
    return {
      target: null,
      error: `a ${app} channel has no spaces (e.g. #foreman, or a channel id like C0123456789).`,
      warning: null,
      ...stay,
    };
  }
  // Slack takes "#name" or a channel id; a bare lowercase name gets its #.
  const target = input.serviceId === "slack" && SLACK_CHANNEL_NAME.test(value) ? `#${value}` : value;
  return { target, error: null, warning: null, ...onward };
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

/** GitHub, Jira/Confluence (atlassian) and Notion are set up in the
 *  Integrations step now (docs/plans/integrations.md §13.2). services.json
 *  keeps them so older setups and agents' `optional_services` still
 *  resolve; only the wizard's Services picker stops offering them. */
export const INTEGRATION_MANAGED_SERVICES: readonly string[] = ["github", "atlassian", "notion"];

/** The services the wizard's Services picker offers. */
export function wizardServiceChoices<T extends { id: string }>(catalog: readonly T[]): T[] {
  return catalog.filter((s) => !INTEGRATION_MANAGED_SERVICES.includes(s.id));
}

/** Services pre-checked in the picker (#657): the session's pick (a resumed
 *  run) and every service whose secret is already stored, so a resumed or
 *  repeated setup shows what is configured instead of "(none)". */
export function servicesPreChecked(
  servicesSelected: readonly string[],
  catalog: readonly ServiceEntry[],
  store: { exists(name: string): boolean },
): string[] {
  return catalog
    .filter((s) => servicesSelected.includes(s.id) || store.exists(s.secret_name))
    .map((s) => s.id);
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
  channelTargets: ChannelTargets = {},
  slackTwoWay?: SlackTwoWay,
): void {
  if (savedStorageNames.length === 0) return;
  try {
    const existing = loadNotifyConfig(services.notifyConfigPath);
    const { next, wiredChannels } = buildNotifyConfigFromWizard({
      savedStorageNames,
      serviceCatalog,
      secretStore: services.secretStore,
      existing,
      channelTargets,
      ...(slackTwoWay ? { slackTwoWay } : {}),
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
        channelTargets,
        ...(slackTwoWay ? { slackTwoWay } : {}),
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

/** The chat apps whose token is in place but that notify.yaml can't turn on
 *  yet (no chat id / channel), each with the command that finishes it. */
export function notifyChannelsToFinish(
  services: WizardServices,
  serviceCatalog: ServiceEntry[],
  savedStorageNames: string[],
  channelTargets: ChannelTargets = {},
): UnwiredChannel[] {
  if (savedStorageNames.length === 0) return [];
  let existing = defaultNotifyConfig();
  try {
    existing = loadNotifyConfig(services.notifyConfigPath);
  } catch {
    // An unparseable notify.yaml: persisting falls back to defaults too.
  }
  return buildNotifyConfigFromWizard({
    savedStorageNames,
    serviceCatalog,
    secretStore: services.secretStore,
    existing,
    channelTargets,
  }).unwiredChannels;
}
