import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { jsonForTerminal, terminalSafe } from "../core/terminal-text.js";
import { isMap, parseDocument } from "yaml";
import { EventBus, type ForemanEventMap } from "../core/event-bus.js";
import { agentAddCommand, loadActiveRegistry } from "../core/registry-catalog.js";
import { RegistryService } from "../core/registry.js";
import { isUntrustedSource } from "../core/agent-identity.js";
import { DELEGATION_TOOL } from "../core/foreman-command.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { toPolicyLoadError } from "../core/policy-load.js";
import {
  buildTree,
  checkDelegation,
  escalatesViaManager,
  HUMAN_SOURCES,
  loadOrg,
  OrgValidationError,
  parseOrgText,
  resolveAssignee,
  ROLE_CAPABILITIES,
  rolesForAgent,
  saveOrgText,
  UNTRUSTED_DELEGATION,
  validateOrg,
  type OrgDoc,
  type OrgTreeNode,
  type RoleCapability,
} from "../core/org/org.js";
import { findRolePreset, ROLE_PRESETS } from "../core/org/role-library.js";
import { printPolicyLoadError } from "./policy-error.js";
import { findOrgTemplate, ORG_TEMPLATES } from "../core/org/templates.js";
import { buildOrgReport, parsePeriod, renderOrgReport, resolveReportTarget } from "../core/usage/report.js";
import { BOSS, channelLabel, OrgComms, renderMessages } from "../core/org/comms.js";
import { closeDb, getDb } from "../db/client.js";
import { getForemanPaths } from "../utils/config.js";
import { supportsInstances } from "../core/agent-instance.js";
import { runAgentAddScripted } from "./agent-add.js";
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
  .description("Explain whether <from> may hand work to <to> (agent or role ids)")
  .action((from: string, to: string) => {
    const org = requireOrg();
    // The human (and an unverified connection) is decided before any
    // lookup, exactly as a real hand-off is.
    const fromIsHuman = HUMAN_SOURCES.has(from.trim().toLowerCase());
    if (fromIsHuman) {
      console.log(`${green("allowed")} — assigned by the human ${dim("(policy.yaml rules bind agents only)")}`);
      return;
    }
    if (isUntrustedSource(from)) {
      console.log(`${red("blocked")} — ${UNTRUSTED_DELEGATION.reason}`);
      process.exitCode = 1;
      return;
    }
    const fromSide = resolveCheckSide(org, from);
    const toSide = resolveCheckSide(org, to);
    if (!fromSide || !toSide) {
      const missing = [fromSide ? null : `<from> '${from}'`, toSide ? null : `<to> '${to}'`].filter(
        (s): s is string => s !== null,
      );
      console.error(
        red("error: ") +
          terminalSafe(missing.join(" and ")) +
          ` ${missing.length === 1 ? "is not an agent or role" : "are not agents or roles"} in org.yaml — ` +
          "see `foreman org show`",
      );
      process.exitCode = 1;
      return;
    }
    for (const side of [fromSide, toSide]) {
      if (side.viaRole) console.log(dim(`${side.viaRole} is filled by ${side.agent}`));
    }

    // policy.yaml decides first: a hand-off is the call `<from> → <to>:write`.
    const policy = policyHandoffVerdict(fromSide.agent, toSide.agent);
    if (policy?.effect === "deny") {
      console.log(`${red("blocked")} — policy.yaml decides (${policy.why})`);
      process.exitCode = 1;
      return;
    }
    const verdict = checkDelegation(org, fromSide.agent, toSide.agent);
    if (!verdict) {
      // Both sides are in the chart, so only a lookup mismatch lands here.
      console.log(dim("the org chart has no opinion on this pair"));
      return;
    }
    if (!verdict.allowed) {
      console.log(`${red("blocked")} — ${verdict.reason}`);
      if (policy?.effect === "allow") {
        console.log(dim(`  policy.yaml allows it (${policy.why}), but a policy allow doesn't lift a block from the org chart`));
      }
      if (verdict.next) console.log(`  ${bold("next:")} ${verdict.next}`);
      process.exitCode = 1;
      return;
    }
    if (policy?.effect === "ask") {
      console.log(`${orange("ask")} — org.yaml allows it (${verdict.reason}), and policy.yaml sends it to you for approval (${policy.why})`);
      return;
    }
    console.log(
      `${green("allowed")} — ${verdict.reason}` +
        (policy?.effect === "allow"
          ? dim(` · policy.yaml allows it too (${policy.why})`)
          : dim(" · no policy.yaml rule for this pair, so org.yaml decides")),
    );
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
        console.log(`${orange("skip")} ${agent} is not registered — \`${agentAddCommand(agent)}\``);
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

orgCommand
  .command("report [target] [period]")
  .description("What a department, role or agent did and what it cost (today · week · month · 7d)")
  .option("--json", "output JSON")
  .action((target: string | undefined, period: string | undefined, opts: { json?: boolean }) => {
    requireInitialised();
    const paths = getForemanPaths();
    let org: OrgDoc | null = null;
    try {
      org = loadOrg(paths.orgConfigPath);
    } catch (err) {
      reportInvalid(err);
    }
    // `foreman org report month` means the whole company this month.
    if (target && !period && parsePeriod(target)) {
      period = target;
      target = undefined;
    }
    const p = parsePeriod(period);
    if (!p) fail(`unknown period '${period}' — use today, yesterday, week, month or e.g. 7d`);
    const db = getDb();
    try {
      const agents = new RegistryService(db, new EventBus<ForemanEventMap>()).listAll().map((a) => a.id.toLowerCase());
      const resolved = resolveReportTarget(org, target, agents);
      if (!resolved) fail(`'${target}' is not a department, role or agent — see \`foreman org show\``);
      const report = buildOrgReport(db, org, resolved, p);
      if (opts.json) {
        process.stdout.write(`${jsonForTerminal(report, 2)}\n`);
        return;
      }
      // Task excerpts and agent ids come from agents (#656).
      const [title, ...rest] = terminalSafe(renderOrgReport(report), { multiline: true }).split("\n");
      console.log(orange(bold(title ?? "")));
      for (const line of rest) console.log(line);
    } finally {
      closeDb();
    }
  });

orgCommand
  .command("budget <department> [usd]")
  .description("Set a department's spend limit (monthly unless --daily); `off` removes it")
  .option("--daily", "a daily limit instead of monthly")
  .option("--pause", "when spent, agents can't hand the department new work (you still can)")
  .option("--warn", "when spent, only alert (default)")
  .action((department: string, usd: string | undefined, opts: { daily?: boolean; pause?: boolean; warn?: boolean }) => {
    const org = requireOrg();
    const id = department.toLowerCase();
    if (!Object.hasOwn(org.departments, id)) {
      fail(`no department '${department}' — departments: ${Object.keys(org.departments).join(", ") || "(none)"}`);
    }
    const paths = getForemanPaths();
    const doc = parseDocument(readFileSync(paths.orgConfigPath, "utf-8"));
    const base = ["departments", id, "budget"];
    if (usd === undefined) {
      const b = org.departments[id]!.budget;
      console.log(
        b
          ? `${id}: ${b.monthly_usd ? `$${b.monthly_usd}/month ` : ""}${b.daily_usd ? `$${b.daily_usd}/day ` : ""}(${b.on_exceed})`
          : `${id} has no budget — set one: foreman org budget ${id} 50`,
      );
      return;
    }
    if (usd === "off") {
      doc.deleteIn(base);
    } else {
      const amount = Number(usd.replace(/^\$/, ""));
      if (!Number.isFinite(amount) || amount <= 0) fail(`'${usd}' is not an amount in USD`);
      doc.setIn([...base, opts.daily ? "daily_usd" : "monthly_usd"], amount);
      if (opts.pause || opts.warn) doc.setIn([...base, "on_exceed"], opts.pause ? "pause" : "warn");
    }
    try {
      saveOrgText(paths.orgConfigPath, doc.toString());
    } catch (err) {
      reportInvalid(err);
    }
    console.log(
      usd === "off"
        ? `${green("✓")} ${id} has no budget now`
        : `${green("✓")} ${id}: $${Number(usd.replace(/^\$/, ""))} per ${opts.daily ? "day" : "month"}` +
            dim(opts.pause ? " · agents pause when it's spent" : " · alerts at 80% and 100%"),
    );
  });

orgCommand
  .command("escalate [state]")
  .description("Send low/medium-risk approvals to the requester's manager agent for a recommendation (`on` / `off`)")
  .action((state: string | undefined) => {
    const org = requireOrg();
    if (state === undefined) {
      console.log(
        escalatesViaManager(org)
          ? "on: low- and medium-risk approvals also go to the requester's manager agent, who may recommend. You decide."
          : "off: approvals come only to you. Turn on: foreman org escalate on",
      );
      return;
    }
    const value = state.toLowerCase();
    if (value !== "on" && value !== "off") fail(`'${state}' is not on or off`);
    const paths = getForemanPaths();
    const doc = parseDocument(readFileSync(paths.orgConfigPath, "utf-8"));
    if (value === "on") doc.setIn(["approvals", "escalate_via_manager"], true);
    else doc.deleteIn(["approvals", "escalate_via_manager"]);
    const approvals = doc.getIn(["approvals"]);
    if (isMap(approvals) && approvals.items.length === 0) doc.deleteIn(["approvals"]);
    try {
      saveOrgText(paths.orgConfigPath, doc.toString());
    } catch (err) {
      reportInvalid(err);
    }
    console.log(
      value === "on"
        ? `${green("✓")} low- and medium-risk approvals now also go to the requester's manager agent` +
            dim(" · managers recommend with org_recommend; you still decide every approval")
        : `${green("✓")} approvals come only to you`,
    );
  });

orgCommand
  .command("add-department <id>")
  .description("Add a department with its head role (e.g. marketing led by a cmo)")
  .requiredOption("--head <role>", "role id of the department head (created if missing), e.g. cmo")
  .option("--name <name>", "display name, e.g. Marketing")
  .option("--title <title>", "the head's title, e.g. Chief Marketing Officer")
  .option("--agent <agent>", "agent that fills the head role (needed when the role is new)")
  .option("--reports-to <role>", "who the head reports to", "human")
  .option("--description <text>", "what the department does")
  .action(
    (
      rawId: string,
      opts: { head: string; name?: string; title?: string; agent?: string; reportsTo: string; description?: string },
    ) => {
      const org = requireOrg();
      const id = rawId.toLowerCase();
      const head = opts.head.toLowerCase();
      if (Object.hasOwn(org.departments, id)) fail(`department '${id}' already exists`);
      const paths = getForemanPaths();
      const doc = parseDocument(readFileSync(paths.orgConfigPath, "utf-8"));
      if (!Object.hasOwn(org.roles, head)) {
        if (!opts.agent) fail(`role '${head}' is new — say which agent fills it: --agent claude-code`);
        doc.setIn(["roles", head], {
          title: opts.title ?? `Head of ${opts.name ?? titleCase(id)}`,
          agent: opts.agent,
          department: id,
          reports_to: opts.reportsTo,
        });
      } else {
        doc.setIn(["roles", head, "department"], id);
      }
      doc.setIn(["departments", id], {
        name: opts.name ?? titleCase(id),
        head,
        ...(opts.description ? { description: opts.description } : {}),
      });
      try {
        saveOrgText(paths.orgConfigPath, doc.toString());
      } catch (err) {
        reportInvalid(err);
      }
      console.log(`${green("✓")} added ${bold(id)}, led by ${bold(head)}`);
      console.log(dim(`Add people: foreman org add-role <id> --department ${id} --reports-to ${head} --agent <agent>`));
    },
  );

orgCommand
  .command("roles")
  .description("Ready-made roles for `org add-role --preset` (any agent can fill any role)")
  .action(() => {
    for (const p of ROLE_PRESETS) {
      console.log(`${bold(p.id.padEnd(14))} ${p.title} — ${p.summary}`);
      console.log(dim(`${" ".repeat(15)}may: ${p.can.join(", ")} · runs on ${p.runsOn} by default`));
    }
    console.log(dim("\nYour own role: foreman org add-role <id> --runs-on claude-code --describe \"what it does, in your words\""));
  });

orgCommand
  .command("add-role <id>")
  .description("Add a role to the chart: a ready-made one (--preset) or your own (--describe), filled by an agent")
  .option("--agent <agent>", "agent that fills the role (an agent you registered)")
  .option(
    "--runs-on <type>",
    "fill the role with a new instance of claude-code or codex, named after the role",
  )
  .option("--preset <id>", "start from a ready-made role (see `foreman org roles`)")
  .option("--describe <text>", "what the role does, in your own words (the agent is told this)")
  .option("--can <list>", "what its agent may do: read,write,shell,network (comma-separated)")
  .option("--title <title>", "job title")
  .option("--department <id>", "department it belongs to")
  .option("--reports-to <role>", "manager role (default: the department head, else human)")
  .option("--responsibility <text>", "what this role is for, in one line")
  .option("--model <model>", "model override for this role (a cheaper model for routine work)")
  .action(
    async (
      rawId: string,
      opts: {
        agent?: string;
        runsOn?: string;
        preset?: string;
        describe?: string;
        can?: string;
        title?: string;
        department?: string;
        reportsTo?: string;
        responsibility?: string;
        model?: string;
      },
    ) => {
      const org = requireOrg();
      const id = rawId.toLowerCase();
      if (Object.hasOwn(org.roles, id)) fail(`role '${id}' already exists`);
      const preset = opts.preset ? findRolePreset(opts.preset.toLowerCase()) : undefined;
      if (opts.preset && !preset) fail(`no ready-made role '${opts.preset}' — see \`foreman org roles\``);
      if (opts.agent && opts.runsOn) fail("pass --agent (an agent you registered) or --runs-on (a new one), not both");
      const can = opts.can !== undefined ? parseCan(opts.can) : preset?.can;
      const dept = opts.department?.toLowerCase();
      if (dept && !Object.hasOwn(org.departments, dept)) {
        fail(`no department '${dept}' — add it first: foreman org add-department ${dept} --head <role>`);
      }
      const reportsTo = opts.reportsTo?.toLowerCase() ?? (dept ? org.departments[dept]!.head : "human");
      // Who fills it: a registered agent, or a new instance named after the role.
      const runsOn = opts.agent ? null : (opts.runsOn ?? preset?.runsOn ?? null);
      if (!opts.agent && !runsOn) fail("say who fills the role: --agent <registered agent> or --runs-on <claude-code|codex|…>");
      const agent = opts.agent ?? id;
      // Only Claude Code and Codex run as several agents; anything else
      // would be rewired to the role's name, taking its own identity.
      if (runsOn && agent !== runsOn && !supportsInstances({ id: runsOn })) {
        fail(`only claude-code and codex can fill several roles; for ${runsOn}, pass --agent ${runsOn}`);
      }
      if (runsOn && !registeredAgents().has(agent)) {
        const db = getDb();
        const code = await runAgentAddScripted(agent, { type: runsOn }, { db, registry: new RegistryService(db, new EventBus<ForemanEventMap>()) });
        if (code !== 0) fail(`couldn't add ${agent} (${runsOn}) for the role`);
      }
      const paths = getForemanPaths();
      const doc = parseDocument(readFileSync(paths.orgConfigPath, "utf-8"));
      const instructions = opts.describe ?? preset?.instructions;
      doc.setIn(["roles", id], {
        title: opts.title ?? preset?.title ?? titleCase(id),
        agent,
        ...(dept ? { department: dept } : {}),
        reports_to: reportsTo,
        ...(opts.responsibility ? { responsibility: opts.responsibility } : {}),
        ...(instructions ? { instructions } : {}),
        ...(can ? { can } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });
      try {
        saveOrgText(paths.orgConfigPath, doc.toString());
      } catch (err) {
        reportInvalid(err);
      }
      console.log(`${green("✓")} added ${bold(id)} (${agent})${dept ? ` in ${dept}` : ""}, reporting to ${reportsTo}`);
      if (can) console.log(dim(`  may: ${can.length > 0 ? can.join(", ") : "nothing but talking to colleagues"}`));
      if (!registeredAgents().has(agent)) console.log(dim(`Register the agent: ${agentAddCommand(agent)}`));
    },
  );

/** `read,write` → the capabilities, or a usage error. */
function parseCan(list: string): RoleCapability[] {
  const words = list
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const bad = words.filter((w) => !(ROLE_CAPABILITIES as readonly string[]).includes(w));
  if (bad.length > 0) fail(`--can takes ${ROLE_CAPABILITIES.join(", ")} (not ${bad.join(", ")})`);
  return [...new Set(words)] as RoleCapability[];
}

orgCommand
  .command("messages [channel]")
  .description("Read your agents' conversations (all channels, or one: marketing, leadership, all, a role)")
  .option("--limit <n>", "how many", (v) => Number.parseInt(v, 10), 30)
  .option("--follow", "keep printing new messages")
  .action(async (channel: string | undefined, opts: { limit: number; follow?: boolean }) => {
    requireInitialised();
    const paths = getForemanPaths();
    const comms = new OrgComms(getDb(), { orgConfigPath: paths.orgConfigPath });
    try {
      const problem = channel ? comms.readError({ viewer: BOSS, asOwner: true, channel }) : null;
      if (problem) fail(problem);
      const read = (since?: number) =>
        comms.read({ viewer: BOSS, asOwner: true, ...(channel ? { channel } : {}), limit: opts.limit, ...(since ? { since } : {}) });
      let messages = read();
      console.log(renderMessages(messages));
      if (!opts.follow) return;
      let last = messages.at(-1)?.ts ?? Date.now();
      console.log(dim("— following; Ctrl+C to stop —"));
      for (;;) {
        await new Promise((r) => setTimeout(r, 1_000));
        messages = read(last);
        if (messages.length > 0) {
          console.log(renderMessages(messages));
          last = messages.at(-1)!.ts;
        }
      }
    } finally {
      closeDb();
    }
  });

orgCommand
  .command("tell <target> <message...>")
  .description("Post to a department, role, leadership or all-hands as yourself")
  .action((target: string, message: string[]) => {
    requireInitialised();
    const paths = getForemanPaths();
    try {
      const comms = new OrgComms(getDb(), { orgConfigPath: paths.orgConfigPath });
      const result = comms.post({
        from: BOSS,
        asOwner: true,
        to: target,
        text: message.join(" "),
        kind: target.toLowerCase() === "all" ? "announcement" : "message",
      });
      if (!result.ok) fail(result.reason);
      console.log(`${green("✓")} posted to ${bold(result.label)}`);
      console.log(dim("Agents read it with org_read; `foreman start` mirrors it to Slack / Discord if mapped."));
    } finally {
      closeDb();
    }
  });

orgCommand
  .command("channel <target> [platform] [channel]")
  .description("Mirror a channel to Slack / Discord: `foreman org channel marketing slack #marketing` (`off` removes)")
  .action((target: string, platform: string | undefined, channel: string | undefined) => {
    const org = requireOrg();
    const id = target.toLowerCase().replace(/^#/, "");
    const company = ["all", "leadership", "boss", "direct"].includes(id);
    if (!company && !Object.hasOwn(org.departments, id)) {
      fail(`'${target}' is not a department or one of: all, leadership, boss, direct`);
    }
    const base = company ? ["channels", id] : ["departments", id, "channels"];
    const current = company ? org.channels?.[id as "all"] : org.departments[id]?.channels;
    if (!platform) {
      const entries = Object.entries(current ?? {});
      console.log(entries.length ? entries.map(([p, c]) => `${id} → ${p} ${c}`).join("\n") : `${id} is not mirrored`);
      return;
    }
    const key = platform.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(key)) fail(`'${platform}' is not a platform name (slack, discord, …)`);
    if (!channel) fail("say which channel: a Slack channel (#marketing or C0123…) or a Discord channel id");
    const paths = getForemanPaths();
    const doc = parseDocument(readFileSync(paths.orgConfigPath, "utf-8"));
    if (channel === "off") doc.deleteIn([...base, key]);
    else doc.setIn([...base, key], channel);
    try {
      saveOrgText(paths.orgConfigPath, doc.toString());
    } catch (err) {
      reportInvalid(err);
    }
    const label = company ? channelLabel(id === "direct" ? "dm:a|b" : id) : `#${id}`;
    console.log(
      channel === "off"
        ? `${green("✓")} ${label} is no longer mirrored to ${key}`
        : `${green("✓")} ${id === "direct" ? "role-to-role threads" : label} → ${key} ${channel}`,
    );
    if (channel !== "off") {
      console.log(dim(`Needs a ${key} bot token in notify.yaml (bot_token_ref), invited to that channel. Restart foreman start.`));
    }
  });

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function titleCase(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

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
    const missing = [...new Set(Object.values(org.roles).map((r) => r.agent))].filter((a) => !registered.has(a));
    console.log(dim(`○ = agent not registered yet: ${missing.map((a) => `\`${agentAddCommand(a)}\``).join(", ")}`));
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

/** A side of `foreman org check`: an agent id in org.yaml, or a role id
 *  (then the agent filling it). An agent id wins when a name is both. */
function resolveCheckSide(org: OrgDoc, input: string): { agent: string; viaRole: string | null } | null {
  if (rolesForAgent(org, input).length > 0) return { agent: input.trim().toLowerCase(), viaRole: null };
  if (Object.hasOwn(org.roles, input)) {
    return { agent: org.roles[input]!.agent.trim().toLowerCase(), viaRole: input };
  }
  return null;
}

/** What policy.yaml says about the hand-off `<from> → <to>:write`, the call
 *  every agent-to-agent hand-off is mediated as, or null when no rule
 *  decides it (then the org chart does). A policy.yaml that doesn't load
 *  stops the command: no verdict from a policy the file doesn't say. */
function policyHandoffVerdict(from: string, to: string): { effect: "allow" | "deny" | "ask"; why: string } | null {
  const paths = getForemanPaths();
  const engine = new PolicyEngine(getDb(), new EventBus<ForemanEventMap>());
  try {
    if (existsSync(paths.policyPath)) {
      try {
        engine.loadFromYaml(paths.policyPath);
      } catch (err) {
        printPolicyLoadError(toPolicyLoadError(paths.policyPath, err));
        closeDb();
        process.exit(1);
      }
    }
    const evaluation = engine.evaluate({ sourceAgent: from, targetAgent: to, targetTool: DELEGATION_TOOL });
    if (evaluation.matchedRuleId !== undefined) {
      const rule = engine.list().find((r) => r.id === evaluation.matchedRuleId);
      const shown = rule ? `${rule.sourceAgent} → ${rule.target}` : `${from} → ${to}:${DELEGATION_TOOL}`;
      return {
        effect: evaluation.decision,
        why: `${terminalSafe(shown)} ${evaluation.decision}, rule #${evaluation.matchedRuleId}`,
      };
    }
    if (evaluation.label === "can_call") {
      return {
        effect: evaluation.decision,
        why: `agents.${terminalSafe(from)}.can_call.${terminalSafe(to)} doesn't list ${DELEGATION_TOOL}`,
      };
    }
    if (evaluation.label !== undefined) {
      return { effect: evaluation.decision, why: `policy:${terminalSafe(evaluation.label)}` };
    }
    return null;
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
