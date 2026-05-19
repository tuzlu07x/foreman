import { execFileSync, spawn } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { delimiter } from "node:path";
import { homedir } from "node:os";

export interface InstallSpec {
  npm: string | null;
  brew: string | null;
  /** URL of a script installer. String form is treated as unix-only
   *  (curl | bash). Object form (#369) lets registry entries declare
   *  per-platform URLs — wizard picks the matching one and invokes
   *  PowerShell for the windows URL. */
  script?: string | ScriptUrls | null;
  /** Override the binary name to look for on PATH when it differs from the npm package. */
  binary?: string | null;
  /** Args appended via `bash -s -- <args>` so script installers run without
   *  their interactive post-install wizards (#372). Hermes uses
   *  `["--skip-setup"]`. */
  non_interactive_args?: string[];
  /** Shell commands run after secret projection finishes (#398). OpenClaw
   *  uses this to run `openclaw gateway install` so its LaunchAgent gets
   *  registered without forcing the user to invoke the agent's own
   *  onboarding wizard. */
  post_config_commands?: string[];
}

export interface ScriptUrls {
  unix?: string;
  windows?: string;
}

// #369 — Resolve a `script` field to a single URL for the running
// platform. Legacy string form: unix-only; null on win32. Object form:
// pick the matching key (unix for darwin/linux, windows for win32).
// Exported so the wizard install log can detect "no installer for this
// platform" before showing the install hint.
export function resolveScriptUrl(
  script: string | ScriptUrls | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!script) return null;
  if (typeof script === "string") {
    return platform === "win32" ? null : script;
  }
  if (platform === "win32") return script.windows ?? null;
  return script.unix ?? null;
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

export interface PostConfigResult {
  command: string;
  ok: boolean;
  exitCode: number;
}

export interface LaunchAgentDisableSpec {
  /** launchd service label, e.g. "ai.hermes.gateway". */
  label: string;
  /** Path to the .plist file. `~/` is expanded against the user's home. */
  plist_path: string;
}

export interface LaunchAgentDisableResult {
  /** Non-macOS hosts skip entirely — no error. */
  platformSkipped: boolean;
  /** Did `launchctl bootout` complete (regardless of exit code — bootout
   *  returns non-zero when the service was never loaded, which is fine). */
  bootedOut: boolean;
  /** Was the plist renamed to `<plist>.foreman-disabled` so logout/reboot
   *  doesn't reload it. False when the plist is already renamed or never
   *  existed. */
  plistRenamed: boolean;
  /** Captured stderr lines + thrown errors for diagnostics. None of these
   *  abort the calling install flow. */
  errors: string[];
}

/**
 * Disable an agent's macOS LaunchAgent so it doesn't auto-respawn outside
 * Foreman's daemon manager (#394). Hermes' installer drops one that
 * keeps reclaiming the Telegram bot token across reboots, producing a
 * 5-hour zombie-respawn debugging session if left alone.
 *
 * Idempotent + best-effort: `launchctl bootout` is a no-op if the
 * service was never loaded; the rename is a no-op if the plist is
 * already renamed (or never existed). On non-macOS hosts the function
 * returns immediately with `platformSkipped: true`.
 */
export async function disableManagedLaunchAgent(
  spec: LaunchAgentDisableSpec,
  options: { home?: string } = {},
): Promise<LaunchAgentDisableResult> {
  const result: LaunchAgentDisableResult = {
    platformSkipped: false,
    bootedOut: false,
    plistRenamed: false,
    errors: [],
  };
  if (process.platform !== "darwin") {
    result.platformSkipped = true;
    return result;
  }
  const home = options.home ?? homedir();
  const plistPath = spec.plist_path.startsWith("~/")
    ? `${home}/${spec.plist_path.slice(2)}`
    : spec.plist_path;
  // 1) bootout. `launchctl unload` returns `Input/output error` on
  // Catalina+; `bootout gui/<uid>/<label>` is the documented modern
  // command. Non-zero exit means "service wasn't loaded" — we still
  // proceed to rename the plist.
  const uid = process.getuid?.() ?? 0;
  await new Promise<void>((resolveBoot) => {
    const child = spawn(
      "launchctl",
      ["bootout", `gui/${uid}/${spec.label}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk: Buffer) => {
      const txt = chunk.toString("utf8").trim();
      // "Boot-out failed: Could not find service" = already not loaded.
      // Worth recording but not surfacing as a user-visible error.
      if (txt.length > 0 && !/Could not find service/i.test(txt)) {
        result.errors.push(`launchctl: ${txt}`);
      }
    });
    child.on("close", () => {
      result.bootedOut = true;
      resolveBoot();
    });
    child.on("error", (err) => {
      result.errors.push(`launchctl bootout failed: ${err.message}`);
      resolveBoot();
    });
  });
  // 2) Rename plist so logout/reboot doesn't reload it. The
  // `.foreman-disabled` suffix is reversible by the user if they want
  // Hermes' standalone LaunchAgent back.
  try {
    if (existsSync(plistPath)) {
      const disabledPath = `${plistPath}.foreman-disabled`;
      renameSync(plistPath, disabledPath);
      result.plistRenamed = true;
    }
  } catch (err) {
    result.errors.push(
      `plist rename failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return result;
}

/**
 * Run the registry-declared `install.post_config_commands` in sequence
 * after secrets are projected to the agent's config (#398). OpenClaw
 * uses this for `openclaw gateway install` so its LaunchAgent gets
 * registered without forcing the user to invoke the agent's own
 * onboarding wizard separately. Best-effort: a non-zero exit on one
 * command is recorded in the result but doesn't abort subsequent ones —
 * the daemon-manager surfaces the real failure later if the gateway
 * still doesn't come up.
 */
export async function runPostConfigCommands(
  install: InstallSpec,
  onLine?: (line: string) => void,
): Promise<PostConfigResult[]> {
  const commands = install.post_config_commands ?? [];
  const results: PostConfigResult[] = [];
  for (const command of commands) {
    const r = await runShell(command, onLine);
    results.push({ command, ok: r.ok, exitCode: r.exitCode });
  }
  return results;
}

export async function runUninstall(
  options: RunUninstallOptions,
): Promise<InstallResult> {
  const command = preferredUninstallCommand(options.install, options.detection);
  if (!command) {
    const hasScript =
      typeof options.install.script === "string" ||
      (options.install.script !== null &&
        options.install.script !== undefined &&
        typeof options.install.script === "object");
    const manual = hasScript
      ? `(no automated uninstall — re-run the installer with its --uninstall flag, or remove the binary at ${options.install.binary ?? "<binary>"} manually)`
      : "(no uninstall command in registry entry)";
    return { ok: false, exitCode: -1, manualCommand: manual };
  }
  return runShell(command, options.onLine);
}

export function preferredInstallCommand(
  install: InstallSpec,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (install.npm) return `npm install -g ${install.npm}`;
  // Brew only runs on macOS — picking it on Linux would silently fail.
  if (install.brew && platform === "darwin") {
    return `brew install ${install.brew}`;
  }
  const scriptUrl = resolveScriptUrl(install.script, platform);
  if (scriptUrl) {
    if (platform === "win32") {
      // #369 — Windows installer: PowerShell `iex (irm <URL>)` per
      // Hermes' docs (strips BOMs, doesn't accept positional args).
      // Non-interactive args ignored on this path — the PowerShell
      // scriptblock-create form needed for arg-passing is too brittle
      // for unattended Foreman runs; rely on the script's own defaults.
      return `powershell -NoProfile -Command "iex (irm ${scriptUrl})"`;
    }
    // #372 — Append non-interactive args via `bash -s --` so script
    // installers (Hermes) skip their post-install wizards. Without this,
    // Hermes opens /dev/tty for its Y/n prompt and deadlocks against
    // Foreman's Ink TUI raw-mode capture.
    const args = (install.non_interactive_args ?? []).filter(
      (a) => a.length > 0,
    );
    const argsSuffix = args.length > 0 ? ` -s -- ${args.join(" ")}` : "";
    return `curl -fsSL ${scriptUrl} | bash${argsSuffix}`;
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

export function runShell(
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
