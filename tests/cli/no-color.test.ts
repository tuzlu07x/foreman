import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// NO_COLOR (no-color.org) must reach the TUI. Ink's colour library only
// reads FORCE_COLOR, at load time, so env-preflight translates it and has
// to run before anything else in the CLI bundle.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('NO_COLOR', () => {
  it('env-preflight is the first thing the CLI bundle imports', () => {
    const lines = readFileSync(resolve(ROOT, 'dist/cli/index.js'), 'utf-8').split('\n')
    expect(lines.find((l) => l.startsWith('import '))).toBe("import './env-preflight.js';")
  })

  it('turns colour off for the colour library Ink uses', () => {
    const script = `import './dist/cli/env-preflight.js'; const { default: chalk } = await import('chalk'); process.stdout.write(String(chalk.level))`
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync('node', ['--input-type=module', '-e', script], { cwd: ROOT, env, encoding: 'utf-8' }).stdout.trim()
    const base = { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined }
    expect(run({ ...base, NO_COLOR: '1' })).toBe('0')
    // An explicit FORCE_COLOR still wins.
    expect(run({ ...base, NO_COLOR: '1', FORCE_COLOR: '3' })).not.toBe('0')
  })
})
