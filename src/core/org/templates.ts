// Starter org charts for `foreman org init --template <id>`. Each one is a
// plain org.yaml the user owns afterwards — edit titles, swap agents, add
// departments. Agent ids refer to the bundled agent registry
// (`foreman registry list`); any registered agent id works.

export interface OrgTemplate {
  id: string;
  summary: string;
  render(company: string): string;
}

const startup: OrgTemplate = {
  id: "startup",
  summary: "CEO + Engineering, Marketing, Finance and Support departments",
  render: (company) => `# Foreman Org — who does what, who reports to whom.
# Work flows along reporting lines; approvals always come to you (human).
# Docs: docs/org.md
version: 1
company: ${yamlString(company)}
mission: "Ship a great product with a small human team and a crew of agents."
human:
  title: Founder

delegation:
  # via_heads: departments talk to each other through their heads.
  cross_department: via_heads
  # Managers may assign to anyone below them, not only direct reports.
  skip_levels: true

departments:
  engineering:
    name: Engineering
    head: cto
    mcp_servers: [github, filesystem, playwright, sentry]
  marketing:
    name: Marketing
    head: cmo
    mcp_servers: [notion, brave-search, youtube]
  finance:
    name: Finance
    head: cfo
    mcp_servers: [stripe]
  support:
    name: Customer Support
    head: support-lead
    mcp_servers: [notion]

roles:
  ceo:
    title: Chief Executive (agent)
    agent: hermes
    reports_to: human
    responsibility: "strategy, planning, breaking goals into department work, status reports"
  cto:
    title: CTO
    agent: claude-code
    department: engineering
    reports_to: ceo
    responsibility: "technical direction, architecture, code review"
  engineer:
    title: Software Engineer
    agent: codex
    department: engineering
    reports_to: cto
    responsibility: "code writing, implementation, tests"
  cmo:
    title: CMO
    agent: openclaw
    department: marketing
    reports_to: ceo
    responsibility: "positioning, content calendar, social media, launch posts"
  cfo:
    title: CFO
    agent: zeroclaw
    department: finance
    reports_to: ceo
    responsibility: "revenue reports, invoices, spend tracking — never moves money without approval"
  support-lead:
    title: Support Lead
    agent: generic-mcp
    department: support
    reports_to: ceo
    responsibility: "customer questions, bug triage, FAQ upkeep"
`,
};

const softwareTeam: OrgTemplate = {
  id: "software-team",
  summary: "Tech lead + developer + reviewer, one engineering department",
  render: (company) => `# Foreman Org — a small software team of agents. Docs: docs/org.md
version: 1
company: ${yamlString(company)}
human:
  title: Engineering Manager

delegation:
  cross_department: via_heads
  skip_levels: false

departments:
  engineering:
    name: Engineering
    head: tech-lead
    mcp_servers: [github, filesystem, playwright]

roles:
  tech-lead:
    title: Tech Lead
    agent: claude-code
    department: engineering
    reports_to: human
    responsibility: "planning, task breakdown, architecture decisions"
  developer:
    title: Developer
    agent: codex
    department: engineering
    reports_to: tech-lead
    responsibility: "code writing, implementation"
  reviewer:
    title: Reviewer
    agent: openclaw
    department: engineering
    reports_to: tech-lead
    responsibility: "code review, testing"
`,
};

const solo: OrgTemplate = {
  id: "solo",
  summary: "One personal assistant that delegates coding to one coder",
  render: (company) => `# Foreman Org — you, an assistant and a coder. Docs: docs/org.md
version: 1
company: ${yamlString(company)}
human:
  title: Owner

delegation:
  cross_department: allow
  skip_levels: true

departments: {}

roles:
  assistant:
    title: Personal Assistant
    agent: hermes
    reports_to: human
    responsibility: "inbox, planning, research, delegating coding tasks"
  coder:
    title: Coder
    agent: codex
    reports_to: assistant
    responsibility: "code writing, implementation"
`,
};

export const ORG_TEMPLATES: readonly OrgTemplate[] = [startup, softwareTeam, solo];

export function findOrgTemplate(id: string): OrgTemplate | null {
  return ORG_TEMPLATES.find((t) => t.id === id) ?? null;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
