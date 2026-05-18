import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { homedir } from "node:os";

export interface InstallSpec {
  npm: string | null;
  brew: string | null;
  /** URL of a `curl | bash` style installer (Hermes, OpenClaw). */
  script?: string | null;
  /** Override the binary name to look for on PATH when it differs from the npm package. */
  binary?: string | null;
  /** Args appended via `bash -s -- <args>` so script installers run without
   *  their interactive post-install wizards (#372). Hermes uses
   *  `["--skip-setup"]`. */
  non_interactive_args?: string[];
}

export interface InstallDetection {
  found: boolean;
  path?: string;
  /** Where the binary came from. `brew-managed` (#357) is a refinement of
   *  `PATH` when the path lives in a brew prefix — uninstall has to go
   *  through `brew uninstall` even if registry says `brew: null`. */
  source?: "PATH" | "npm-global" | "user-dirs" | "brew-managed";
  /** Formula name to feed `brew uninstall` when source=brew-managed.
   *  Defaults to the binary basename. */
  formula?: string;
}

// Brew puts its binaries in well-known prefixes. We treat these as
// unambiguously brew-managed; `/usr/local/bin` is intentionally NOT here
// because it's shared with npm-global + user `make install`, so a path
// match there would falsely upgrade non-brew installs to `brew-managed`.
const BREW_BIN_PREFIXES = [
  "/opt/homebrew/bin/", // macOS Apple Silicon
  "/home/linuxbrew/.linuxbrew/bin/", // Linux brew
];

export function isBrewManagedPath(binPath: string): boolean {
  return BREW_BIN_PREFIXES.some((prefix) => binPath.startsWith(prefix));
}

// Synchronously detects whether the agent is already on the system. We deliberately
// keep this dependency-free: just walk PATH for the binary name (npm package basename),
// then fall back to checking npm's global prefix.
export function detectInstall(
  install: InstallSpec,
  env: NodeJS.ProcessEnv = process.env,
): InstallDetection {
  const binCandidates = candidateBinaries(install);
  if (binCandidates.length === 0) return { found: false };

  for (const bin of binCandidates) {
    const onPath = whichOnPath(bin, env);
    if (onPath) {
      // #357 — refine PATH detection: if the binary lives in a brew prefix,
      // record it as brew-managed so uninstall picks `brew uninstall` even
      // when the registry entry doesn't declare a brew formula. The formula
      // defaults to the binary basename (matches in 99% of cases — OpenClaw,
      // ZeroClaw, etc).
      if (isBrewManagedPath(onPath)) {
        return {
          found: true,
          path: onPath,
          source: "brew-managed",
          formula: bin,
        };
      }
      return { found: true, path: onPath, source: "PATH" };
    }
  }

  if (install.npm) {
    const npmPrefix = readNpmPrefix();
    if (npmPrefix) {
      for (const bin of binCandidates) {
        const candidate = `${npmPrefix}/bin/${bin}`;
        if (existsSync(candidate)) {
          return { found: true, path: candidate, source: "npm-global" };
        }
      }
    }
  }

  // Script installers (Hermes, ZeroClaw) and many curl|bash flows drop the
  // binary under ~/.local/bin, ~/bin, or ~/.cargo/bin — directories users
  // routinely have on disk but not necessarily on PATH. Without this fallback
  // a returning user gets re-installed (and re-installs that hit interactive
  // wizards block the whole setup — see #209).
  const home = env.HOME ?? homedir();
  const userDirs = [
    `${home}/.local/bin`,
    `${home}/bin`,
    `${home}/.cargo/bin`,
  ];
  for (const bin of binCandidates) {
    for (const dir of userDirs) {
      const candidate = `${dir}/${bin}`;
      if (existsSync(candidate)) {
        return { found: true, path: candidate, source: "user-dirs" };
      }
    }
  }

  return { found: false };
}

export interface InstallResult {
  ok: boolean;
  exitCode: number;
  manualCommand: string;
}

export interface RunInstallOptions {
  install: InstallSpec;
  onLine?: (line: string) => void;
}

export async function runInstall(
  options: RunInstallOptions,
): Promise<InstallResult> {
  const command = preferredInstallCommand(options.install);
  if (!command) {
    return {
      ok: false,
      exitCode: -1,
      manualCommand: "(no install command in registry entry)",
    };
  }
  return runShell(command, options.onLine);
}

export interface RunUninstallOptions extends RunInstallOptions {
  /** Optional detection result — when present, uninstall command tracks
   *  the actually-installed source instead of the registry's declared one
   *  (#357). E.g. if the registry says `brew: null` but the binary is at
   *  `/opt/homebrew/bin/openclaw`, we still pick `brew uninstall`. */
  detection?: InstallDetection;
}

export async function runUninstall(
  options: RunUninstallOptions,
): Promise<InstallResult> {
  const command = preferredUninstallCommand(options.install, options.detection);
  if (!command) {
    const manual = options.install.script
      ? `(no automated uninstall — re-run the installer with its --uninstall flag, or remove the binary at ${options.install.binary ?? "<binary>"} manually)`
      : "(no uninstall command in registry entry)";
    return { ok: false, exitCode: -1, manualCommand: manual };
  }
  return runShell(command, options.onLine);
}

export function preferredInstallCommand(install: InstallSpec): string | null {
  if (install.npm) return `npm install -g ${install.npm}`;
  if (install.brew) return `brew install ${install.brew}`;
  if (install.script) {
    // #372 — Append non-interactive args via `bash -s --` so script
    // installers (Hermes) skip their post-install wizards. Without this,
    // Hermes opens /dev/tty for its Y/n prompt and deadlocks against
    // Foreman's Ink TUI raw-mode capture.
    const args = (install.non_interactive_args ?? []).filter(
      (a) => a.length > 0,
    );
    const argsSuffix = args.length > 0 ? ` -s -- ${args.join(" ")}` : "";
    return `curl -fsSL ${install.script} | bash${argsSuffix}`;
  }
  return null;
}

export function preferredUninstallCommand(
  install: InstallSpec,
  detection?: InstallDetection,
): string | null {
  // #357 — Detection wins over registry hints when present. The user's
  // actually-installed binary might not match what the registry declared
  // (OpenClaw is `brew: null` in registry but brew-installed on the user's
  // box). Picking by detection avoids silent no-op uninstalls.
  if (detection?.source === "brew-managed") {
    return `brew uninstall ${detection.formula ?? install.binary ?? ""}`.trim();
  }
  if (detection?.source === "npm-global" && install.npm) {
    return `npm uninstall -g ${install.npm}`;
  }
  // No detection (or non-actionable source like user-dirs / plain PATH) →
  // fall back to whatever the registry declared.
  if (install.npm) return `npm uninstall -g ${install.npm}`;
  if (install.brew) return `brew uninstall ${install.brew}`;
  return null;
}

/** Idle-output watchdog for install subprocesses. If no stdout/stderr
 *  arrives for this long, the install is assumed stuck on an interactive
 *  prompt our \`stdio: ["ignore", ...]\` couldn't suppress (#372 defence in
 *  depth — script-installer authors might add new prompts we don't know
 *  about). 90s is generous enough for slow network pulls (uv resolve, npm
 *  pack download) but short enough that the user doesn't sit on a frozen
 *  TUI for ten minutes. */
const INSTALL_IDLE_TIMEOUT_MS = 90_000;
const INSTALL_WATCHDOG_TICK_MS = 5_000;

function runShell(
  command: string,
  onLine?: (line: string) => void,
): Promise<InstallResult> {
  return new Promise<InstallResult>((resolveResult) => {
    // Pipes (`curl … | bash`) need a real shell to interpret them.
    const needsShell = command.includes("|");
    const child = needsShell
      ? spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] })
      : (() => {
          const [cmd, ...args] = command.split(" ");
          return spawn(cmd!, args, { stdio: ["ignore", "pipe", "pipe"] });
        })();
    let lastOutputAt = Date.now();
    let killedForIdle = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt > INSTALL_IDLE_TIMEOUT_MS) {
        killedForIdle = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        clearInterval(watchdog);
      }
    }, INSTALL_WATCHDOG_TICK_MS);
    const onChunk = (chunk: Buffer): void => {
      lastOutputAt = Date.now();
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) onLine?.(line);
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", () => {
      clearInterval(watchdog);
      resolveResult({ ok: false, exitCode: -1, manualCommand: command });
    });
    child.on("close", (code) => {
      clearInterval(watchdog);
      if (killedForIdle) {
        resolveResult({
          ok: false,
          exitCode: -1,
          manualCommand:
            `(install timed out — no output for ${Math.round(
              INSTALL_IDLE_TIMEOUT_MS / 1000,
            )}s, likely stuck on an interactive prompt. Run manually: ${command})`,
        });
        return;
      }
      resolveResult({
        ok: code === 0,
        exitCode: code ?? -1,
        manualCommand: command,
      });
    });
  });
}

function candidateBinaries(install: InstallSpec): string[] {
  const out: string[] = [];
  if (install.binary) out.push(install.binary);
  if (install.npm) out.push(binaryFromNpmPackage(install.npm));
  if (install.brew) out.push(binaryFromBrewFormula(install.brew));
  return Array.from(new Set(out));
}

function binaryFromNpmPackage(pkg: string): string {
  const withoutScope = pkg.startsWith("@") ? (pkg.split("/")[1] ?? pkg) : pkg;
  return withoutScope;
}

function binaryFromBrewFormula(formula: string): string {
  const parts = formula.split("/");
  return parts[parts.length - 1] ?? formula;
}

function whichOnPath(bin: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = `${dir}/${bin}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readNpmPrefix(): string | null {
  try {
    return execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}
