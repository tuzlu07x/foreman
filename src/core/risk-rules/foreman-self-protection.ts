import { homedir } from 'node:os'
import { parse as parseShell } from 'shell-quote'
import { getForemanPaths } from '../../utils/config.js'
import { isUntrustedSource } from '../agent-identity.js'
import { shortFingerprint } from './secret-patterns.js'
import type { RiskFactor, RiskRule } from './types.js'

// =============================================================================
// FOREMAN SELF-PROTECTION (tamper protection)
// =============================================================================
//
// Foreman runs as the same OS user as the agents it guards, so a gated agent
// could try to switch the guard off instead of getting past it: approve its
// own pending request with `sqlite3 foreman.db "UPDATE pending_approvals…"`,
// rewrite policy.yaml, read the secret-store key, drop the PreToolUse hook
// from ~/.claude/settings.json, or change its own `--source` id in its MCP
// config. None of those looked risky to the other rules (a plain `sqlite3`
// call scores 0). This rule makes any touch of Foreman's own state, key
// material, or the hook / MCP wiring of the agents it gates a critical,
// human-approved event.

const CRITICAL = 90
const HIGH = 65

/** Foreman-owned state, matched anywhere in the call's args. */
const FOREMAN_STATE_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /foreman[^\s"'/\\]*\.db\b/i, reason: "Foreman's audit / approval database" },
  { re: /(^|[\s"'/\\=])secrets\.key\b/i, reason: "Foreman's secret-store master key" },
  { re: /(^|[\s"'/\\=])identity\.key\b/i, reason: "Foreman's identity key" },
  { re: /mcp-pins\.json\b/i, reason: "Foreman's MCP tool-definition pins" },
  { re: /[/\\]\.config[/\\]foreman([/\\"'\s]|$)/i, reason: "Foreman's config directory" },
  { re: /Application Support[/\\]foreman([/\\"'\s]|$)/i, reason: "Foreman's config directory" },
  { re: /[/\\]\.local[/\\]state[/\\]foreman([/\\"'\s]|$)/i, reason: "Foreman's state directory" },
  { re: /(^|[\s"'=])~?[/\\]?\.foreman[/\\]/i, reason: "Foreman's legacy home" },
]

/** Files that decide whether an agent is gated at all. Reading them is
 *  normal; writing them (or touching them from a shell) is how an agent
 *  would unhook itself or impersonate another agent id. */
const AGENT_WIRING_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\.claude[/\\]settings(\.local)?\.json\b/i, reason: 'Claude Code settings (holds the Foreman hook)' },
  { re: /(^|[/\\\s"'~])\.claude\.json\b/i, reason: 'Claude Code MCP config (holds the Foreman wiring and agent token)' },
  { re: /(^|[/\\\s"'])\.mcp\.json\b/i, reason: "project MCP config (can shadow Foreman's MCP server)" },
  { re: /\.codex[/\\]config\.toml\b/i, reason: 'Codex config (MCP wiring)' },
  { re: /\.hermes[/\\]config\.ya?ml\b/i, reason: 'Hermes config (MCP wiring)' },
  { re: /\.openclaw[/\\][^\s"']*\.(json|ya?ml|toml)\b/i, reason: 'OpenClaw config (MCP wiring)' },
  { re: /\.zeroclaw[/\\]config\.toml\b/i, reason: 'ZeroClaw config (MCP wiring)' },
]

/** Where each agent's MCP wiring, and so its identity token (#618), lives.
 *  An agent reading ANOTHER agent's file is after that agent's identity. */
const TOKEN_WIRING_FILES: ReadonlyArray<{ re: RegExp; agent: string; label: string }> = [
  { re: /(^|[/\\\s"'~])\.claude\.json\b/i, agent: 'claude-code', label: "Claude Code's MCP config" },
  { re: /\.codex[/\\]config\.toml\b/i, agent: 'codex', label: "Codex's config" },
  { re: /\.hermes[/\\]config\.ya?ml\b/i, agent: 'hermes', label: "Hermes' config" },
  { re: /\.openclaw[/\\][^\s"']*\.(json5?|ya?ml|toml)\b/i, agent: 'openclaw', label: "OpenClaw's config" },
  { re: /\.zeroclaw[/\\]config\.toml\b/i, agent: 'zeroclaw', label: "ZeroClaw's config" },
]

/** Any process's environment: an MCP server's holds its agent's token. */
const PROC_ENVIRON = /\/proc\/[^\s"'/]+\/environ\b/i

/** `foreman` CLI verbs that change security state. Read-only verbs
 *  (`log`, `doctor`, `--version`) and delegation (`write`) stay allowed. */
const MUTATING_FOREMAN_CLI =
  /(^|[\s;&|`("'])foreman\s+(policy|secrets|agents?|hook|notify|mcp|org|identity|llm|init|migrate|migrate-config|setup|registry|provider)\b[^\n;&|]*/i

const SECRET_REVEAL = /(^|[\s;&|`("'])foreman\s+secrets\s+show\b[^\n;&|]*--reveal/i

const WRITE_TOOLS = new Set([
  'file_write',
  'write_file',
  'edit_file',
  'create_file',
  'move_file',
  'delete_file',
  'shell_exec',
  'bash',
  'sh',
  'execute_command',
  'run_command',
])

export const foremanSelfProtectionRule: RiskRule = {
  name: 'foreman_self_protection',
  category: 'structural',
  evaluate(req): RiskFactor[] {
    if (req.args === undefined || req.args === null) return []
    let text: string
    try {
      text = JSON.stringify(req.args)
    } catch {
      return []
    }
    if (text.length === 0) return []
    const factors: RiskFactor[] = []

    const stateHit = matchForemanState(text)
    if (stateHit) {
      factors.push({
        rule: 'foreman_self_tamper',
        category: 'structural',
        points: CRITICAL,
        reason: `Touches ${stateHit.reason} — agents must not read or change Foreman's own state`,
        evidence: shortFingerprint(stateHit.match),
      })
    }

    // Hub tools are namespaced `<server>__<tool>` (e.g. `fs__write_file`).
    const tool = (req.targetTool ?? '').toLowerCase().split('__').pop() ?? ''
    if (WRITE_TOOLS.has(tool)) {
      for (const { re, reason } of AGENT_WIRING_PATTERNS) {
        const m = re.exec(text)
        if (m) {
          factors.push({
            rule: 'agent_wiring_tamper',
            category: 'structural',
            points: HIGH,
            reason: `Modifies ${reason} — could remove Foreman's gate or change an agent's identity`,
            evidence: m[0].trim(),
          })
          break
        }
      }
    }

    // Any access, read included: the file holds another agent's token.
    // Only a verified agent's own file is exempt; `untrusted:<id>` hasn't
    // proven it is <id>, and <id>'s file is exactly what it would want.
    const self = isUntrustedSource(req.sourceAgent) ? null : req.sourceAgent.trim().toLowerCase()
    for (const { re, agent, label } of TOKEN_WIRING_FILES) {
      const m = re.exec(text)
      if (m && agent !== self) {
        factors.push({
          rule: 'agent_token_access',
          category: 'structural',
          points: CRITICAL,
          reason: `Touches ${label}, which holds ${agent}'s Foreman identity token — an agent can use it to pass as ${agent}`,
          evidence: m[0].trim(),
        })
        break
      }
    }
    const environ = PROC_ENVIRON.exec(text)
    if (environ) {
      factors.push({
        rule: 'process_environ_access',
        category: 'structural',
        points: CRITICAL,
        reason: "Reads a process's environment, where agents' Foreman identity tokens live",
        evidence: environ[0],
      })
    }

    const cliText = foremanCliText(tool, req.args, text)
    const reveal = cliText === null ? null : SECRET_REVEAL.exec(cliText)
    const mutating = reveal ?? (cliText === null ? null : MUTATING_FOREMAN_CLI.exec(cliText))
    if (mutating) {
      factors.push({
        rule: 'foreman_cli_tamper',
        category: 'structural',
        points: reveal ? CRITICAL : HIGH,
        reason: reveal
          ? 'Tries to reveal a secret through the Foreman CLI'
          : 'Runs a Foreman command that changes policy, secrets, agents or integrations',
        evidence: mutating[0].trim().slice(0, 80),
      })
    }
    return factors
  },
}

/** Tools whose args carry file content, which nothing runs. */
const CONTENT_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'file_write', 'write_file', 'edit_file', 'create_file'])
const CONTENT_FIELDS = new Set(['content', 'new_string', 'old_string', 'edits', 'new_source', 'text', 'body'])

/** Command words that run text they are given (`sh -c`, `eval`, `xargs`,
 *  interpreters): a `foreman …` anywhere near them may be run. */
const RUNS_TEXT = /^(sh|bash|zsh|dash|ksh|fish|eval|source|\.|exec|xargs|env|sudo|doas|nohup|time|nice|command|builtin|watch|timeout|script|osascript|python[\d.]*|node|deno|bun|perl|ruby|php|lua|awk|gawk|find|parallel|ssh)$/

/**
 * The part of a call where `foreman <verb>` would be a command that runs,
 * or null when there is none (2.3.0 real test, finding 18: a commit
 * message or a PR body that mentions a Foreman command was blocked as if
 * it ran it):
 *   - file content (Write, Edit) is never run: only the other args count;
 *   - a shell command counts only where `foreman` is a command word. When
 *     anything in it can run text (a shell, `eval`, `xargs`, `$(…)`,
 *     backticks, a heredoc) or it can't be parsed, the whole command counts,
 *     as before.
 */
function foremanCliText(tool: string, args: unknown, fullText: string): string | null {
  if (CONTENT_TOOLS.has(tool) && args && typeof args === 'object' && !Array.isArray(args)) {
    const rest = Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => !CONTENT_FIELDS.has(k)))
    return JSON.stringify(rest)
  }
  const command =
    (tool === 'bash' || tool === 'shell_exec' || tool === 'execute_command' || tool === 'run_command') &&
    args &&
    typeof args === 'object' &&
    typeof (args as { command?: unknown }).command === 'string'
      ? (args as { command: string }).command
      : null
  if (command === null) return fullText
  // From here, a fallback reads the raw command: in JSON a line break is
  // `\n`, which hid a `foreman` at the start of a heredoc line.
  if (/\$\(|`|<<|<\(|>\(/.test(command)) return command
  // Quotes can split the word (`"fore"man`): parse even when the text
  // doesn't spell it out.
  if (!/foreman/i.test(command) && !/["'\\]/.test(command)) return null
  let parsed: ReturnType<typeof parseShell>
  try {
    parsed = parseShell(command)
  } catch {
    return command
  }
  const commands: string[][] = [[]]
  for (const token of parsed) {
    if (typeof token === 'string') commands[commands.length - 1]!.push(token)
    else if ('op' in token && token.op !== 'glob') commands.push([])
    else if ('op' in token && token.op === 'glob') commands[commands.length - 1]!.push(token.pattern)
    else return command // comments and anything else shell-quote can't flatten
  }
  const found: string[] = []
  for (const argv of commands) {
    const start = argv.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w))
    if (start < 0) continue
    const word = (argv[start]!.split('/').pop() ?? '').toLowerCase()
    if (RUNS_TEXT.test(word)) return command
    // By any path (`/usr/local/bin/foreman policy …`): named as `foreman`.
    if (word === 'foreman') found.push(['foreman', ...argv.slice(start + 1)].join(' '))
  }
  return found.length > 0 ? found.join('\n') : null
}

function matchForemanState(text: string): { reason: string; match: string } | null {
  for (const { re, reason } of FOREMAN_STATE_PATTERNS) {
    const m = re.exec(text)
    if (m) return { reason, match: m[0] }
  }
  // The live install may use FOREMAN_HOME or a platform dir that the
  // generic patterns above don't spell out.
  let paths: ReturnType<typeof getForemanPaths>
  try {
    paths = getForemanPaths()
  } catch {
    return null
  }
  const home = homedir()
  for (const dir of new Set([paths.configDir, paths.stateDir])) {
    if (!dir || dir === home || dir.length < 4) continue
    const variants = [dir, dir.replace(home, '~'), dir.replace(home, '$HOME')]
    for (const v of variants) {
      if (text.includes(JSON.stringify(v).slice(1, -1))) {
        return { reason: "Foreman's config / state directory", match: v }
      }
    }
  }
  return null
}
