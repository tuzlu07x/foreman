import { existsSync } from "node:fs";
import { Command } from "commander";
import { ChatPrimaryService } from "../core/chat-primary.js";
import { bus } from "../core/event-bus.js";
import { RegistryService } from "../core/registry.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { dim, green, orange, red } from "./colors.js";

// #426 — `foreman chat` controls the primary chat agent per messaging
// channel. Each Telegram / Discord / Slack channel accepts only one bot
// consumer at a time; this is how the user switches which of their
// chat-capable agents owns that channel.

const SUPPORTED_CHANNELS = ["telegram", "discord", "slack"] as const;

export const chatCommand = new Command("chat").description(
  "Primary chat agent per messaging channel (#426)",
);

chatCommand
  .command("status")
  .description("Show the primary chat agent for each messaging channel")
  .action(() => {
    requireInitialised();
    const db = getDb();
    try {
      const svc = new ChatPrimaryService(db);
      const registry = new RegistryService(db, bus);
      const rows = svc.list();
      if (rows.length === 0) {
        console.log(
          dim(
            "(no primary set — every registered agent receives every channel's secrets)",
          ),
        );
        return;
      }
      for (const ch of SUPPORTED_CHANNELS) {
        const row = rows.find((r) => r.channel === ch);
        if (!row) {
          console.log(`  ${dim("○")} ${ch.padEnd(9)} ${dim("(unset)")}`);
          continue;
        }
        const agent = registry.get(row.agentId);
        const label = agent ? `${agent.displayName}` : `${row.agentId}`;
        console.log(
          `  ${green("●")} ${ch.padEnd(9)} ${label} ${dim(`(${row.agentId})`)}`,
        );
      }
    } finally {
      closeDb();
    }
  });

chatCommand
  .command("set-primary <channel> <agent>")
  .description("Set the primary chat agent for a messaging channel")
  .action((channel: string, agent: string) => {
    requireInitialised();
    if (!SUPPORTED_CHANNELS.includes(channel as (typeof SUPPORTED_CHANNELS)[number])) {
      console.error(
        red("error: ") +
          `unknown channel "${channel}". Supported: ${SUPPORTED_CHANNELS.join(", ")}`,
      );
      process.exit(1);
    }
    const db = getDb();
    try {
      const registry = new RegistryService(db, bus);
      const target = registry.get(agent);
      if (!target) {
        console.error(
          red("error: ") +
            `agent "${agent}" is not registered. Run \`foreman agents list\` to see registered ids.`,
        );
        process.exit(1);
      }
      const svc = new ChatPrimaryService(db, { bus });
      svc.set(channel, agent);
      console.log(
        `${green("✓")} ${channel} primary set to ${orange(target.displayName)} ${dim(`(${agent})`)}`,
      );
      console.log(
        dim(
          "  Restart `foreman start` (or run `foreman secrets repush <agent>`) to re-project channel secrets.",
        ),
      );
    } finally {
      closeDb();
    }
  });

chatCommand
  .command("unset-primary <channel>")
  .description(
    "Remove the primary for a channel (every agent will receive its secrets again)",
  )
  .action((channel: string) => {
    requireInitialised();
    if (!SUPPORTED_CHANNELS.includes(channel as (typeof SUPPORTED_CHANNELS)[number])) {
      console.error(
        red("error: ") +
          `unknown channel "${channel}". Supported: ${SUPPORTED_CHANNELS.join(", ")}`,
      );
      process.exit(1);
    }
    const db = getDb();
    try {
      const svc = new ChatPrimaryService(db, { bus });
      const existing = svc.get(channel);
      if (!existing) {
        console.log(dim(`(${channel} primary was already unset — no-op)`));
        return;
      }
      svc.unset(channel);
      console.log(`${green("✓")} ${channel} primary cleared`);
    } finally {
      closeDb();
    }
  });

function requireInitialised(): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) {
    console.error(
      red("error: ") +
        `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`,
    );
    process.exit(1);
  }
}
