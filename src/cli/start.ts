import { existsSync } from 'node:fs'
import { Command } from 'commander'
import { AuditLogger } from '../core/audit.js'
import { bus } from '../core/event-bus.js'
import { RegistryService } from '../core/registry.js'
import { closeDb, getDb } from '../db/client.js'
import { loadOrCreateMasterKey } from '../identity/keypair.js'
import { getForemanPaths } from '../utils/config.js'
import { bold, dim, orange, red } from './colors.js'

export class NotInitialisedError extends Error {
  constructor(public readonly rootPath: string) {
    super(`Foreman is not initialised at ${rootPath}. Run 'foreman init' first.`)
    this.name = 'NotInitialisedError'
  }
}

export interface StartedForeman {
  registry: RegistryService
  audit: AuditLogger
  publicKey: Buffer
  /** Resolves when the user presses q (or SIGINT). */
  waitForExit: () => Promise<void>
  shutdown: () => Promise<void>
}

/** Boot the services. Tests use this directly; the CLI action wraps it. */
export function startForeman(): StartedForeman {
  const paths = getForemanPaths()
  if (!existsSync(paths.root) || !existsSync(paths.identityPath)) {
    throw new NotInitialisedError(paths.root)
  }
  const { publicKey } = loadOrCreateMasterKey()
  const db = getDb()
  const registry = new RegistryService(db, bus)
  const audit = new AuditLogger(db, bus)

  let exitResolve: (() => void) | null = null
  // Keeps the event loop alive while we wait for q / SIGINT — AuditLogger's
  // flush timer is unref'd and signal handlers alone don't hold the loop.
  const keepAlive = setInterval(() => {}, 1 << 30)
  const waitForExit = () =>
    new Promise<void>((resolve) => {
      exitResolve = resolve
    })
  const triggerExit = () => {
    clearInterval(keepAlive)
    if (exitResolve) {
      const r = exitResolve
      exitResolve = null
      r()
    }
  }

  attachQuitHandler(triggerExit)

  const shutdown = async () => {
    clearInterval(keepAlive)
    audit.dispose()
    closeDb()
  }

  return { registry, audit, publicKey, waitForExit, shutdown }
}

export const startCommand = new Command('start')
  .description('Start the Foreman gateway (placeholder banner; full TUI lands in #16)')
  .action(async () => {
    let started: StartedForeman
    try {
      started = startForeman()
    } catch (err) {
      if (err instanceof NotInitialisedError) {
        console.error(red('error: ') + err.message)
        process.exit(1)
      }
      throw err
    }
    printBanner(started.publicKey, started.registry.list().length)
    await started.waitForExit()
    await started.shutdown()
    console.log(dim('bye.'))
  })

function printBanner(publicKey: Buffer, agentCount: number): void {
  const paths = getForemanPaths()
  const fp = publicKey.subarray(0, 4).toString('hex')
  console.log(`${orange(bold('Foreman'))} ${dim('v0.1.0-pre — your agent guardian')}`)
  console.log()
  console.log(`  ${orange('▸')} identity loaded   ${dim(`(ed25519:${fp}…)`)}`)
  console.log(`  ${orange('▸')} database ready    ${dim(`(${paths.dbPath})`)}`)
  console.log(`  ${orange('▸')} agents registered ${dim(`(${agentCount})`)}`)
  console.log()
  console.log(dim('Press q to quit'))
  console.log(dim('──────────────────────────────────────────'))
}

function attachQuitHandler(onQuit: () => void): void {
  const sigint = () => onQuit()
  process.once('SIGINT', sigint)
  process.once('SIGTERM', sigint)
  if (!process.stdin.isTTY) return
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  const onKey = (key: string) => {
    if (key === 'q' || key === '') {
      process.stdin.off('data', onKey)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      onQuit()
    }
  }
  process.stdin.on('data', onKey)
}
