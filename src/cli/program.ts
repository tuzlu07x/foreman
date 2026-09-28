import { Command } from "commander";
import { reportCommand } from "./activity-cli.js";
import { agentsCommand } from "./agents-cli.js";
import { chatCommand } from "./chat-cli.js";
import { flowCommand } from "./flow-cli.js";
import { createCompletionCommand } from "./completion.js";
import { doctorCommand } from "./doctor.js";
import { hookCommand } from "./hook-cli.js";
import { daemonCommand } from "./hub-daemon.js";
import { identityCommand } from "./identity-cli.js";
import { initCommand } from "./init.js";
import { logCommand } from "./log.js";
import { mcpCommand } from "./mcp-cli.js";
import { integrationsCommand } from "./integrations-cli.js";
import { mcpStdioCommand } from "./mcp-stdio.js";
import { migrateCommand } from "./migrate.js";
import { llmCommand } from "./llm-cli.js";
import { migrateConfigCommand } from "./migrate-config.js";
import { notifyCommand } from "./notify-cli.js";
import { orgCommand } from "./org-cli.js";
import { inboxCommand } from "./inbox-cli.js";
import { usageCommand } from "./usage-cli.js";
import { demoCommand } from "./demo/demo-cli.js";
import { claudeLoginCommand, codexLoginCommand } from "./oauth-wrapper.js";
import { policyCommand } from "./policy-cli.js";
import { providerCommand } from "./provider-cli.js";
import { registryCommand } from "./registry-cli.js";
import { secretsCommand } from "./secrets-cli.js";
import { serviceCommand } from "./service-cli.js";
import { setupCommand } from "./setup.js";
import { startCommand } from "./start.js";
import { agentWrapCommand } from "./agent-wrap-cli.js";
import { delegationsCommand } from "./delegations-cli.js";
import { wrapCommand } from "./wrap.js";
import { writeCommand } from "./write-cli.js";
import { FOREMAN_VERSION } from "../version.js";

/** The whole `foreman` command tree. index.ts parses argv with it; tests
 *  walk it (every --help string, for instance). */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("foreman")
    .description(
      "Your local AI agents talk to each other. You should know what they're saying.",
    )
    .version(FOREMAN_VERSION);

  program.addCommand(initCommand);
  program.addCommand(setupCommand);
  program.addCommand(startCommand);
  program.addCommand(daemonCommand);
  program.addCommand(serviceCommand);
  program.addCommand(mcpStdioCommand);
  program.addCommand(mcpCommand);
  program.addCommand(integrationsCommand);
  program.addCommand(orgCommand);
  program.addCommand(inboxCommand);
  program.addCommand(usageCommand);
  program.addCommand(demoCommand);
  program.addCommand(logCommand);
  program.addCommand(policyCommand);
  program.addCommand(notifyCommand);
  program.addCommand(chatCommand);
  program.addCommand(writeCommand);
  program.addCommand(reportCommand);
  program.addCommand(llmCommand);
  program.addCommand(agentsCommand);
  program.addCommand(agentWrapCommand);
  program.addCommand(delegationsCommand);
  program.addCommand(flowCommand);
  program.addCommand(providerCommand);
  program.addCommand(codexLoginCommand);
  program.addCommand(claudeLoginCommand);
  program.addCommand(secretsCommand);
  program.addCommand(registryCommand);
  program.addCommand(identityCommand);
  program.addCommand(doctorCommand);
  program.addCommand(migrateConfigCommand);
  program.addCommand(migrateCommand);
  program.addCommand(wrapCommand);
  program.addCommand(hookCommand);
  program.addCommand(createCompletionCommand(() => program));
  return program;
}
