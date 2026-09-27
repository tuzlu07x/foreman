import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test file runs against a throwaway Foreman home unless it sets its
// own. Without this, code that falls back to the default location
// (~/.local/state/foreman) would read and migrate the developer's real
// database while the suite runs.
if (!process.env.FOREMAN_HOME) {
  process.env.FOREMAN_HOME = mkdtempSync(join(tmpdir(), 'foreman-test-home-'))
}
