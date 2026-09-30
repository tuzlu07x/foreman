import { describe, expect, it } from "vitest";
import { findRole, openPlan } from "../../src/cli/open-cli.js";
import { parseOrgText } from "../../src/core/org/org.js";
import type { AgentEntry } from "../../src/core/registry-catalog.js";
import type { RegisteredAgent } from "../../src/core/registry.js";

// `foreman open <role>`: a role's agent in your terminal, as that role.

const ORG = parseOrgText(`version: 1
company: Acme
departments:
  it:
    name: IT
    head: backend-developer
roles:
  manager:
    title: Engineering Manager
    agent: claude-code
    reports_to: human
  backend-developer:
    title: Backend Developer
    agent: backend-developer
    department: it
    reports_to: manager
  analyst:
    title: Analyst
    agent: hermes
    reports_to: manager
`);

const CATALOG = {
  agents: [
    { id: "claude-code", name: "Claude Code", task_model_flag: "--model" },
    { id: "codex", name: "Codex", task_model_flag: "-m" },
    { id: "hermes", name: "Hermes" },
  ] as unknown as AgentEntry[],
};

const agent = (id: string, type: string, modelVersion: string | null = null) =>
  ({ id, displayName: id, metadata: { registryId: type }, modelVersion }) as unknown as RegisteredAgent;

const launchFor = (agentId: string) => ({
  args: ["-c", `mcp_servers.foreman.args=["mcp-stdio","--source","${agentId}"]`],
  env: {},
  taskPrefix: `You are ${agentId}.\n\n`,
});

describe("foreman open", () => {
  it("finds a role by id, title, department or agent", () => {
    expect(findRole(ORG, "manager")).toBe("manager");
    expect(findRole(ORG, "backend developer")).toBe("backend-developer");
    expect(findRole(ORG, "it")).toBe("backend-developer");
    expect(findRole(ORG, "claude-code")).toBe("manager");
    expect(findRole(ORG, "nobody")).toBeNull();
  });

  it("opens a Codex role as itself: its own server, its model, its role first, attributed to it", () => {
    const plan = openPlan({ doc: ORG, roleId: "backend-developer", registered: agent("backend-developer", "codex", "gpt-6-luna"), catalog: CATALOG, launchFor });
    expect(plan).toMatchObject({
      command: "codex",
      agentId: "backend-developer",
      args: ["-c", 'mcp_servers.foreman.args=["mcp-stdio","--source","backend-developer"]', "-m", "gpt-6-luna", "You are backend-developer.\n\nWait for my instructions."],
      env: { FOREMAN_SPAWNED_BY: "backend-developer" },
    });
  });

  it("opens a role on plain Claude Code as Claude Code, and says why it can't open others", () => {
    const plan = openPlan({ doc: ORG, roleId: "manager", registered: agent("claude-code", "claude-code"), catalog: CATALOG, launchFor });
    expect(plan).toMatchObject({ command: "claude", args: [], env: { FOREMAN_SPAWNED_BY: "claude-code" } });
    expect(openPlan({ doc: ORG, roleId: "analyst", registered: agent("hermes", "hermes"), catalog: CATALOG, launchFor })).toEqual({
      error: "Analyst runs on Hermes. foreman open works for roles on Claude Code or Codex; open that agent the usual way.",
    });
    expect(openPlan({ doc: ORG, roleId: "backend-developer", registered: null, catalog: CATALOG, launchFor })).toMatchObject({
      error: expect.stringContaining("isn't registered"),
    });
  });
});
