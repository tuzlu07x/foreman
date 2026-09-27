import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    passWithNoTests: true,
    // A throwaway FOREMAN_HOME per test file (tests/support/isolated-home.ts).
    setupFiles: ['tests/support/isolated-home.ts'],
    // Child processes, not worker threads: each test file gets its own
    // copy of the native SQLite binding, which tears down more reliably
    // across Node versions than a shared worker thread.
    pool: 'forks',
  },
})
