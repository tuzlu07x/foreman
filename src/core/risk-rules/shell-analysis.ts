import { parse as parseShell } from 'shell-quote'

// =============================================================================
// What a shell command line actually runs (#698)
// =============================================================================
//
// The shell rules used to score one flat argv of the whole line: `a && b`
// was ["a", "b"], so a matcher looking at argv[0] only ever saw `a`, and a
// command wrapped in `env`, `nice`, `xargs`, `bash -c "…"` or `eval` was
// never looked at as a command. This turns a line into the simple commands
// it runs, each with its wrappers removed, so every rule can look at each
// of them. It never runs anything and never throws.

export interface ShellSegment {
  /** The command's argv, wrappers and leading VAR=value assignments removed. */
  argv: string[]
  /** The argv as written (wrappers included), e.g. to tell `xargs rm` apart. */
  written: string[]
  /** Text to run regex rules on: the nested script for `bash -c "…"`, else the argv joined. */
  text: string
}

const MAX_DEPTH = 3
const MAX_SEGMENTS = 64

/** Operators that end one simple command and start the next. */
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '|&', ';;', '(', ')'])
/** Redirections: the operator and its target are not arguments. */
const REDIRECTIONS = new Set(['>', '>>', '<', '<<', '<<<', '>&', '<&', '>|', '&>', '&>>', '<>'])

/** Commands that run the rest of their arguments as a command. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nice',
  'nohup',
  'time',
  'timeout',
  'stdbuf',
  'ionice',
  'command',
  'builtin',
  'exec',
  'xargs',
  'caffeinate',
  'unbuffer',
])

/** Wrapper options that take a separate value (`sudo -u root`, `nice -n 5`). */
const OPTION_VALUES: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']),
  stdbuf: new Set(['-i', '-o', '-e']),
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export function commandName(token: string | undefined): string {
  if (token === undefined) return ''
  const slash = token.lastIndexOf('/')
  return slash >= 0 ? token.slice(slash + 1) : token
}

/** Split a line into simple commands (argv lists), keeping `$VARS` and globs as written. */
function splitSimpleCommands(line: string): string[][] {
  let entries: ReturnType<typeof parseShell>
  try {
    entries = parseShell(line, (key) => `$${key}`)
  } catch {
    return [line.split(/\s+/).filter((t) => t.length > 0)]
  }
  const commands: string[][] = []
  let current: string[] = []
  let skipNext = false
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (skipNext) {
        skipNext = false
        continue
      }
      current.push(entry)
      continue
    }
    if ('comment' in entry) continue
    if ('op' in entry) {
      if (entry.op === 'glob' && 'pattern' in entry) {
        current.push(String(entry.pattern))
        continue
      }
      if (REDIRECTIONS.has(entry.op)) {
        skipNext = true
        continue
      }
      if (SEPARATORS.has(entry.op)) {
        if (current.length > 0) commands.push(current)
        current = []
      }
    }
  }
  if (current.length > 0) commands.push(current)
  return commands
}

/** Remove leading `VAR=value` assignments and wrappers until the real command. */
export function unwrapCommand(argv: readonly string[]): string[] {
  let rest = [...argv]
  for (let guard = 0; guard < 12 && rest.length > 0; guard++) {
    let i = 0
    while (i < rest.length && ASSIGNMENT.test(rest[i]!)) i++
    if (i > 0) {
      rest = rest.slice(i)
      continue
    }
    const name = commandName(rest[0])
    if (!WRAPPERS.has(name)) break
    const takesValue = OPTION_VALUES[name] ?? new Set<string>()
    let j = 1
    while (j < rest.length && rest[j]!.startsWith('-')) {
      const opt = rest[j]!
      j++
      if (opt === '--') break
      if (takesValue.has(opt)) j++
    }
    if (name === 'env') while (j < rest.length && ASSIGNMENT.test(rest[j]!)) j++
    if (name === 'timeout' && j < rest.length && /^\d/.test(rest[j]!)) j++
    rest = rest.slice(j)
  }
  return rest
}

/** `bash -c "script"`, `sh -ec "script"`, `su -c "script"`, `eval …`: the script run. */
function nestedScript(argv: readonly string[]): string | null {
  const name = commandName(argv[0])
  if (name === 'eval') return argv.slice(1).join(' ') || null
  if (!SHELLS.has(name) && name !== 'su') return null
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok === '-c' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(tok)) return argv[i + 1] ?? null
    if (tok === '--command') return argv[i + 1] ?? null
  }
  return null
}

/** The command `find … -exec CMD … ;` / `-execdir` / `-ok` runs. */
function findExecCommands(argv: readonly string[]): string[][] {
  if (commandName(argv[0]) !== 'find') return []
  const out: string[][] = []
  for (let i = 1; i < argv.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i]!)) continue
    const cmd: string[] = []
    let j = i + 1
    for (; j < argv.length; j++) {
      const tok = argv[j]!
      if (tok === ';' || tok === '\\;' || tok === '+') break
      cmd.push(tok)
    }
    if (cmd.length > 0) out.push(cmd)
    i = j
  }
  return out
}

const INTERPRETER = /^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl|ruby|php[0-9.]*)$/

/** The code of an interpreter one-liner: `python -c CODE`, `node -e CODE`, `perl -e CODE`, `ruby -e CODE`, `php -r CODE`, `deno eval CODE`. */
export function interpreterCode(argv: readonly string[]): string | null {
  const name = commandName(argv[0])
  if (!INTERPRETER.test(name)) return null
  if (name === 'deno' && argv[1] === 'eval') return argv[2] ?? null
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!
    const isCodeFlag =
      (name.startsWith('python') || name.startsWith('pypy')) ? tok === '-c' || /^-[a-zA-Z]*c$/.test(tok)
      : name === 'node' || name === 'nodejs' || name === 'bun' ? ['-e', '--eval', '-p', '--print'].includes(tok)
      : name === 'perl' ? /^-[a-zA-Z]*[eE]$/.test(tok)
      : name === 'ruby' ? /^-[a-zA-Z]*e$/.test(tok)
      : name.startsWith('php') ? tok === '-r'
      : false
    if (isCodeFlag) return argv[i + 1] ?? null
  }
  return null
}

/** Quoted strings inside interpreter code: what `os.system("…")`, `execSync('…')` or `subprocess.run([…])` would run. */
function stringLiterals(code: string): string[] {
  const out: string[] = []
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null && out.length < 32) {
    const s = m[1] ?? m[2] ?? m[3] ?? ''
    if (s.trim().length > 0) out.push(s)
  }
  return out
}

/**
 * Every simple command a line runs, recursively through `bash -c`, `eval`,
 * `find -exec` and the strings an interpreter one-liner could shell out
 * with. Bounded in depth and count; never throws.
 */
export function analyzeShell(line: string, depth = 0): ShellSegment[] {
  const segments: ShellSegment[] = []
  const add = (written: string[], text: string, level: number): void => {
    if (segments.length >= MAX_SEGMENTS || written.length === 0) return
    const argv = unwrapCommand(written)
    if (argv.length === 0) return
    segments.push({ argv, written, text })
    if (level >= MAX_DEPTH) return
    const script = nestedScript(argv)
    if (script) for (const s of analyzeShell(script, level + 1)) segments.push(s)
    for (const exec of findExecCommands(argv)) add(exec, exec.join(' '), level + 1)
    const code = interpreterCode(argv)
    if (code) {
      const literals = stringLiterals(code)
      for (const lit of literals) for (const s of analyzeShell(lit, level + 1)) segments.push(s)
      // `subprocess.run(["rm", "-rf", "build"])`: the literals as one command.
      if (literals.length > 1) for (const s of analyzeShell(literals.join(' '), level + 1)) segments.push(s)
    }
  }
  try {
    for (const rawLine of line.split(/\r?\n/)) {
      for (const cmd of splitSimpleCommands(rawLine)) add(cmd, cmd.join(' '), depth)
    }
  } catch {
    // A command we can't take apart is still scored as one flat line.
  }
  return segments.slice(0, MAX_SEGMENTS)
}

/** `rm` deleting recursively, however the flags are written: `-r`, `-R`, `-rf`, `-r -f`, `--recursive`, flags after operands. */
export function isRecursiveRm(argv: readonly string[]): boolean {
  if (commandName(argv[0]) !== 'rm') return false
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!
    if (tok === '--') break
    if (tok === '--recursive') return true
    if (/^-[a-zA-Z]+$/.test(tok) && /[rR]/.test(tok)) return true
  }
  return false
}

/** Filesystem deletes in interpreter code (Python, Node, Deno, Perl, Ruby, PHP). */
const SCRIPT_DELETE = [
  /\bshutil\s*\.\s*rmtree\b/,
  /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/,
  /\.\s*(?:rm|unlink|rmdir)\s*\(/,
  /\b(?:rmSync|rmdirSync|unlinkSync)\b/,
  /\bfs(?:\s*\.\s*promises)?\s*\.\s*(?:rm|rmdir|unlink)\s*\(/,
  /\brimraf\b/,
  /\bFileUtils\s*\.\s*(?:rm_rf|rm_r|rm|remove_dir|remove_entry|remove_entry_secure)\b/,
  /\bFile\s*\.\s*(?:delete|unlink)\b/,
  /\bDir\s*\.\s*(?:delete|rmdir|unlink)\b/,
  /\b(?:rmtree|remove_tree)\s*\(/,
  /\bunlink\s*\(/,
  /\bunlink\s+[\w$@'"]/,
  /\bDeno\s*\.\s*remove\b/,
]

export function scriptDeletes(argv: readonly string[]): boolean {
  const code = interpreterCode(argv)
  return code !== null && SCRIPT_DELETE.some((re) => re.test(code))
}

const DELETE_COMMANDS = new Set(['rm', 'unlink', 'shred', 'rmdir'])

/** `find -delete`, `find -exec rm …`, `… | xargs rm`: delete every match. */
export function isBulkDelete(segment: ShellSegment): boolean {
  const { argv, written } = segment
  if (commandName(argv[0]) === 'find') {
    if (argv.includes('-delete')) return true
    return findExecCommands(argv).some((cmd) => DELETE_COMMANDS.has(commandName(unwrapCommand(cmd)[0])))
  }
  return written.some((t) => commandName(t) === 'xargs') && DELETE_COMMANDS.has(commandName(argv[0]))
}

// --- git ----------------------------------------------------------------------

/** `git [global options] <subcommand> …` → the subcommand and its arguments. */
function gitSubcommand(argv: readonly string[]): { sub: string; args: string[] } | null {
  if (commandName(argv[0]) !== 'git') return null
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const opt = argv[i]!
    i++
    if (opt === '-C' || opt === '-c') i++
  }
  const sub = argv[i]
  return sub === undefined ? null : { sub, args: argv.slice(i + 1) }
}

const shortCluster = (tok: string, letter: string): boolean => /^-[a-zA-Z]+$/.test(tok) && tok.includes(letter)

export function gitForcePush(argv: readonly string[]): boolean {
  const git = gitSubcommand(argv)
  if (!git || git.sub !== 'push') return false
  return git.args.some(
    (t) =>
      t === '--force' ||
      t.startsWith('--force-with-lease') ||
      t === '--force-if-includes' ||
      t === '--mirror' ||
      shortCluster(t, 'f') ||
      (!t.startsWith('-') && t.startsWith('+')),
  )
}

export function gitPushDelete(argv: readonly string[]): boolean {
  const git = gitSubcommand(argv)
  if (!git || git.sub !== 'push') return false
  return git.args.some((t) => t === '--delete' || shortCluster(t, 'd') || (!t.startsWith('-') && t.startsWith(':')))
}

export function gitResetHard(argv: readonly string[]): boolean {
  const git = gitSubcommand(argv)
  return git !== null && git.sub === 'reset' && git.args.includes('--hard')
}

export function gitCleanForce(argv: readonly string[]): boolean {
  const git = gitSubcommand(argv)
  return git !== null && git.sub === 'clean' && git.args.some((t) => t === '--force' || shortCluster(t, 'f'))
}

export function gitHistoryRewrite(argv: readonly string[]): boolean {
  const git = gitSubcommand(argv)
  return git !== null && (git.sub === 'filter-branch' || git.sub === 'filter-repo')
}
