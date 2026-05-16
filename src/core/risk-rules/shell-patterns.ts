import { parse as parseShell } from 'shell-quote'
import { shortFingerprint } from './secret-patterns.js'
import type { RiskFactor, RiskRule } from './types.js'

// =============================================================================
// SHELL DANGER PATTERNS
// =============================================================================
//
// Replaces the original binary `shell_exec` rule (#226 / C3). Tokenises the
// command via shell-quote so quoted false-positives don't trip ("echo 'rm -rf'"
// is benign), then runs a curated set of argv- or regex-based matchers across
// 6 attack categories.
//
// Sources: MITRE ATT&CK (Execution / Persistence / Defense Evasion / Discovery),
// GTFOBins, LOLBAS (Windows analogue tracked for v0.2).

// =============================================================================
// Shell tool detection — which targetTool names mean "agent wants to shell out"
// =============================================================================

const SHELL_TOOL_NAMES = new Set([
  'shell_exec',
  'execute_code',
  'run_command',
  'run_shell',
  'execute',
  'bash',
  'sh',
  'zsh',
  'exec',
])

function isShellTool(name: string | undefined): boolean {
  return name !== undefined && SHELL_TOOL_NAMES.has(name.toLowerCase())
}

// =============================================================================
// Command extraction — common arg shapes used by partner agents
// =============================================================================

function extractCommand(args: unknown): string | null {
  if (args === undefined || args === null) return null
  if (typeof args === 'string') return args
  if (typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  // Combined shape first: { command: "ls", args: ["-la", "/tmp"] }
  if (typeof obj.command === 'string' && Array.isArray(obj.args)) {
    return [obj.command, ...(obj.args as unknown[]).map(String)].join(' ')
  }
  for (const key of ['cmd', 'command', 'shell', 'script', 'code']) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (Array.isArray(v)) {
      return v.map(String).join(' ')
    }
  }
  return null
}

// =============================================================================
// Tokenisation
// =============================================================================

function tokenize(cmd: string): string[] {
  try {
    return parseShell(cmd).filter((t): t is string => typeof t === 'string')
  } catch {
    return cmd.split(/\s+/).filter((t) => t.length > 0)
  }
}

// =============================================================================
// Pattern definitions
// =============================================================================

interface ShellPattern {
  id: string
  points: number
  reason: string
  match: (cmd: string, argv: string[]) => boolean
}

// --- 1. Destructive ops (auto-critical / auto-high) -------------------------

// Helpers shared by destructive matchers — work on whatever tokenisation
// produced. shell-quote drops `$HOME` / `/*` because they're env-var or glob
// operators, so we re-check the raw cmd via regex once the rm + -rf gate has
// passed via the tokeniser (which still defeats quoted false positives).

const RF_FLAG_RE = /^-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*$|^-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*$/

const CATASTROPHIC_TARGET_RE =
  /(?:^|[\s|;&])(?:\/|\/\*|~\/?\*?|\$\{?HOME\}?\/?\*?|\/usr|\/etc|\/var|\/boot)(?:\s|$|;|&|\|)/

// True if argv contains an `rm` token followed by an -rf-style flag (in any
// argv position). Strips a leading sudo/doas wrapper so `sudo rm -rf /` is
// equivalent to `rm -rf /`.
function hasUnquotedRmRf(argv: string[]): boolean {
  const start = argv[0] === 'sudo' || argv[0] === 'doas' ? skipSudoFlags(argv) : 0
  for (let i = start; i < argv.length; i++) {
    if (argv[i] !== 'rm') continue
    for (let j = i + 1; j < argv.length; j++) {
      const tok = argv[j]
      if (tok === undefined) break
      if (RF_FLAG_RE.test(tok)) return true
      // A non-flag positional ends the flag block — no -rf found.
      if (!tok.startsWith('-')) break
    }
  }
  return false
}

// After `sudo` (or `doas`), skip option flags and their values to land on the
// effective command. Returns the index of the wrapped command in argv (or
// argv.length if none).
function skipSudoFlags(argv: string[]): number {
  let i = 1
  while (i < argv.length) {
    const tok = argv[i]
    if (tok === undefined || !tok.startsWith('-')) break
    if (tok === '-u' || tok === '-g') i += 2 // takes a value
    else i += 1
  }
  return i
}

const DESTRUCTIVE_OPS: ShellPattern[] = [
  {
    id: 'shell_rm_rf_catastrophic',
    points: 85,
    reason: 'rm -rf targets a system/home directory (catastrophic)',
    match: (cmd, argv) => {
      if (!hasUnquotedRmRf(argv)) return false
      return CATASTROPHIC_TARGET_RE.test(cmd)
    },
  },
  {
    id: 'shell_rm_rf_general',
    points: 60,
    reason: 'rm -rf <path> (recursive force delete)',
    match: (_cmd, argv) => hasUnquotedRmRf(argv),
  },
  {
    id: 'shell_dd_to_disk',
    points: 85,
    reason: 'dd writing to a block device (disk wipe / overwrite)',
    match: (cmd) => /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|disk|mmcblk|vd)[a-z0-9]+/i.test(cmd),
  },
  {
    id: 'shell_mkfs_on_disk',
    points: 85,
    reason: 'mkfs.* on a real block device (reformat)',
    match: (_cmd, argv) => {
      if (!(argv[0] && /^mkfs(\..+)?$/.test(argv[0]))) return false
      return argv.some((t) => /^\/dev\/(sd|nvme|hd|disk|mmcblk|vd)[a-z0-9]+$/i.test(t))
    },
  },
  {
    id: 'shell_fdisk_disk',
    points: 60,
    reason: 'fdisk on a block device (partition table edit)',
    match: (_cmd, argv) => {
      if (argv[0] !== 'fdisk' && argv[0] !== 'parted' && argv[0] !== 'gdisk') return false
      return argv.some((t) => /^\/dev\/(sd|nvme|hd|disk|mmcblk|vd)[a-z0-9]+$/i.test(t))
    },
  },
  {
    id: 'shell_shred',
    points: 60,
    reason: 'shred -u (unrecoverable file destruction)',
    match: (_cmd, argv) => argv[0] === 'shred' && argv.some((t) => t.includes('u')),
  },
  {
    id: 'shell_fork_bomb',
    points: 85,
    reason: 'fork bomb (`:(){:|:&};:`)',
    match: (cmd) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd),
  },
  {
    id: 'shell_chmod_000_root',
    points: 60,
    reason: 'chmod 000 on / (lock out the system)',
    match: (_cmd, argv) =>
      argv[0] === 'chmod' &&
      argv.includes('000') &&
      (argv.includes('/') || argv.includes('/*')),
  },
  {
    id: 'shell_chown_recursive_root',
    points: 60,
    reason: 'chown -R targets / (mass ownership change)',
    match: (_cmd, argv) => {
      if (argv[0] !== 'chown' || !argv.includes('-R')) return false
      return argv.includes('/') || argv.includes('/*')
    },
  },
  {
    id: 'shell_truncate_dev',
    points: 60,
    reason: 'redirect to /dev/sd* (disk overwrite via shell redirection)',
    match: (cmd) => />\s*\/dev\/(sd|nvme|hd|disk|mmcblk|vd)[a-z0-9]+/i.test(cmd),
  },
]

// --- 2. Privilege escalation ------------------------------------------------

const PRIVESC: ShellPattern[] = [
  {
    id: 'shell_sudo',
    points: 40,
    reason: 'sudo (privilege escalation)',
    match: (_cmd, argv) => argv[0] === 'sudo',
  },
  {
    id: 'shell_doas',
    points: 40,
    reason: 'doas (privilege escalation)',
    match: (_cmd, argv) => argv[0] === 'doas',
  },
  {
    id: 'shell_chmod_setuid',
    points: 40,
    reason: 'chmod +s / u+s (setuid bit on a binary)',
    match: (_cmd, argv) =>
      argv[0] === 'chmod' && argv.some((t) => /^[ug]?\+s$|^4[0-9]{3}$/.test(t)),
  },
  {
    id: 'shell_chown_to_root',
    points: 40,
    reason: 'chown root:... (re-owning a file as root)',
    match: (_cmd, argv) => argv[0] === 'chown' && argv.some((t) => /^root(:.*)?$/.test(t)),
  },
  {
    id: 'shell_visudo',
    points: 40,
    reason: 'visudo (edit /etc/sudoers)',
    match: (_cmd, argv) => argv[0] === 'visudo',
  },
  {
    id: 'shell_sudoers_write',
    points: 50,
    reason: 'write to /etc/sudoers (bypassing visudo)',
    match: (cmd) => /(?:>>?|tee)[^|;\n]*\/etc\/sudoers/i.test(cmd),
  },
  {
    id: 'shell_usermod_sudo_group',
    points: 40,
    reason: 'usermod -aG sudo (granting sudo membership)',
    match: (_cmd, argv) =>
      argv[0] === 'usermod' &&
      argv.includes('-aG') &&
      (argv.includes('sudo') || argv.includes('wheel') || argv.includes('admin')),
  },
  {
    id: 'shell_su_root',
    points: 40,
    reason: 'su / su - (becoming another user)',
    match: (_cmd, argv) => argv[0] === 'su',
  },
]

// --- 3. Persistence ---------------------------------------------------------

const PERSISTENCE: ShellPattern[] = [
  {
    id: 'shell_persist_crontab',
    points: 35,
    reason: 'crontab edit/list (cron persistence)',
    match: (_cmd, argv) =>
      argv[0] === 'crontab' && (argv.includes('-e') || argv.includes('-l') || argv.includes('-r')),
  },
  {
    id: 'shell_persist_bashrc',
    points: 35,
    reason: 'appending to ~/.bashrc (shell startup persistence)',
    match: (cmd) => />>\s*(?:~\/?|\$HOME\/?|\${HOME}\/?)?\.bashrc\b/i.test(cmd),
  },
  {
    id: 'shell_persist_zshrc',
    points: 35,
    reason: 'appending to ~/.zshrc (shell startup persistence)',
    match: (cmd) => />>\s*(?:~\/?|\$HOME\/?|\${HOME}\/?)?\.zshrc\b/i.test(cmd),
  },
  {
    id: 'shell_persist_profile',
    points: 35,
    reason: 'appending to shell profile (~/.profile / ~/.bash_profile)',
    match: (cmd) => />>\s*(?:~\/?|\$HOME\/?|\${HOME}\/?)?\.(?:bash_)?profile\b/i.test(cmd),
  },
  {
    id: 'shell_persist_cron_dir',
    points: 35,
    reason: 'writing to /etc/cron.* (system cron persistence)',
    match: (cmd) => />>?\s*\/etc\/cron\./i.test(cmd),
  },
  {
    id: 'shell_persist_systemctl_enable',
    points: 35,
    reason: 'systemctl enable (persistent service install)',
    match: (_cmd, argv) =>
      argv[0] === 'systemctl' &&
      (argv.includes('enable') || argv.includes('--now')),
  },
  {
    id: 'shell_persist_launchctl_load',
    points: 35,
    reason: 'launchctl load (macOS persistence via LaunchAgent/Daemon)',
    match: (_cmd, argv) =>
      argv[0] === 'launchctl' && (argv.includes('load') || argv.includes('bootstrap')),
  },
  {
    id: 'shell_persist_launchagent_dir',
    points: 35,
    reason: 'writing into ~/Library/LaunchAgents (macOS persistence)',
    match: (cmd) => /Library\/Launch(Agents|Daemons)\b/i.test(cmd),
  },
]

// --- 4. Reverse shell / network exfil ---------------------------------------

const REVERSE_SHELL: ShellPattern[] = [
  {
    id: 'shell_revsh_nc_e',
    points: 60,
    reason: 'nc -e /bin/sh (classic netcat reverse shell)',
    match: (_cmd, argv) =>
      argv[0] === 'nc' &&
      argv.includes('-e') &&
      argv.some((t) => /\/bin\/(ba|z|d)?sh$/.test(t)),
  },
  {
    id: 'shell_revsh_bash_tcp',
    points: 60,
    reason: 'bash -i >& /dev/tcp/...  (bash reverse shell)',
    match: (cmd) => /bash\s+-i[^|\n]*>&\s*\/dev\/tcp\//i.test(cmd),
  },
  {
    id: 'shell_revsh_curl_pipe_bash',
    points: 60,
    reason: 'curl ... | bash (download-and-execute)',
    match: (cmd) => /\bcurl\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i.test(cmd),
  },
  {
    id: 'shell_revsh_wget_pipe_bash',
    points: 60,
    reason: 'wget -O - ... | bash (download-and-execute)',
    match: (cmd) =>
      /\bwget\b[^|\n]*-O\s*-[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i.test(cmd) ||
      /\bwget\b[^|\n]*--output-document\s*=?\s*-[^|\n]*\|\s*(?:ba|z|d)?sh\b/i.test(cmd),
  },
  {
    id: 'shell_revsh_ssh_reverse_port',
    points: 50,
    reason: 'ssh -R (reverse port forward — exposes local service outward)',
    match: (_cmd, argv) => argv[0] === 'ssh' && argv.includes('-R'),
  },
  {
    id: 'shell_revsh_python_socket',
    points: 60,
    reason: 'python ... socket.*connect (python reverse shell)',
    match: (cmd) => /python[0-9.]*\s+-c\b[^\n]*socket[^\n]*connect/i.test(cmd),
  },
  {
    id: 'shell_revsh_perl_socket',
    points: 60,
    reason: 'perl -e ... socket (perl reverse shell)',
    match: (cmd) => /\bperl\b\s+-e[^\n]*socket/i.test(cmd),
  },
  {
    id: 'shell_revsh_ruby_socket',
    points: 60,
    reason: 'ruby -e ... socket (ruby reverse shell)',
    match: (cmd) => /\bruby\b\s+-e[^\n]*(?:TCPSocket|socket)/i.test(cmd),
  },
]

// --- 5. Defense evasion -----------------------------------------------------

const DEFENSE_EVASION: ShellPattern[] = [
  {
    id: 'shell_evasion_history_clear',
    points: 35,
    reason: 'clearing shell history (history -c)',
    match: (_cmd, argv) => argv[0] === 'history' && argv.includes('-c'),
  },
  {
    id: 'shell_evasion_history_file_wipe',
    points: 35,
    reason: 'wiping ~/.bash_history',
    match: (cmd) =>
      /(?:^|[\s|;&])(?:rm\s|>)\s*(?:~\/?|\$HOME\/?)?\.bash_history\b/i.test(cmd) ||
      /(?:^|[\s|;&])>\s*(?:~\/?|\$HOME\/?)?\.zsh_history\b/i.test(cmd),
  },
  {
    id: 'shell_evasion_unset_histfile',
    points: 35,
    reason: 'unset HISTFILE (disabling history persistence)',
    match: (_cmd, argv) => argv[0] === 'unset' && argv.includes('HISTFILE'),
  },
  {
    id: 'shell_evasion_iptables_flush',
    points: 35,
    reason: 'iptables -F (flush firewall rules)',
    match: (_cmd, argv) => argv[0] === 'iptables' && argv.includes('-F'),
  },
  {
    id: 'shell_evasion_ufw_disable',
    points: 35,
    reason: 'ufw disable (turn off firewall)',
    match: (_cmd, argv) => argv[0] === 'ufw' && argv.includes('disable'),
  },
  {
    id: 'shell_evasion_audit_disable',
    points: 35,
    reason: 'auditctl -e 0 (disable Linux auditing)',
    match: (_cmd, argv) => argv[0] === 'auditctl' && argv.includes('-e') && argv.includes('0'),
  },
]

// --- 6. Recon / info gathering ----------------------------------------------

const RECON: ShellPattern[] = [
  {
    id: 'shell_recon_etc_shadow',
    points: 50,
    reason: 'reading /etc/shadow (password hashes — privileged target)',
    match: (cmd) => /\/etc\/shadow\b/.test(cmd),
  },
  {
    id: 'shell_recon_uname_a',
    points: 20,
    reason: 'uname -a (host kernel / arch fingerprint)',
    match: (_cmd, argv) => argv[0] === 'uname' && argv.some((t) => t.includes('a')),
  },
  {
    id: 'shell_recon_whoami',
    points: 20,
    reason: 'whoami (current user discovery)',
    match: (_cmd, argv) => argv[0] === 'whoami',
  },
  {
    id: 'shell_recon_id',
    points: 20,
    reason: 'id (current uid/gid discovery)',
    match: (_cmd, argv) => argv[0] === 'id' && argv.length === 1,
  },
  {
    id: 'shell_recon_etc_passwd',
    points: 20,
    reason: 'reading /etc/passwd (user list discovery)',
    match: (cmd) => /\/etc\/passwd\b/.test(cmd),
  },
  {
    id: 'shell_recon_etc_hosts',
    points: 20,
    reason: 'reading /etc/hosts (network identity discovery)',
    match: (cmd) => /\/etc\/hosts\b/.test(cmd),
  },
  {
    id: 'shell_recon_ps_full',
    points: 20,
    reason: 'ps -ef / ps aux (process enumeration)',
    match: (_cmd, argv) => {
      if (argv[0] !== 'ps') return false
      return argv.some((t) => /^(-?aux|-ef|-aux|-A)$/.test(t))
    },
  },
  {
    id: 'shell_recon_netstat',
    points: 20,
    reason: 'netstat / ss (open port discovery)',
    match: (_cmd, argv) => argv[0] === 'netstat' || (argv[0] === 'ss' && argv.length > 1),
  },
]

// =============================================================================
// Safe-list — common benign commands that look superficially scary
// =============================================================================

interface SafePattern {
  id: string
  reason: string
  match: (cmd: string, argv: string[]) => boolean
}

const SAFE_LIST: SafePattern[] = [
  {
    id: 'shell_safe_tmp_rm',
    reason: 'rm under /tmp or /var/tmp is conventional cleanup',
    match: (_cmd, argv) => {
      if (argv[0] !== 'rm') return false
      return argv.some((t) => /^\/(?:tmp|var\/tmp)\//.test(t))
    },
  },
  {
    id: 'shell_safe_foreman',
    reason: 'foreman command (Foreman is the guardian itself)',
    match: (_cmd, argv) => argv[0] === 'foreman',
  },
  {
    id: 'shell_safe_npm_install',
    reason: 'npm/yarn install is conventional package work',
    match: (_cmd, argv) =>
      (argv[0] === 'npm' || argv[0] === 'yarn' || argv[0] === 'pnpm') &&
      (argv.includes('install') || argv.includes('i') || argv.includes('add')),
  },
  {
    id: 'shell_safe_git',
    reason: 'git command (version control, generally benign)',
    match: (_cmd, argv) => argv[0] === 'git',
  },
  {
    id: 'shell_safe_brew',
    reason: 'brew command (Homebrew package management)',
    match: (_cmd, argv) => argv[0] === 'brew',
  },
]

// =============================================================================
// Rule
// =============================================================================

const ALL_SHELL_RULES: readonly ShellPattern[] = [
  ...DESTRUCTIVE_OPS,
  ...PRIVESC,
  ...PERSISTENCE,
  ...REVERSE_SHELL,
  ...DEFENSE_EVASION,
  ...RECON,
]

export const shellPatternRule: RiskRule = {
  name: 'shell_command',
  category: 'shell',
  evaluate(req): RiskFactor[] {
    if (!isShellTool(req.targetTool)) return []
    const cmd = extractCommand(req.args)
    if (!cmd) return []

    const argv = tokenize(cmd)
    const factors: RiskFactor[] = []

    for (const rule of ALL_SHELL_RULES) {
      try {
        if (rule.match(cmd, argv)) {
          factors.push({
            rule: rule.id,
            category: 'shell',
            points: rule.points,
            reason: rule.reason,
            evidence: shortFingerprint(cmd),
          })
        }
      } catch {
        // Defensive: a single buggy pattern must not crash the mediator.
        continue
      }
    }

    if (factors.length > 0) {
      for (const safe of SAFE_LIST) {
        if (safe.match(cmd, argv)) {
          factors.push({
            rule: safe.id,
            category: 'shell',
            points: -10,
            reason: safe.reason,
          })
          break
        }
      }
    }

    return factors
  },
}

// Test-only export — counts so the suite can guard against silent truncation.
export const _SHELL_COUNTS = {
  destructive: DESTRUCTIVE_OPS.length,
  privesc: PRIVESC.length,
  persistence: PERSISTENCE.length,
  reverseShell: REVERSE_SHELL.length,
  defenseEvasion: DEFENSE_EVASION.length,
  recon: RECON.length,
  total: ALL_SHELL_RULES.length,
  safeList: SAFE_LIST.length,
}

// Allow tests / docs to introspect the curated rule set.
export const ALL_SHELL_RULE_IDS = Object.freeze(
  ALL_SHELL_RULES.map((r) => r.id),
)
