import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
    // Child processes, not worker threads: better-sqlite3 11 aborts on
    // Node 24 when a worker thread tears down an open Database.
    pool: 'forks',
  },
})
