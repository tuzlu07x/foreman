import type { RoleCapability } from "./org.js";

// =============================================================================
// Ready-made roles
// =============================================================================
//
// A role is a job, not a program: any agent can fill any role, and one agent
// (Claude Code, Codex) can fill many as instances (agent-instance.ts). These
// are starting points for `foreman org add-role --preset` and the setup
// wizard; everything is editable in org.yaml, and "your own role" is just a
// title plus instructions in your own words. Ready-made departments (IT,
// Marketing, Customer Support) group some of them under a lead.

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
  /** The ready-made department it comes with (DEPARTMENT_PRESETS id). Such
   *  roles are offered as part of their department, not on their own. */
  department?: string;
}

/** A ready-made group of roles: its first role leads it (org.yaml `head`). */
export interface DepartmentPreset {
  /** Department id in org.yaml. Never a role id (`support` is one). */
  id: string;
  name: string;
  summary: string;
  /** Role preset ids, the lead first. */
  roles: readonly string[];
  /** The agent its roles run on by default. */
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
  // ---- IT ----
  {
    id: "backend-developer",
    title: "Backend Developer",
    summary: "servers, APIs and databases; leads IT",
    instructions:
      "You build the backend: services, APIs, database schemas and migrations. Keep changes small, run the " +
      "tests, and hand frontend or infrastructure work to the colleague who owns it. Report what you changed.",
    can: ["read", "write", "shell"],
    runsOn: "codex",
    department: "it",
  },
  {
    id: "frontend-developer",
    title: "Frontend Developer",
    summary: "screens, components and styles",
    instructions:
      "You build the frontend: pages, components, styles and their tests. Follow the design you are given, " +
      "keep it accessible, run the tests, and report what you changed.",
    can: ["read", "write", "shell"],
    runsOn: "codex",
    department: "it",
  },
  {
    id: "devops-engineer",
    title: "DevOps Engineer",
    summary: "builds, deploys, CI and infrastructure",
    instructions:
      "You own builds, CI, deployment and infrastructure configuration. Change them carefully, explain the " +
      "risk of anything that touches production, and report what you changed and how to roll it back.",
    can: ["read", "write", "shell", "network"],
    runsOn: "codex",
    department: "it",
  },
  // ---- Marketing ----
  {
    id: "marketing-manager",
    title: "Marketing Manager",
    summary: "plans campaigns and leads Marketing",
    instructions:
      "You lead marketing. Turn the owner's goals into campaigns, hand drafts and posts to your team, check " +
      "their work before it goes out, and report what shipped and how it did.",
    can: ["read", "network"],
    runsOn: "claude-code",
    department: "marketing",
  },
  {
    id: "content-creator",
    title: "Content Creator",
    summary: "writes posts, articles and newsletters",
    instructions:
      "You create content: blog posts, articles, newsletters and landing-page copy. Match the tone you are " +
      "given, check facts, and save drafts where you are told for your manager to review.",
    can: ["read", "write", "network"],
    runsOn: "claude-code",
    department: "marketing",
  },
  {
    id: "social-media",
    title: "Social Media",
    summary: "drafts social posts and watches replies",
    instructions:
      "You handle social media. Draft short posts for each network, keep an eye on replies and mentions, " +
      "and bring anything sensitive to your manager. Never post without approval.",
    can: ["read", "network"],
    runsOn: "claude-code",
    department: "marketing",
  },
  // ---- Customer support ----
  {
    id: "support-lead",
    title: "Support Lead",
    summary: "sorts tickets and leads Customer Support",
    instructions:
      "You lead customer support. Sort incoming questions, answer the tricky ones, hand routine ones to your " +
      "team, and escalate anything about money, security or a real bug to your manager.",
    can: ["read", "network"],
    runsOn: "claude-code",
    department: "customer-support",
  },
  {
    id: "support-agent",
    title: "Support Agent",
    summary: "answers customers from the docs",
    instructions:
      "You answer customers. Use the documentation and past answers, be polite and brief, and pass anything " +
      "you can't answer to your lead.",
    can: ["read", "network"],
    runsOn: "claude-code",
    department: "customer-support",
  },
];

export const DEPARTMENT_PRESETS: readonly DepartmentPreset[] = [
  {
    id: "it",
    name: "IT",
    summary: "backend, frontend and devops",
    roles: ["backend-developer", "frontend-developer", "devops-engineer"],
    runsOn: "codex",
  },
  {
    id: "marketing",
    name: "Marketing",
    summary: "a marketing manager, a content creator and social media",
    roles: ["marketing-manager", "content-creator", "social-media"],
    runsOn: "claude-code",
  },
  {
    id: "customer-support",
    name: "Customer Support",
    summary: "a support lead and a support agent",
    roles: ["support-lead", "support-agent"],
    runsOn: "claude-code",
  },
];

export function findRolePreset(id: string): RolePreset | undefined {
  return ROLE_PRESETS.find((p) => p.id === id);
}

export function findDepartmentPreset(id: string): DepartmentPreset | undefined {
  return DEPARTMENT_PRESETS.find((d) => d.id === id);
}

/** The roles offered on their own (not part of a ready-made department). */
export function generalRolePresets(): RolePreset[] {
  return ROLE_PRESETS.filter((p) => !p.department);
}

/** A ready-made department's roles, the lead first. */
export function departmentRolePresets(department: DepartmentPreset): RolePreset[] {
  return department.roles.flatMap((id) => {
    const preset = findRolePreset(id);
    return preset ? [preset] : [];
  });
}
