import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A PATH for tests that could reach an installer: `node` plus stub
// npm / npx / brew / curl that only log their arguments. Nothing on the
// developer's PATH (a real `claude`, a real `npm`) is reachable.

export interface StubInstallers {
  /** Directory to use as the whole PATH (plus /usr/bin:/bin for sh). */
  path: string
  /** Every stub call, one per line: "<tool> <args>". */
  calls: () => string[]
}

export function stubInstallers(dir: string, opts: { exitCode?: number } = {}): StubInstallers {
  const bin = join(dir, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'stub-calls.log')
  if (!existsSync(join(bin, 'node'))) symlinkSync(process.execPath, join(bin, 'node'))
  for (const tool of ['npm', 'npx', 'brew', 'curl', 'pnpm', 'yarn']) {
    const file = join(bin, tool)
    writeFileSync(file, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit ${opts.exitCode ?? 1}\n`)
    chmodSync(file, 0o755)
  }
  return {
    path: `${bin}:/usr/bin:/bin`,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []),
  }
}
