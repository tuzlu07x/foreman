import { readForemanPidInfo, type PidProbe } from "./foreman-pidfile.js";
import { buildEnabledChannels } from "./notification/channel-factory.js";
import { channelConfig, routeFor, type ChannelToggle, type NotifyConfig } from "./notification/notify-config.js";
import type { ChannelSecrets } from "./notification/channel-factory.js";
import { resolveTelegramListener } from "./notification/telegram-listener.js";

// =============================================================================
// The gateway: who runs it on this home, and where its approvals go
// =============================================================================
//
// "The gateway" is everything `foreman start` runs besides the TUI: the
// approval bridge over pending_approvals, the notification channels (and
// the Telegram approval bot, Slack Socket Mode and the Discord Gateway
// that bring taps back), the control drain, schedulers and watchers, the
// OTLP receiver and the hub daemon. Exactly one process per home runs it,
// holding the pidfile:
//
//   - `foreman start` ("tui"), or
//   - the background service's `foreman daemon --service` ("headless").
//
// A `foreman start` that finds a headless gateway attaches to it: TUI
// only, everything else stays in the gateway (src/cli/start.ts).

export type GatewayProbe =
  | { state: "none" }
  | { state: "running"; pid: number; mode: "tui" | "headless"; heartbeatAgeMs: number };

/** Is a gateway running on this home, and which kind? A stale pidfile (a
 *  crash, a pid reused after a reboot) is "none" (readForemanPidInfo). */
export function probeGateway(configDir: string, probe?: PidProbe): GatewayProbe {
  const info = readForemanPidInfo(configDir, probe);
  if (!info) return { state: "none" };
  // A pidfile without a mode was written by `foreman start`.
  return { state: "running", pid: info.pid, mode: info.mode ?? "tui", heartbeatAgeMs: info.heartbeatAgeMs };
}

/** Who runs the gateway, in words: `foreman service status` and doctor. */
export function gatewayHolder(gateway: GatewayProbe): string {
  if (gateway.state === "none") return "not running";
  return gateway.mode === "headless"
    ? `the background service (pid ${gateway.pid})`
    : `\`foreman start\` (pid ${gateway.pid})`;
}

export interface ApprovalReach {
  /** Enabled channels that can be built and receive approvals (a level an
   *  approval uses routes to them). */
  notified: string[];
  /** Of those, the ones where you can decide an approval yourself, over a
   *  connection only Foreman holds. */
  decide: string[];
}

/** Where a running gateway sends approvals, from notify.yaml. Builds the
 *  channels to validate them only; nothing is started. */
export function approvalReach(config: NotifyConfig, secrets: ChannelSecrets, telegramSharedWith: string[] = []): ApprovalReach {
  const { channels } = buildEnabledChannels(config, {
    secrets,
    signApproval: () => "",
    signButton: () => "",
    telegramSharedWith,
  });
  const routed = new Set((["critical", "warning", "info"] as const).flatMap((level) => routeFor(config, level).channels));
  const notified = [...channels.keys()].filter((c) => routed.has(c));
  const decide = notified.filter((c) => {
    if (c === "telegram") {
      // The approval bot, or the one bot when no chat agent shares it.
      const toggle: Pick<ChannelToggle, "approval_bot_token_ref" | "listener"> = channelConfig(config, "telegram") ?? {};
      return Boolean(toggle.approval_bot_token_ref) || resolveTelegramListener(toggle, telegramSharedWith) === "foreman";
    }
    if (c === "slack") return Boolean(channelConfig(config, "slack")?.app_token_ref);
    if (c === "discord") return channelConfig(config, "discord")?.interactive === true;
    return false;
  });
  return { notified, decide };
}
