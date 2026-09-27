import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

// =============================================================================
// Tool-definition pins — rug-pull detection (trust on first use)
// =============================================================================
//
// The first time the hub sees a server's tools it records a SHA-256 of each
// definition (name + description + inputSchema). Later sessions compare the
// live definitions against the pins: a tool whose definition changed, or
// that appeared after pinning, is withheld from agents until the user runs
// `foreman mcp trust <server>`. The stored definitions double as a listing
// cache, so `tools/list` can answer without spawning every server.
//
// Pins are bound to a fingerprint of how the server is launched (command,
// args, URL — never secrets). Pointing a server name at a different package
// or endpoint starts a fresh trust-on-first-use cycle instead of silently
// inheriting the old server's trust.

export interface PinnableTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

const PinnedToolSchema = z.object({
  hash: z.string(),
  definition: z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    annotations: z.unknown().optional(),
  }),
  /** Flagged by the scanner and trusted by the user anyway. */
  trustedDespiteFindings: z.boolean().optional(),
});

/** What the last live check found different from the pins (#634), so a
 *  listing from the pinned cache can still show it. Cleared by a re-pin. */
const PinDriftSchema = z.object({
  seenAt: z.number(),
  changed: z.array(z.string()),
  added: z.array(z.string()),
});

const ServerPinsSchema = z.object({
  pinnedAt: z.number(),
  fingerprint: z.string(),
  tools: z.record(z.string(), PinnedToolSchema),
  drift: PinDriftSchema.optional(),
});

const PinFileSchema = z.object({
  version: z.literal(1),
  servers: z.record(z.string(), ServerPinsSchema),
});

export type PinnedTool = z.infer<typeof PinnedToolSchema>;
export type PinDrift = z.infer<typeof PinDriftSchema>;
export type ServerPins = z.infer<typeof ServerPinsSchema>;
type PinFile = z.infer<typeof PinFileSchema>;

export interface PinDiff {
  unchanged: string[];
  changed: string[];
  added: string[];
  removed: string[];
}

export function hashToolDefinition(tool: PinnableTool): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? null,
        // A flipped readOnlyHint / destructiveHint is a change worth re-review.
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      }),
    )
    .digest("hex");
}

/** Identity of a server launch configuration, excluding secret values. */
export function serverFingerprint(launch: {
  command?: string;
  args?: readonly string[];
  url?: string;
}): string {
  return createHash("sha256")
    .update(canonicalJson({ command: launch.command ?? null, args: launch.args ?? [], url: launch.url ?? null }))
    .digest("hex")
    .slice(0, 16);
}

export class ToolPinStore {
  private data: PinFile;

  /** `path = null` keeps pins in memory only (tests, pinning disabled). */
  constructor(private readonly path: string | null) {
    this.data = path ? readPinFile(path) : { version: 1, servers: {} };
  }

  /** Pins for `server` — `null` when absent or pinned for a different
   *  launch configuration. */
  get(server: string, fingerprint: string): ServerPins | null {
    const pins = this.data.servers[server];
    return pins && pins.fingerprint === fingerprint ? pins : null;
  }

  pin(
    server: string,
    fingerprint: string,
    tools: readonly PinnableTool[],
    opts: { now?: number; trustedDespiteFindings?: ReadonlySet<string> } = {},
  ): void {
    const entries: Record<string, PinnedTool> = {};
    for (const tool of tools) {
      entries[tool.name] = {
        hash: hashToolDefinition(tool),
        definition: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        },
        ...(opts.trustedDespiteFindings?.has(tool.name) ? { trustedDespiteFindings: true } : {}),
      };
    }
    this.update((data) => {
      data.servers[server] = { pinnedAt: opts.now ?? Date.now(), fingerprint, tools: entries };
    });
  }

  /** Remember (or clear, when nothing differs) what the last live check
   *  found changed or added since pinning. */
  recordDrift(server: string, fingerprint: string, drift: { changed: string[]; added: string[] }, now = Date.now()): void {
    const current = this.get(server, fingerprint)?.drift;
    const empty = drift.changed.length === 0 && drift.added.length === 0;
    if (empty && !current) return;
    if (current && sameNames(current.changed, drift.changed) && sameNames(current.added, drift.added)) return;
    this.update((data) => {
      const pins = data.servers[server];
      if (!pins || pins.fingerprint !== fingerprint) return;
      if (empty) delete pins.drift;
      else pins.drift = { seenAt: now, changed: [...drift.changed].sort(), added: [...drift.added].sort() };
    });
  }

  forget(server: string): void {
    this.update((data) => {
      delete data.servers[server];
    });
  }

  diff(server: string, fingerprint: string, tools: readonly PinnableTool[]): PinDiff {
    const pins = this.get(server, fingerprint)?.tools ?? {};
    const out: PinDiff = { unchanged: [], changed: [], added: [], removed: [] };
    const live = new Set<string>();
    for (const tool of tools) {
      live.add(tool.name);
      const pinned = pins[tool.name];
      if (!pinned) out.added.push(tool.name);
      else if (pinned.hash === hashToolDefinition(tool)) out.unchanged.push(tool.name);
      else out.changed.push(tool.name);
    }
    for (const name of Object.keys(pins)) if (!live.has(name)) out.removed.push(name);
    return out;
  }

  /** Read-modify-write so concurrent `foreman mcp-stdio` processes (one
   *  per agent) don't drop each other's pins. */
  private update(mutate: (data: PinFile) => void): void {
    if (this.path) this.data = readPinFile(this.path);
    mutate(this.data);
    if (!this.path) return;
    const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best-effort
    }
  }
}

function readPinFile(path: string): PinFile {
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    return PinFileSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    // An unreadable pin file never grants trust; the next connection starts
    // a fresh trust-on-first-use cycle that `foreman mcp tools` shows.
    return { version: 1, servers: {} };
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((name, i) => name === [...b].sort()[i]);
}

/** Deterministic JSON — object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
