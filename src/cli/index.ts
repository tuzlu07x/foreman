import { Command } from "commander";
import { agentsCommand } from "./agents-cli.js";
import { initCommand } from "./init.js";
import { logCommand } from "./log.js";
import { mcpStdioCommand } from "./mcp-stdio.js";
import { policyCommand } from "./policy-cli.js";
import { startCommand } from "./start.js";

const program = new Command();
program
  .name("foreman")
  .description(
    "Your local AI agents talk to each other. You should know what they're saying.",
  )
  .version("0.1.0-pre");

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(mcpStdioCommand);
program.addCommand(logCommand);
program.addCommand(policyCommand);
program.addCommand(agentsCommand);

program.parse();
