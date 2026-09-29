import { homedir } from "node:os";
import { loadNotifyConfig } from "../core/notification/notify-config.js";
import { loadOrg, type OrgDoc } from "../core/org/org.js";
import { installedServiceFile, serviceManagerFor } from "../core/service.js";

// =============================================================================
// Home: what to do next, and the team at a glance
// =============================================================================
//
// A fresh Foreman's Home is mostly empty panels. This works out the few
// setup steps still open (each with the command or key that does it) and a
// one-line summary of org.yaml, so Home says where you are.

export interface NextStep {
  text: string;
  how: string;
}

export interface HomeFacts {
  agents: number;
  /** A chat app (Telegram, Slack, Discord) is turned on in notify.yaml. */
  chatApp: boolean;
  /** The background service is installed, or this TUI is attached to it. */
  service: boolean | null;
  org: OrgDoc | null;
  orgBroken: boolean;
}

/** The setup steps still open, most useful first. */
export function nextSteps(facts: HomeFacts): NextStep[] {
  const steps: NextStep[] = [];
  if (facts.agents === 0) steps.push({ text: "Guard an agent", how: "foreman agent add claude-code" });
  if (!facts.chatApp) steps.push({ text: "Approve from your phone", how: "foreman notify enable telegram" });
  if (facts.service === false) {
    steps.push({ text: "Guard with the terminal closed", how: "foreman service install" });
  }
  if (!facts.org && !facts.orgBroken) steps.push({ text: "Give your agents jobs", how: "t, then n" });
  return steps;
}

/** `Acme · 5 roles in 2 departments`, or null without a team. */
export function teamSummary(org: OrgDoc | null): string | null {
  if (!org) return null;
  const roles = Object.keys(org.roles).length;
  const depts = Object.keys(org.departments).length;
  return (
    `${org.company} · ${roles} role${roles === 1 ? "" : "s"}` +
    (depts > 0 ? ` in ${depts} department${depts === 1 ? "" : "s"}` : "")
  );
}

/** Read the facts from disk. Never throws: an unreadable file counts as
 *  "not set up" (or, for org.yaml, broken). */
export function readHomeFacts(input: {
  agents: number;
  notifyConfigPath: string;
  orgConfigPath: string;
  attached: boolean;
}): HomeFacts {
  let chatApp = false;
  try {
    const channels = loadNotifyConfig(input.notifyConfigPath).channels;
    chatApp = [channels.telegram, channels.slack, channels.discord].some((c) => c?.enabled === true);
  } catch {
    chatApp = false;
  }
  let service: boolean | null = input.attached ? true : null;
  if (!input.attached) {
    const manager = serviceManagerFor();
    service = manager ? installedServiceFile(manager, homedir()) !== null : null;
  }
  let org: OrgDoc | null = null;
  let orgBroken = false;
  try {
    org = loadOrg(input.orgConfigPath);
  } catch {
    orgBroken = true;
  }
  return { agents: input.agents, chatApp, service, org, orgBroken };
}
