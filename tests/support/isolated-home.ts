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

// …and a throwaway HOME. Agent config paths resolve against it
// (~/.claude.json, ~/.claude/settings.json, ~/.codex, ~/.hermes): a test
// that installs or removes an agent must never edit the developer's real
// Claude Code or Codex settings. A test that needs its own HOME sets it.
{
  const home = mkdtempSync(join(tmpdir(), 'foreman-test-user-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
}
