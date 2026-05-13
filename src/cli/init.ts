import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { Command } from 'commander'
import { closeDb, getDb } from '../db/client.js'
import { loadOrCreateMasterKey } from '../identity/keypair.js'
import { getForemanPaths, type ForemanPaths } from '../utils/config.js'
import { bold, dim, green, orange } from './colors.js'

const POLICY_TEMPLATE = `# Foreman policy file
# Edit and re-run 'foreman start' to apply.
#
# agents:
#   hermes:
#     can_call:
#       claude-code: [read_file, list_files]
#     cannot_call:
#       claude-code: [write_file, run_shell]
#     rate_limits:
#       messages_per_minute: 30
#       tokens_per_hour: 100000
`

export interface InitResult {
  paths: ForemanPaths
  publicKey: Buffer
  identityWasNew: boolean
  policyWasNew: boolean
}

/** Pure logic — no console output, no process.exit. CLI action wraps this. */
export function runInit(): InitResult {
  const paths = getForemanPaths()
  mkdirSync(paths.root, { recursive: true })
  const identityWasNew = !existsSync(paths.identityPath)
  const { publicKey } = loadOrCreateMasterKey()
  const policyWasNew = !existsSync(paths.policyPath)
  if (policyWasNew) writeFileSync(paths.policyPath, POLICY_TEMPLATE)
  getDb()
  closeDb()
  return { paths, publicKey, identityWasNew, policyWasNew }
}

export const initCommand = new Command('init')
  .description('Initialise ~/.foreman/ (identity, policy, database)')
  .action(() => {
    const { paths, publicKey, identityWasNew, policyWasNew } = runInit()
    const fp = publicKey.subarray(0, 4).toString('hex')
    console.log(`${orange(bold('Foreman'))} initialised`)
    console.log()
    console.log(
      `  ${green('✓')} identity   ${paths.identityPath} ${dim(`(ed25519:${fp}…${identityWasNew ? ', new' : ', reused'})`)}`,
    )
    console.log(
      `  ${green('✓')} policy     ${paths.policyPath} ${dim(policyWasNew ? '(template)' : '(kept)')}`,
    )
    console.log(`  ${green('✓')} database   ${paths.dbPath}`)
    console.log()
    console.log(dim("Next: run 'foreman start' to boot the gateway."))
  })
