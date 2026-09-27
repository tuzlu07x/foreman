import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { loadActiveRegistry } from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import {
  buildTree,
  checkDelegation,
  loadOrg,
  OrgValidationError,
  parseOrgText,
  resolveAssignee,
  saveOrgText,
  validateOrg,
  type OrgDoc,
  type OrgTreeNode,
} from "../core/org/org.js";
import { findOrgTemplate, ORG_TEMPLATES } from "../core/org/templates.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { runAgentUpdateAll } from "./agents-cli.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { runWrite } from "./write-cli.js";

// =============================================================================
// `foreman org` — run your company as a crew of agents
// =============================================================================
//
//   foreman org init --template startup --company "Acme"
//   foreman org show
//   foreman org assign marketing "draft the launch post for Friday"
//
// org.yaml describes departments, roles and reporting lines. Foreman then
// enforces the chart: delegation follows reporting lines, each department
// only sees the MCP servers it needs, and approvals always come to you.

export const orgCommand = new Command("org").description(
  "Foreman Org — departments, roles and reporting lines for your agents",
);

orgCommand
  .command("templates")
  .description("List starter org charts")
  .action(() => {
    for (const t of ORG_TEMPLATES) console.log(`  ${bold(t.id.padEnd(15))} ${t.summary}`);
    console.log("");
    console.log(dim("Start one: foreman org init --template <id> --company \"Your Co\""));
  });

orgCommand
  .command("init")
  .description("Create org.yaml from a template")
  .option("--template <id>", "startup | software-team | solo", "startup")
  .option("--company <name>", "company name", "My Company")
  .option("--force", "overwrite an existing org.yaml")
  .action((opts: { template: string; company: string; force?: boolean }) => {
    requireInitialised();
    const paths = getForemanPaths();
    const template = findOrgTemplate(opts.template);
    if (!template) {
      fail(`unknown template '${opts.template}' — run \`foreman org templates\``);
    }
    if (existsSync(paths.orgConfigPath) && !opts.force) {
      fail(`${paths.orgConfigPath} already exists — pass --force to replace it`);
    }
    saveOrgText(paths.orgConfigPath, template.render(opts.company));
    console.log(`${green("✓")} wrote ${dim(paths.orgConfigPath)} (${template.id})`);
    printTree(parseOrgText(template.render(opts.company)), registeredAgents());
    console.log("");
    console.log(
      dim(
        "Next: edit agents/titles to taste, `foreman org validate`, then `foreman org sync` " +
          "to push responsibilities to your agents.",
      ),
    );
  });

orgCommand
  .command("show")
  .description("Show the org chart")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const org = requireOrg();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ org, tree: buildTree(org) }, null, 2)}\n`);
      return;
    }
    printTree(org, registeredAgents());
  });

orgCommand
  .command("validate")
  .description("Check org.yaml (structure, cycles, unregistered agents)")
  .action(() => {
    requireInitialised();
    const paths = getForemanPaths();
    if (!existsSync(paths.orgConfigPath)) fail("no org.yaml — run `foreman org init`");
    let org: OrgDoc;
    try {
      org = parseOrgText(readFileSync(paths.orgConfigPath, "utf-8"));
    } catch (err) {
      reportInvalid(err);
    }
    const warnings = validateOrg(org, registeredAgents());
    for (const w of warnings) console.log(`${orange("warn:")} ${w.message}`);
    console.log(
      `${green("✓")} org.yaml valid — ${Object.keys(org.roles).length} roles, ` +
        `${Object.keys(org.departments).length} departments`,
    );
  });

orgCommand
  .command("check <from> <to>")
  .description("Explain whether agent <from> may hand work to agent <to>")
  .action((from: string, to: string) => {
    const org = requireOrg();
    const verdict = checkDelegation(org, from, to);
    if (!verdict) {
      console.log(dim(`${from} or ${to} is not in org.yaml — the org chart has no opinion`));
      return;
    }
    console.log(`${verdict.allowed ? green("allowed") : red("blocked")} — ${verdict.reason}`);
    if (!verdict.allowed) process.exitCode = 1;
  });

orgCommand
  .command("assign <target> <task...>")
  .description("Give a task to a role, a department (its head) or an agent")
  .action(async (target: string, task: string[]) => {
    const org = requireOrg();
    const roleId = resolveAssignee(org, target);
    if (!roleId) {
      fail(`'${target}' is not a role, department or agent in org.yaml — see \`foreman org show\``);
    }
    const role = org.roles[roleId]!;
    console.log(dim(`→ ${roleId} (${role.title}) · ${role.agent}`));
    process.exitCode = await runWrite(role.agent, task.join(" ").trim());
  });

orgCommand
  .command("sync")
  .description("Push each role's title + responsibility (and model) to the registered agents")
  .action(() => {
    const org = requireOrg();
    const db = getDb();
    try {
      const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
      let updated = 0;
      const skipped = new Set<string>();
      for (const [roleId, role] of Object.entries(org.roles)) {
        if (!registry.get(role.agent)) {
          skipped.add(role.agent);
          continue;
        }
        const titles = Object.entries(org.roles)
          .filter(([, r]) => r.agent === role.agent)
          .map(([id, r]) => `${r.title} (${id})${r.responsibility ? `: ${r.responsibility}` : ""}`);
        registry.setResponsibilityNote(role.agent, `${org.company} — ${titles.join("; ")}`);
        if (role.model) registry.setModelVersion(role.agent, role.model);
        updated++;
        console.log(`${green("✓")} ${bold(role.agent)} ← ${roleId}`);
      }
      for (const agent of skipped) {
        console.log(`${orange("skip")} ${agent} is not registered — \`foreman agent add ${agent}\``);
      }
      console.log(dim(`${updated} role(s) synced`));
    } finally {
      closeDb();
    }
  });

orgCommand
  .command("upgrade")
  .description("Upgrade every agent runtime used in the org to its latest supported version")
  .action(async () => {
    const org = requireOrg();
    const db = getDb();
    try {
      const registry = new RegistryService(db, new EventBus<ForemanEventMap>());
      const ids = new Set(Object.values(org.roles).map((r) => r.agent));
      const agents = registry.list().filter((a) => ids.has(a.id));
      await runAgentUpdateAll(agents, loadActiveRegistry().doc);
    } finally {
      closeDb();
    }
  });

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function printTree(org: OrgDoc, registered: ReadonlySet<string>): void {
  console.log(`${orange(bold(org.company))}${org.mission ? dim(` — ${org.mission}`) : ""}`);
  console.log(`${bold("you")}${org.human.title ? dim(` (${org.human.title})`) : ""}`);
  const walk = (nodes: OrgTreeNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      const { role } = node;
      const dot = registered.has(role.agent) ? green("●") : dim("○");
      const dept = role.department ? dim(` [${org.departments[role.department]?.name ?? role.department}]`) : "";
      const servers =
        role.mcp_servers ??
        (role.department ? org.departments[role.department]?.mcp_servers : undefined);
      const mcp = servers ? dim(` mcp: ${servers.join(", ")}`) : "";
      console.log(
        `${prefix}${last ? "└─" : "├─"} ${bold(node.roleId)} · ${role.title} · ${dot} ${role.agent}${dept}${mcp}`,
      );
      walk(node.children, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(buildTree(org), "");
  if ([...Object.values(org.roles)].some((r) => !registered.has(r.agent))) {
    console.log(dim("○ = agent not registered yet (`foreman agent add <id>`)"));
  }
}

function registeredAgents(): Set<string> {
  try {
    const registry = new RegistryService(getDb(), new EventBus<ForemanEventMap>());
    return new Set(registry.listAll().map((a) => a.id));
  } catch {
    return new Set();
  } finally {
    closeDb();
  }
}

function requireOrg(): OrgDoc {
  requireInitialised();
  const paths = getForemanPaths();
  let org: OrgDoc | null = null;
  try {
    org = loadOrg(paths.orgConfigPath);
  } catch (err) {
    reportInvalid(err);
  }
  if (!org) fail("no org.yaml yet — run `foreman org init --template startup`");
  return org;
}

function reportInvalid(err: unknown): never {
  if (err instanceof OrgValidationError) {
    console.error(red("error: ") + "org.yaml is invalid");
    for (const issue of err.issues) console.error(`  - ${issue.message}`);
    process.exit(1);
  }
  fail(err instanceof Error ? err.message : String(err));
}

function requireInitialised(): void {
  const paths = getForemanPaths();
  if (!existsSync(paths.root)) fail(`Foreman is not initialised at ${paths.root}. Run 'foreman init' first.`);
}

function fail(message: string): never {
  console.error(red("error: ") + message);
  process.exit(1);
}
