import { Command } from "commander";
import { agentsCommand } from "./agents-cli.js";
import { createCompletionCommand } from "./completion.js";
import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";
import { logCommand } from "./log.js";
import { mcpStdioCommand } from "./mcp-stdio.js";
import { migrateCommand } from "./migrate.js";
import { migrateConfigCommand } from "./migrate-config.js";
import { policyCommand } from "./policy-cli.js";
import { registryCommand } from "./registry-cli.js";
import { secretsCommand } from "./secrets-cli.js";
import { setupCommand } from "./setup.js";
import { startCommand } from "./start.js";
import { wrapCommand } from "./wrap.js";

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
program.addCommand(agentsCommand);
program.addCommand(secretsCommand);
program.addCommand(registryCommand);
program.addCommand(doctorCommand);
program.addCommand(migrateConfigCommand);
program.addCommand(migrateCommand);
program.addCommand(wrapCommand);
program.addCommand(createCompletionCommand(() => program));

program.parse();
