import { Command } from 'commander'
import { initCommand } from './init.js'
import { startCommand } from './start.js'

const program = new Command()
program
  .name('foreman')
  .description(
    "Your local AI agents talk to each other. You should know what they're saying.",
  )
  .version('0.1.0-pre')

program.addCommand(initCommand)
program.addCommand(startCommand)

program.parse()
