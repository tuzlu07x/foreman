import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realDir } from "./token-file-safety.js";

// =============================================================================
// foreman service — the daemon in the background, at login
// =============================================================================
//
// Without it the daemon only runs while `foreman start` or `foreman daemon`
// runs in a terminal. `foreman service install` hands `foreman daemon
// --service` to the user's own service manager:
//
//   - macOS: a LaunchAgent (~/Library/LaunchAgents/dev.foreman.daemon.plist)
//     in the gui/<uid> domain, restarted when it crashes, logging to
//     <state dir>/daemon.log;
//   - Linux / WSL2: a systemd user unit
//     (~/.config/systemd/user/foreman-daemon.service), logging to the journal.
//
// The service runs this very node binary and CLI script by absolute path,
// never a PATH lookup. Its files are the user's own (0644, in the user's own
// directories): never through a symlink, never outside the home directory.
// Nothing about the daemon's socket or token changes.

export const SERVICE_LABEL = "dev.foreman.daemon";
export const SYSTEMD_UNIT = "foreman-daemon.service";
export const SERVICE_LOG_FILE = "daemon.log";
export const SERVICE_FILE_MODE = 0o644;
const MARKER = "Written by `foreman service install`; remove it with `foreman service uninstall`.";

export type ServiceManager = "launchd" | "systemd";

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

/** The service manager `foreman service` uses on this platform, or null. */
export function serviceManagerFor(platform: NodeJS.Platform = process.platform): ServiceManager | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/** Where the service definition lives, for `home`. */
export function serviceFilePath(manager: ServiceManager, home: string): string {
  return manager === "launchd"
    ? join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
    : join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

export interface ServiceSpec {
  /** Absolute argv: node, the CLI script, `daemon`, `--service`. */
  program: string[];
  /** Variables the daemon needs to find the same Foreman home and tools. */
  env: Array<[string, string]>;
  /** The daemon's working directory (the home directory). */
  workingDirectory: string;
  /** launchd only: stdout and stderr (systemd logs to the journal). */
  logPath: string | null;
}

/** How to run this CLI again as `foreman daemon --service`: this node
 *  binary and the script it is running, both resolved (an npm install runs
 *  us through a `foreman` symlink). A single-file build is the `foreman`
 *  binary itself. */
export function serviceProgram(proc: { execPath: string; argv1: string | undefined }): string[] {
  const exec = realpathSync(proc.execPath);
  if (/^foreman$/i.test(basename(exec))) return [exec, "daemon", "--service"];
  if (!proc.argv1) throw new ServiceError("can't tell which Foreman CLI script is running");
  return [exec, realpathSync(resolve(proc.argv1)), "daemon", "--service"];
}

/** Variables that decide which Foreman home the daemon uses, plus PATH (the
 *  stdio MCP servers it starts are found on it). Only absolute PATH entries
 *  are kept. Nothing secret: proxy settings, which can carry credentials,
 *  are left out. */
export function serviceEnvironment(env: NodeJS.ProcessEnv, manager: ServiceManager): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const path = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && isAbsolute(dir))
    .filter((dir, i, all) => all.indexOf(dir) === i)
    .join(delimiter);
  if (path) out.push(["PATH", path]);
  const names = manager === "systemd" ? ["FOREMAN_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] : ["FOREMAN_HOME"];
  for (const name of names) {
    const value = env[name];
    if (value) out.push([name, resolve(value)]);
  }
  return out;
}

// A newline (or any control character) in a value would end the line or
// element it is in and could add directives of its own.
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkSpec(spec: ServiceSpec): void {
  const values = [...spec.program, spec.workingDirectory, ...(spec.logPath ? [spec.logPath] : [])];
  for (const [name, value] of spec.env) {
    if (!ENV_NAME.test(name)) throw new ServiceError(`invalid environment variable name: ${JSON.stringify(name)}`);
    values.push(value);
  }
  for (const value of values) {
    if (CONTROL.test(value)) throw new ServiceError(`refusing a value with a control character: ${JSON.stringify(value)}`);
  }
  const [first] = spec.program;
  if (!first || !isAbsolute(first)) throw new ServiceError("the service must run an absolute path");
  if (!isAbsolute(spec.workingDirectory)) throw new ServiceError("the working directory must be absolute");
  if (spec.logPath !== null && !isAbsolute(spec.logPath)) throw new ServiceError("the log path must be absolute");
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unxml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  checkSpec(spec);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${MARKER} -->`,
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${SERVICE_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.program.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...spec.env.flatMap(([name, value]) => [`    <key>${name}</key>`, `    <string>${xml(value)}</string>`]),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(spec.workingDirectory)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // Restarted when it crashes; `foreman daemon --service` exits 0 when it
    // can't start for a reason a restart won't fix.
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
  ];
  if (spec.logPath) {
    lines.push(
      "  <key>StandardOutPath</key>",
      `  <string>${xml(spec.logPath)}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${xml(spec.logPath)}</string>`,
    );
  }
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

/** One systemd word, double-quoted: `\` and `"` escaped, `%` (a specifier)
 *  doubled and, in ExecStart (which expands variables), `$` doubled too. */
function systemdQuote(value: string, execLine: boolean): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${execLine ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  checkSpec(spec);
  return [
    `# ${MARKER}`,
    "[Unit]",
    "Description=Foreman daemon (agents' MCP hub and PreToolUse hook)",
    "Documentation=https://github.com/tuzlu07x/foreman/blob/main/docs/mcp-hub.md#one-daemon-for-every-agent",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.program.map((arg) => systemdQuote(arg, true)).join(" ")}`,
    ...spec.env.map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`, false)}`),
    // The home directory (systemd's own specifier for it).
    "WorkingDirectory=%h",
    // Restarted when it crashes; `foreman daemon --service` exits 0 when it
    // can't start for a reason a restart won't fix.
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Split what systemdQuote wrote back into words. */
function systemdWords(line: string, execLine: boolean): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      i++;
      continue;
    }
    if (line[i] !== '"') return words;
    let word = "";
    i++;
    while (i < line.length && line[i] !== '"') {
      const c = line[i]!;
      const next = line[i + 1];
      if (c === "\\" && next !== undefined) {
        word += next;
        i += 2;
      } else if ((c === "%" && next === "%") || (execLine && c === "$" && next === "$")) {
        word += c;
        i += 2;
      } else {
        word += c;
        i++;
      }
    }
    i++;
    words.push(word);
  }
  return words;
}

export interface InstalledService {
  program: string[];
  env: Record<string, string>;
  logPath: string | null;
}

/** What an installed service file runs, read back from the file Foreman
 *  wrote (null when it doesn't look like one). */
export function parseServiceFile(manager: ServiceManager, text: string): InstalledService | null {
  if (manager === "launchd") {
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
    if (!args) return null;
    const program = [...args[1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]!));
    const env: Record<string, string> = {};
    const envDict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
    if (envDict) {
      for (const m of envDict[1]!.matchAll(/<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) env[m[1]!] = unxml(m[2]!);
    }
    const log = /<key>StandardErrorPath<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
    return { program, env, logPath: log ? unxml(log[1]!) : null };
  }
  let program: string[] | null = null;
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("ExecStart=")) program = systemdWords(line.slice("ExecStart=".length), true);
    if (line.startsWith("Environment=")) {
      const [pair] = systemdWords(line.slice("Environment=".length), false);
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return program ? { program, env, logPath: null } : null;
}

/** Is `path` inside `dir` (or `dir` itself)? */
function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The service file's directory, created if missing, when it is safe to
 *  write in: really inside the home directory (through any symlinked
 *  parent), a directory owned by you that others can't write to. */
function prepareServiceDir(file: string, home: string): string {
  const dir = dirname(file);
  const realHome = realDir(home);
  if (!inside(resolve(home), resolve(dir)) || !inside(realHome, realDir(dir))) {
    throw new ServiceError(`${dir} is outside your home directory ${home}; Foreman won't write there`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = lstatSync(realpathSync(dir));
  const uid = process.getuid?.();
  if (!st.isDirectory()) throw new ServiceError(`${dir} is not a directory`);
  if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0) {
    throw new ServiceError(`${dir} is writable by other users (or not yours); fix its permissions first`);
  }
  return dir;
}

/** Refuse what isn't a regular file of ours at the service file's path. */
function checkTarget(file: string): boolean {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) throw new ServiceError(`${file} is a symlink; Foreman won't write through one. Remove it first.`);
  if (!st.isFile()) throw new ServiceError(`${file} is not a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new ServiceError(`${file} belongs to another user`);
  return true;
}

/** Write the service file: a new 0644 file next to it, renamed over it, so
 *  nothing is written through a symlink and a half-written file is never
 *  loaded. Returns whether a file was replaced. */
export function writeServiceFile(file: string, content: string, home: string): boolean {
  const dir = prepareServiceDir(file, home);
  const existed = checkTarget(file);
  const tmp = join(dir, `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    SERVICE_FILE_MODE,
  );
  try {
    fchmodSync(fd, SERVICE_FILE_MODE);
    writeFileSync(fd, content, "utf-8");
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  try {
    checkTarget(file);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  return existed;
}

/** Remove the service file. False when there was none. */
export function removeServiceFile(file: string): boolean {
  if (!checkTarget(file)) return false;
  unlinkSync(file);
  return true;
}

/** The installed service file, or null. A symlink there counts as installed
 *  (it would be loaded), so doctor and status still mention it. */
export function installedServiceFile(manager: ServiceManager, home: string): string | null {
  const file = serviceFilePath(manager, home);
  try {
    lstatSync(file);
    return file;
  } catch {
    return null;
  }
}

/** Create the log file owner-only before launchd opens it (launchd would
 *  create it with its own umask). Never through a symlink. */
export function prepareLogFile(path: string): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new ServiceError(`${path} is a symlink; remove it first`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile()) throw new ServiceError(`${path} is not a regular file`);
    if (uid !== undefined && st.uid !== uid) throw new ServiceError(`${path} belongs to another user`);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Talking to launchctl / systemctl
// ---------------------------------------------------------------------------

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The command couldn't be run at all (ENOENT: not installed). */
  missing: boolean;
}

export type Runner = (command: string, args: string[]) => RunResult;

export function systemRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  return (command, args) => {
    const r = spawnSync(command, args, { env, encoding: "utf-8", timeout: 30_000 });
    const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? (r.error ? r.error.message : ""),
      missing,
    };
  };
}

export interface ServiceContext {
  manager: ServiceManager;
  home: string;
  /** Foreman's state directory (the launchd log goes there). */
  stateDir: string;
  uid: number;
  run: Runner;
}

export interface InstallResult {
  file: string;
  replaced: boolean;
  program: string[];
  logPath: string | null;
  /** How it was loaded (e.g. `launchctl bootstrap`). */
  loadedWith: string;
}

function output(r: RunResult): string {
  return (r.stderr.trim() || r.stdout.trim()).split("\n").slice(0, 5).join("; ");
}

/** systemd --user must answer before anything is written. */
function requireSystemdUser(run: Runner): void {
  const r = run("systemctl", ["--user", "show-environment"]);
  if (r.missing || r.status !== 0) {
    throw new ServiceError(
      `systemd --user isn't available here${r.missing ? " (no systemctl)" : r.stderr.trim() ? ` (${output(r)})` : ""}. ` +
        "This is common under WSL without systemd. Run `foreman daemon` yourself instead (in a terminal, tmux, or your shell's startup), " +
        "or turn systemd on (WSL: `[boot] systemd=true` in /etc/wsl.conf, then `wsl --shutdown`) and run `foreman service install` again.",
    );
  }
}

const BOOTSTRAP_RETRIES = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function installService(ctx: ServiceContext, program: string[], env: Array<[string, string]>): InstallResult {
  const file = serviceFilePath(ctx.manager, ctx.home);
  // The binary, and the CLI script unless it is a single-file build.
  const files = program[1] === "daemon" ? program.slice(0, 1) : program.slice(0, 2);
  for (const path of files) {
    if (!existsSync(path)) throw new ServiceError(`${path} doesn't exist`);
  }
  if (ctx.manager === "systemd") {
    requireSystemdUser(ctx.run);
    const content = renderSystemdUnit({ program, env, workingDirectory: ctx.home, logPath: null });
    const replaced = writeServiceFile(file, content, ctx.home);
    const steps: string[][] = [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", SYSTEMD_UNIT],
      // A reinstall: the running daemon picks up the new unit.
      ...(replaced ? [["--user", "restart", SYSTEMD_UNIT]] : []),
    ];
    for (const args of steps) {
      const r = ctx.run("systemctl", args);
      if (r.status !== 0) {
        throw new ServiceError(`systemctl ${args.join(" ")} failed: ${output(r)}. ${file} was written; \`foreman service uninstall\` removes it.`);
      }
    }
    return { file, replaced, program, logPath: null, loadedWith: "systemctl --user enable --now" };
  }

  const logPath = join(ctx.stateDir, SERVICE_LOG_FILE);
  prepareLogFile(logPath);
  const content = renderLaunchdPlist({ program, env, workingDirectory: ctx.home, logPath });
  const replaced = writeServiceFile(file, content, ctx.home);
  const domain = `gui/${ctx.uid}`;
  // Unload what an earlier install left running (nothing to do otherwise),
  // so the new definition is the one that runs.
  const out = ctx.run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]);
  let boot = ctx.run("launchctl", ["bootstrap", domain, file]);
  // A service that was just booted out can take a moment to be gone
  // ("Bootstrap failed: 5: Input/output error" until then).
  for (let i = 0; boot.status !== 0 && out.status === 0 && i < BOOTSTRAP_RETRIES; i++) {
    sleepSync(300);
    boot = ctx.run("launchctl", ["bootstrap", domain, file]);
  }
  if (boot.status === 0) return { file, replaced, program, logPath, loadedWith: "launchctl bootstrap" };
  const load = ctx.run("launchctl", ["load", "-w", file]);
  if (load.status === 0) return { file, replaced, program, logPath, loadedWith: "launchctl load -w" };
  throw new ServiceError(
    `launchctl couldn't load ${file}: ${output(boot) || output(load)}. The file was written; \`foreman service uninstall\` removes it.`,
  );
}

export interface UninstallResult {
  file: string;
  removed: boolean;
  /** Stopping it failed or couldn't be checked (the file still goes). */
  warning: string | null;
}

export function uninstallService(ctx: ServiceContext): UninstallResult {
  const file = serviceFilePath(ctx.manager, ctx.home);
  if (!installedServiceFile(ctx.manager, ctx.home)) return { file, removed: false, warning: null };
  // Checked before anything is stopped: a symlink there is not ours to remove.
  checkTarget(file);
  let warning: string | null = null;
  if (ctx.manager === "systemd") {
    const stop = ctx.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    if (stop.status !== 0) warning = `systemctl --user disable --now ${SYSTEMD_UNIT} failed: ${output(stop)}`;
    removeServiceFile(file);
    ctx.run("systemctl", ["--user", "daemon-reload"]);
  } else {
    const out = ctx.run("launchctl", ["bootout", `gui/${ctx.uid}/${SERVICE_LABEL}`]);
    if (out.status !== 0) {
      // Not loaded at all, or an older macOS: unload by file.
      const unload = ctx.run("launchctl", ["unload", "-w", file]);
      if (unload.status !== 0 && serviceRunning(ctx).running) {
        warning = `launchctl couldn't stop ${SERVICE_LABEL}: ${output(out) || output(unload)}`;
      }
    }
    removeServiceFile(file);
  }
  return { file, removed: true, warning };
}

export interface RunningState {
  running: boolean;
  pid: number | null;
  detail: string;
}

export function serviceRunning(ctx: ServiceContext): RunningState {
  if (ctx.manager === "launchd") {
    const r = ctx.run("launchctl", ["print", `gui/${ctx.uid}/${SERVICE_LABEL}`]);
    if (r.missing) return { running: false, pid: null, detail: "launchctl not found" };
    if (r.status !== 0) return { running: false, pid: null, detail: "not loaded" };
    const state = /^\s*state = (.+)$/m.exec(r.stdout)?.[1]?.trim() ?? "unknown";
    const pid = /^\s*pid = (\d+)$/m.exec(r.stdout)?.[1];
    const lastExit = /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim();
    return {
      running: state === "running",
      pid: pid ? Number(pid) : null,
      detail: state === "running" ? "running" : `loaded, ${state}${lastExit ? ` (last exit: ${lastExit})` : ""}`,
    };
  }
  const r = ctx.run("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=ActiveState,SubState,MainPID"]);
  if (r.missing) return { running: false, pid: null, detail: "systemctl not found" };
  if (r.status !== 0) return { running: false, pid: null, detail: `systemd --user isn't available (${output(r)})` };
  const prop = (name: string): string | undefined => new RegExp(`^${name}=(.*)$`, "m").exec(r.stdout)?.[1]?.trim();
  const active = prop("ActiveState") ?? "unknown";
  const sub = prop("SubState");
  const pid = Number(prop("MainPID") ?? "0");
  return {
    running: active === "active",
    pid: pid > 0 ? pid : null,
    detail: active === "active" ? "running" : `${active}${sub ? ` (${sub})` : ""}`,
  };
}

/** Read back the installed file (null when missing or not readable). */
export function readInstalledService(manager: ServiceManager, home: string): InstalledService | null {
  const file = installedServiceFile(manager, home);
  if (!file) return null;
  try {
    return parseServiceFile(manager, readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}
