import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AGENT_TOKEN_ENV, AGENT_TOKEN_FILE_ENV } from "./agent-identity.js";
import type { AgentEntry, RegistryDoc } from "./registry-catalog.js";
import type { RegisteredAgent } from "./registry.js";

// =============================================================================
// Several roles on one agent runtime ("instances")
// =============================================================================
//
// `foreman agent add backend --type codex` registers a second Codex under
// its own name. Foreman runs it as itself when it hands it work:
//   - the program comes from its type (metadata.registryId), not its name;
//   - it talks to Foreman as `backend`, not as whichever id Codex's own
//     config is wired to: each launch gets its own Foreman MCP server
//     (Codex: `-c mcp_servers.foreman.*`, Claude Code: `--mcp-config`),
//     with the instance's identity token in an owner-only file (never in
//     argv);
//   - it is told its role (org.yaml title and responsibility).
// An agent whose id is its catalog id (plain `codex`) is launched as before.

/** The catalog id an agent runs as: its own id when that is a catalog
 *  agent (`codex`, even if registered `--type generic-mcp`), else its
 *  registered type (`backend --type codex` → codex). */
export function catalogIdFor(
  agentId: string,
  registered: Pick<RegisteredAgent, "metadata"> | null,
  known: (id: string) => boolean = () => false,
): string {
  if (known(agentId)) return agentId;
  const type = registered?.metadata?.registryId;
  return typeof type === "string" && type.length > 0 ? type : agentId;
}

/** The catalog entry `agentId` runs as (see catalogIdFor), or undefined. */
export function catalogEntryFor(
  doc: Pick<RegistryDoc, "agents">,
  agentId: string,
  registered: Pick<RegisteredAgent, "metadata"> | null,
): AgentEntry | undefined {
  const id = catalogIdFor(agentId, registered, (x) => doc.agents.some((a) => a.id === x));
  return doc.agents.find((a) => a.id === id);
}

/** Whether `agentId` runs as another agent's entry: an instance of it. */
export function isInstance(agentId: string, entry: Pick<AgentEntry, "id">): boolean {
  return agentId !== entry.id;
}

/** What a launch of an instance adds: argv after the agent's own, env,
 *  and text before the task (for agents with no system-prompt flag). */
export interface InstanceLaunch {
  args: string[];
  env: Record<string, string>;
  taskPrefix: string;
}

export interface InstanceLaunchInput {
  agentId: string;
  /** Owner-only file holding the instance's identity token. */
  tokenFile: string;
  /** The Foreman CLI, as argv (absolute paths): `[node, …/cli/index.js]`
   *  or a standalone `[foreman]`. */
  foremanArgv: string[];
  /** One paragraph on the role (org.yaml), or null. */
  role: string | null;
}

/** Agents whose launch can carry their own Foreman MCP server. */
export function supportsInstances(entry: Pick<AgentEntry, "id">): boolean {
  return entry.id === "codex" || entry.id === "claude-code";
}

/**
 * The launch additions that make `entry`'s agent talk to Foreman as
 * `input.agentId`, or null for an agent Foreman can't point at its own
 * MCP server per launch (it then runs with its config's wiring).
 */
export function instanceLaunch(entry: Pick<AgentEntry, "id">, input: InstanceLaunchInput): InstanceLaunch | null {
  const [command, ...cliArgs] = input.foremanArgv;
  if (!command) return null;
  const serverArgs = [...cliArgs, "mcp-stdio", "--source", input.agentId];
  // The agent's own wiring may carry its token directly (FOREMAN_AGENT_TOKEN
  // wins over the file): blank it, or the instance would present the base
  // agent's token and run untrusted (token-mismatch).
  const env = { [AGENT_TOKEN_ENV]: "", [AGENT_TOKEN_FILE_ENV]: input.tokenFile };
  const rolePrompt = input.role ? `${input.role}\n\n` : "";
  if (entry.id === "codex") {
    // `-c key=value` overrides ~/.codex/config.toml for this run. Codex
    // merges tables key by key (even `-c mcp_servers.foreman={…}`), so the
    // config's `env = { FOREMAN_AGENT_TOKEN = … }` for plain `codex`
    // survives unless we overwrite that key too; and a server disabled in
    // the config stays disabled unless we switch it on.
    return {
      args: [
        "-c",
        `mcp_servers.foreman.command=${tomlString(command)}`,
        "-c",
        `mcp_servers.foreman.args=[${serverArgs.map(tomlString).join(",")}]`,
        "-c",
        `mcp_servers.foreman.env={${AGENT_TOKEN_ENV}="",${AGENT_TOKEN_FILE_ENV}=${tomlString(input.tokenFile)}}`,
        "-c",
        "mcp_servers.foreman.enabled=true",
      ],
      env: {},
      taskPrefix: rolePrompt,
    };
  }
  if (entry.id === "claude-code") {
    const mcp = { mcpServers: { foreman: { command, args: serverArgs, env } } };
    return {
      args: [
        "--mcp-config",
        JSON.stringify(mcp),
        ...(input.role ? ["--append-system-prompt", input.role] : []),
      ],
      env: {},
      taskPrefix: "",
    };
  }
  return null;
}

/** A TOML basic string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/**
 * Write an instance's identity token to `<stateDir>/agent-tokens/<id>.token`
 * (directory 0700, file 0600), refreshed on every launch so a rotated token
 * is picked up. mcp-stdio reads it through FOREMAN_AGENT_TOKEN_FILE, which
 * refuses anything but an owner-only regular file.
 */
export function writeInstanceTokenFile(stateDir: string, agentId: string, token: string): string {
  const dir = join(stateDir, "agent-tokens");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${agentId}.token`);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error(`refusing to write the token for ${agentId} through a symlink (${file})`);
  }
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Remove an instance's token file (best-effort: nothing there is fine). */
export function removeInstanceTokenFile(stateDir: string, agentId: string): void {
  try {
    rmSync(join(stateDir, "agent-tokens", `${agentId}.token`), { force: true });
  } catch {
    // best-effort
  }
}

/** The Foreman CLI this process runs, by absolute path. */
export function foremanCliArgv(probe: { execPath?: string; cliEntry?: string; isSea?: boolean } = {}): string[] {
  const execPath = probe.execPath ?? process.execPath;
  if (probe.isSea ?? runningAsSea()) return [execPath];
  const entry = probe.cliEntry ?? process.argv[1];
  if (!entry) return ["foreman"];
  try {
    return [execPath, realpathSync(entry)];
  } catch {
    return [execPath, entry];
  }
}

function runningAsSea(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

/** The role paragraph for an instance's launch, from its org.yaml role. */
export function rolePrompt(input: {
  company: string;
  roleId: string;
  title: string;
  department?: string | undefined;
  responsibility?: string | undefined;
  /** The role's own instructions (org.yaml `instructions`). */
  instructions?: string | undefined;
  agentId: string;
}): string {
  const dept = input.department ? ` in ${input.department}` : "";
  const resp = input.responsibility ? ` Your responsibility: ${input.responsibility}.` : "";
  const how = input.instructions ? `\n\n${input.instructions.trim()}\n\n` : " ";
  return (
    `You are ${input.title} (role "${input.roleId}"${dept}) at ${input.company}, working as the agent "${input.agentId}".` +
    `${resp}${how}Work only on the task you were given; to talk to colleagues or report back, use Foreman's org_post and org_report tools.`
  );
}
