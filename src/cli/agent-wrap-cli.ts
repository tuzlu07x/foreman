/**
 * `foreman agent-wrap <agent-id>` CLI (#445 PR 2).
 *
 * Long-running command that supervises a chat-only daemon agent:
 *   - Loads the agent's registry entry
 *   - Requires `input_protocol` to be declared (validator gate)
 *   - Resolves the bot token + owner chat id from the secret store /
 *     env (PR 4 wires the secret store path; for PR 2 we read env so
 *     the command is usable end-to-end against a real bot)
 *   - Spawns the agent's daemon child + starts the Telegram poller
 *   - Forwards owner-filtered updates as JSONL frames to child stdin
 *   - Blocks on the child's exit
 *
 * The actual orchestration logic lives in `src/core/agent-wrap.ts`;
 * this file is the CLI surface (arg parsing + secret resolution +
 * lifecycle glue + error reporting).
 */

import { existsSync } from 'node:fs'
import { Command } from 'commander'

import { startAgentWrap } from '../core/agent-wrap.js'
import { ControlChannel } from '../core/control-channel.js'
import { loadBundledRegistry } from '../core/registry-catalog.js'
import { getDb } from '../db/client.js'
import { getForemanPaths } from '../utils/config.js'
import { orange, red } from './colors.js'

interface AgentWrapOptions {
  ownerChatId?: string
  cwd?: string
}

export const agentWrapCommand = new Command('agent-wrap')
  .description(
    'Wrap a chat-only daemon agent: own its Telegram polling + inject Foreman directives into its input stream (see #445).',
  )
  .argument(
    '<agent-id>',
    "registry id of the agent to wrap (must declare `input_protocol` — see 'foreman registry validate' if you're not sure)",
  )
  .option(
    '--owner-chat-id <id>',
    'Telegram chat id of the registered owner (numeric). Defaults to env TELEGRAM_OWNER_CHAT_ID.',
  )
  .option(
    '--cwd <path>',
    "child process working directory (default: agent's daemon cwd / Foreman config dir)",
  )
  .action(async (agentId: string, options: AgentWrapOptions) => {
    const paths = getForemanPaths()
    if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
      process.stderr.write(
        red('error: ') +
          `Foreman is not initialised at ${paths.root}. Run 'foreman init' first.\n`,
      )
      process.exit(1)
    }

    const doc = loadBundledRegistry()
    const catalogEntry = doc.agents.find((a) => a.id === agentId)
    if (!catalogEntry) {
      process.stderr.write(
        red('error: ') + `agent "${agentId}" not found in the registry catalog.\n`,
      )
      process.exit(1)
    }
    if (!catalogEntry.input_protocol) {
      process.stderr.write(
        red('error: ') +
          `agent "${agentId}" cannot be wrap-launched: its catalog entry has no \`input_protocol\` block.\n` +
          `       See #445 for the schema. If this agent ships a programmable bidirectional transport (e.g. codex exec-server),\n` +
          `       configure \`approval_adapter\` instead.\n`,
      )
      process.exit(1)
    }
    if (!catalogEntry.daemon) {
      process.stderr.write(
        red('error: ') +
          `agent "${agentId}" has no \`daemon\` block in the catalog. agent-wrap needs a child command to spawn.\n`,
      )
      process.exit(1)
    }

    const ownerChatIdRaw = options.ownerChatId ?? process.env.TELEGRAM_OWNER_CHAT_ID
    const ownerChatId = ownerChatIdRaw ? Number(ownerChatIdRaw) : NaN
    if (!Number.isFinite(ownerChatId)) {
      process.stderr.write(
        red('error: ') +
          'owner chat id required. Pass --owner-chat-id <id> or set env TELEGRAM_OWNER_CHAT_ID.\n',
      )
      process.exit(1)
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) {
      process.stderr.write(
        red('error: ') +
          'env TELEGRAM_BOT_TOKEN is required (set it via the secret store or foreman setup).\n',
      )
      process.exit(1)
    }

    const childArgv = {
      command: catalogEntry.daemon.command,
      args: catalogEntry.daemon.args ?? [],
    }

    process.stderr.write(
      `[agent-wrap] launching ${agentId} (${childArgv.command} ${childArgv.args.join(' ')})\n`,
    )

    // #445 PR 3 — Hook the wrap into the #440 control_commands queue
    // so `/foreman write <agent> "msg"` directives flow into the
    // child's stdin as synthesised user updates. The CLI process
    // shares the Foreman DB with mcp-stdio (writer) + foreman start
    // (legacy drain); PR 5 coordinates the two drain paths.
    const db = getDb()
    const controlChannel = new ControlChannel(db)

    const handle = startAgentWrap({
      entry: catalogEntry,
      botToken,
      ownerChatId,
      childArgv,
      childCwd: options.cwd,
      controlChannel,
      onError(err) {
        process.stderr.write(orange('[agent-wrap warn] ') + err.message + '\n')
      },
    })

    // Forward child stderr to ours so the operator can see the daemon's
    // log output as if it were running unwrapped. Stdout deliberately
    // stays on the child's stdin path (used by us) — PR 5 wires the
    // stdout splitter that lets log lines surface alongside the
    // protocol traffic.
    handle.process.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })

    const onShutdownSignal = async () => {
      process.stderr.write('[agent-wrap] received shutdown signal\n')
      await handle.shutdown()
    }
    process.on('SIGINT', onShutdownSignal)
    process.on('SIGTERM', onShutdownSignal)

    const exit = await handle.exited
    process.stderr.write(
      `[agent-wrap] child exited (code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'})\n`,
    )
    process.exit(exit.code ?? (exit.signal ? 1 : 0))
  })
