import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// End-to-end QA journeys (`npm run qa`, see docs/qa.md). Separate from the
// unit suite: real processes, one scenario file at a time, generous
// timeouts, and a Markdown report in qa/out/qa-report.md.

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['qa/**/*.qa.ts'],
    pool: 'forks',
    // One scenario at a time, one fork at a time (Vitest 4 replaced
    // poolOptions.forks.singleFork with top-level options).
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    reporters: ['default', './qa/markdown-reporter.ts'],
  },
})
