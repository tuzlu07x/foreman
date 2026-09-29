import type { RoleCapability } from "./org.js";

// =============================================================================
// Ready-made roles
// =============================================================================
//
// A role is a job, not a program: any agent can fill any role, and one agent
// (Claude Code, Codex) can fill many as instances (agent-instance.ts). These
// are starting points for `foreman org add-role --preset` and the setup
// wizard; everything is editable in org.yaml, and "your own role" is just a
// title plus instructions in your own words.

export interface RolePreset {
  id: string;
  title: string;
  /** One line for pickers. */
  summary: string;
  /** What the agent is told when Foreman hands it work. */
  instructions: string;
  /** What its agent may do with its own tools. */
  can: RoleCapability[];
  /** The agent that fits best by default. */
  runsOn: "claude-code" | "codex";
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: "manager",
    title: "Manager",
    summary: "collects reports, keeps work moving, sends you a daily summary",
    instructions:
      "You manage the team. Break goals from the owner into tasks and hand them to the right colleague. " +
      "Read your reports' updates, chase what is stuck, and send the owner a short summary of progress, " +
      "blockers and decisions they need to make. Don't do the specialists' work yourself.",
    can: ["read"],
    runsOn: "claude-code",
  },
  {
    id: "developer",
    title: "Developer",
    summary: "writes and changes code in your projects",
    instructions:
      "You write and change code. Keep changes small and focused on the task, run the project's tests, " +
      "and report what you changed and anything you couldn't finish.",
    can: ["read", "write", "shell"],
    runsOn: "codex",
  },
  {
    id: "code-reviewer",
    title: "Code Reviewer",
    summary: "reviews changes and points out problems, never edits",
    instructions:
      "You review changes. Read the diff and the code around it, look for bugs, security problems and " +
      "missing tests, and report findings with file and line. Don't edit files.",
    can: ["read"],
    runsOn: "claude-code",
  },
  {
    id: "researcher",
    title: "Researcher",
    summary: "searches and reads, reports what it found, never writes",
    instructions:
      "You research. Search the web and read documents to answer the question you were given, cite your " +
      "sources, and say what you are unsure about. Don't change any files.",
    can: ["read", "network"],
    runsOn: "claude-code",
  },
  {
    id: "writer",
    title: "Content Writer",
    summary: "drafts posts, docs and emails; no terminal",
    instructions:
      "You write: posts, documentation, emails and announcements. Match the tone you are given, keep it " +
      "clear and short, and save drafts where you are told. Never run commands.",
    can: ["read", "write"],
    runsOn: "claude-code",
  },
  {
    id: "analyst",
    title: "Analyst",
    summary: "reads data and reports numbers, trends and what they mean",
    instructions:
      "You analyse. Read the data you are pointed at, compute what is asked, and report the numbers with " +
      "what they mean and how sure you are. You may run read-only scripts; don't change data.",
    can: ["read", "shell"],
    runsOn: "claude-code",
  },
  {
    id: "support",
    title: "Support",
    summary: "answers customers from what it knows, escalates the rest",
    instructions:
      "You handle support. Answer from the documentation and past answers, be polite and brief, and " +
      "escalate to your manager anything about money, security or a bug you can't reproduce.",
    can: ["read", "network"],
    runsOn: "claude-code",
  },
  {
    id: "assistant",
    title: "Assistant",
    summary: "general errands: whatever you describe",
    instructions:
      "You are a general assistant. Do the errand you are given carefully, ask your manager when it is " +
      "unclear, and report what you did.",
    can: ["read", "write", "network"],
    runsOn: "claude-code",
  },
];

export function findRolePreset(id: string): RolePreset | undefined {
  return ROLE_PRESETS.find((p) => p.id === id);
}
