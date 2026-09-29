import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// The standalone binaries embed dist/ folders that `npm run build` copies
// there (tsup's onSuccess). 2.3.0's release-binaries failed on every
// platform because the build still asked for dist/assets/mascot after the
// pixel mascot (#724) stopped copying it. Every folder the binary embeds
// must be one the build writes.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

it('embeds only folders that npm run build writes to dist/', () => {
  const script = readFileSync(join(ROOT, 'scripts/build-binaries.mjs'), 'utf-8')
  const list = /const DATA_DIRS = \[([^\]]*)\]/.exec(script)?.[1]
  expect(list, 'DATA_DIRS in build-binaries.mjs').toBeDefined()
  const dirs = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
  expect(dirs.length).toBeGreaterThan(0)
  const build = readFileSync(join(ROOT, 'tsup.config.ts'), 'utf-8')
  for (const dir of dirs) expect(build, `tsup.config.ts copies dist/${dir}`).toContain(`dist/${dir}`)
})
