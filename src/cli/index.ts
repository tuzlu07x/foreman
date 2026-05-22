import { Command } from "commander";
import { reportCommand } from "./activity-cli.js";
import { agentsCommand } from "./agents-cli.js";
import { chatCommand } from "./chat-cli.js";
import { createCompletionCommand } from "./completion.js";
import { doctorCommand } from "./doctor.js";
import { identityCommand } from "./identity-cli.js";
import { initCommand } from "./init.js";
import { logCommand } from "./log.js";
import { mcpStdioCommand } from "./mcp-stdio.js";
import { migrateCommand } from "./migrate.js";
import { llmCommand } from "./llm-cli.js";
import { migrateConfigCommand } from "./migrate-config.js";
import { notifyCommand } from "./notify-cli.js";
import {
  claudeLoginCommand,
  codexLoginCommand,
} from "./oauth-wrapper.js";
import { policyCommand } from "./policy-cli.js";
import { providerCommand } from "./provider-cli.js";
import { registryCommand } from "./registry-cli.js";
import { secretsCommand } from "./secrets-cli.js";
import { setupCommand } from "./setup.js";
import { startCommand } from "./start.js";
import { wrapCommand } from "./wrap.js";
import { writeCommand } from "./write-cli.js";

const program = new Command();
program
  .name("foreman")
  .description(
    "Your local AI agents talk to each other. You should know what they're saying.",
  )
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(setupCommand);
program.addCommand(startCommand);
program.addCommand(mcpStdioCommand);
program.addCommand(logCommand);
program.addCommand(policyCommand);
program.addCommand(notifyCommand);
program.addCommand(chatCommand);
program.addCommand(writeCommand);
program.addCommand(reportCommand);
program.addCommand(llmCommand);
program.addCommand(agentsCommand);
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
program.addCommand(createCompletionCommand(() => program));

function isForemanFriendlyError(
  err: unknown,
): err is Error & { foremanFriendly: true } {
  return (
    err instanceof Error &&
    (err as Error & { foremanFriendly?: boolean }).foremanFriendly === true
  );
}

process.on("uncaughtException", (err) => {
  if (isForemanFriendlyError(err)) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});

program.parse();
