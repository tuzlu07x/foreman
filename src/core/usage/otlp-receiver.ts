import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { agentForUsageKey } from "./agent-key.js";
import type { UsageEntry, UsageLedger } from "./ledger.js";

// =============================================================================
// OTLP/HTTP JSON receiver for agent telemetry (#629)
// =============================================================================
//
// Claude Code and Codex can export OpenTelemetry. Foreman listens on
// 127.0.0.1 and keeps only the counts from two log events:
//
//   claude_code.api_request  model, input/output/cache tokens, cost_usd
//   codex.sse_event          (event.kind = response.completed) model and
//                            input/output/cached token counts
//
// Prompts, responses and every other attribute are dropped on the floor.
// The endpoint accepts JSON only (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)
// and caps bodies at 1 MB. Two kinds of key are accepted in
// `x-foreman-usage-key`:
//   - a per-task key Foreman hands each task it starts: the agent and task
//     come from Foreman's own record of that key, never from the payload,
//     so a task can only report usage as itself;
//   - the per-install key, for agents you start yourself and set up with
//     `foreman usage env`: the payload's `foreman.agent` is trusted there.
// Usage never feeds an approval, but it does drive budgets (which can
// pause delegation), hence the keys.

export const USAGE_KEY_HEADER = "x-foreman-usage-key";
export const DEFAULT_OTLP_PORT = 4319;
const MAX_BODY_BYTES = 1_000_000;

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
};
type KeyValue = { key?: string; value?: AnyValue };

export interface OtlpReceiverOptions {
  ledger: UsageLedger;
  key: string;
  port?: number;
  onError?: (message: string) => void;
  /** Called after usage was recorded (budgets are checked right away). */
  onRecorded?: () => void;
}

export class OtlpReceiver {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private readonly taskKeys = new Map<string, { agentId: string; taskRef: string; timer: NodeJS.Timeout | null }>();


  constructor(private readonly opts: OtlpReceiverOptions) {}

  get port(): number | null {
    return this.boundPort;
  }

  /** Listen on 127.0.0.1; resolves with the bound port. */
  start(): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? DEFAULT_OTLP_PORT, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        this.boundPort = typeof address === "object" && address ? address.port : null;
        resolve(this.boundPort ?? 0);
      });
    });
  }

  /** A key only this task can report with; its usage is booked to
   *  `agentId` / `taskRef` whatever the payload says. */
  issueTaskKey(agentId: string, taskRef: string): string {
    const key = randomBytes(24).toString("hex");
    this.taskKeys.set(key, { agentId, taskRef, timer: null });
    return key;
  }

  /** Stop accepting a task key after `graceMs` (exporters flush on exit). */
  revokeTaskKey(key: string, graceMs = 5 * 60_000): void {
    const entry = this.taskKeys.get(key);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => this.taskKeys.delete(key), graceMs);
    entry.timer.unref?.();
  }

  async stop(): Promise<void> {
    for (const entry of this.taskKeys.values()) if (entry.timer) clearTimeout(entry.timer);
    this.taskKeys.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown = {}): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") return reply(405, { error: "POST only" });
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/v1/logs" && path !== "/v1/metrics" && path !== "/v1/traces") return reply(404);
    const caller = this.caller(req.headers[USAGE_KEY_HEADER]);
    if (!caller) return reply(401, { error: "missing or wrong usage key" });
    if (!String(req.headers["content-type"] ?? "").includes("json")) {
      return reply(415, { error: "set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" });
    }
    let raw: string | null;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      return; // the client went away, or kept sending far past the limit
    }
    if (raw === null) {
      res.setHeader("connection", "close");
      return reply(413, { error: "body too large" });
    }
    // Metrics and traces are accepted (so exporters don't retry) and ignored.
    if (path === "/v1/logs") {
      try {
        this.ingestLogs(JSON.parse(raw) as unknown, caller === "install" ? undefined : caller);
      } catch (err) {
        this.opts.onError?.(`telemetry: ${err instanceof Error ? err.message : String(err)}`);
        return reply(400, { error: "not OTLP JSON" });
      }
    }
    reply(200, { partialSuccess: {} });
  }

  /** "install", the agent (and task) a key belongs to, or null. */
  private caller(header: string | string[] | undefined): "install" | { agentId: string; taskRef: string | null } | null {
    const raw = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    const given = Buffer.from(raw);
    const install = Buffer.from(this.opts.key);
    if (given.length === install.length && timingSafeEqual(given, install)) return "install";
    // A per-agent key from `foreman usage env` (#657).
    const agentId = agentForUsageKey(this.opts.key, raw);
    if (agentId) return { agentId, taskRef: null };
    // Task keys are random 48-hex strings; a Map lookup leaks nothing useful.
    const task = this.taskKeys.get(raw);
    return task ? { agentId: task.agentId, taskRef: task.taskRef } : null;
  }

  /** Record the usage events in an OTLP logs payload; returns how many.
   *  With `task`, every entry is booked to that agent (and task, when the
   *  key is a task's). */
  ingestLogs(payload: unknown, task?: { agentId: string; taskRef: string | null }): number {
    let recorded = 0;
    for (const entry of usageEntriesFromLogs(payload)) {
      const booked = task ? { ...entry, agentId: task.agentId, taskRef: task.taskRef ?? entry.taskRef } : entry;
      if (this.opts.ledger.record(booked)) recorded += 1;
    }
    if (recorded > 0) this.opts.onRecorded?.();
    return recorded;
  }
}

/** Pure extraction, exported for tests. */
export function usageEntriesFromLogs(payload: unknown): UsageEntry[] {
  const out: UsageEntry[] = [];
  const resourceLogs = arr(obj(payload)?.resourceLogs);
  for (const rl of resourceLogs) {
    const resource = attrs(arr(obj(obj(rl)?.resource)?.attributes));
    const agent = agentFromResource(resource);
    for (const sl of arr(obj(rl)?.scopeLogs)) {
      for (const record of arr(obj(sl)?.logRecords)) {
        const r = obj(record);
        if (!r) continue;
        const a = attrs(arr(r.attributes));
        const body = obj(r.body)?.stringValue;
        const name = String(a["event.name"] ?? body ?? "");
        const ts = nanosToMs(r.timeUnixNano) ?? undefined;
        const taskRef = str(resource["foreman.task"]) ?? null;
        if (name === "claude_code.api_request" || name === "api_request") {
          out.push({
            agentId: agent ?? "claude-code",
            source: "telemetry",
            model: str(a.model) ?? null,
            input: numAttr(a.input_tokens),
            output: numAttr(a.output_tokens),
            cacheRead: numAttr(a.cache_read_tokens),
            cacheWrite: numAttr(a.cache_creation_tokens),
            costUsd: numAttr(a.cost_usd) ?? null,
            taskRef,
            sessionRef: str(a["session.id"]) ?? str(resource["session.id"]) ?? null,
            ...(ts ? { ts } : {}),
          });
        } else if (name === "codex.sse_event" && a["event.kind"] === "response.completed") {
          const input = numAttr(a.input_token_count) ?? 0;
          const cached = Math.min(input, numAttr(a.cached_token_count) ?? 0);
          out.push({
            agentId: agent ?? "codex",
            source: "telemetry",
            model: str(a.model) ?? str(a.slug) ?? null,
            input: input - cached,
            cacheRead: cached,
            output: numAttr(a.output_token_count),
            taskRef,
            sessionRef: str(a["conversation.id"]) ?? null,
            ...(ts ? { ts } : {}),
          });
        }
      }
    }
  }
  return out;
}

function agentFromResource(resource: Record<string, unknown>): string | null {
  const explicit = str(resource["foreman.agent"]);
  if (explicit) return explicit;
  const service = (str(resource["service.name"]) ?? "").toLowerCase();
  if (service.includes("claude")) return "claude-code";
  if (service.includes("codex")) return "codex";
  return null;
}

function attrs(list: unknown[]): Record<string, unknown> {
  // Keys come from the request body: collect them in a Map, and let
  // fromEntries define own properties, so `__proto__` can't pollute anything.
  const out = new Map<string, unknown>();
  for (const item of list) {
    const kv = obj(item) as KeyValue | null;
    if (typeof kv?.key !== "string" || !kv.value) continue;
    const v = kv.value;
    out.set(kv.key, v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue);
  }
  return Object.fromEntries(out);
}

function numAttr(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function nanosToMs(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  if (!/^\d{13,}$/.test(s)) return null;
  return Number(s.slice(0, -6));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The body, or null when it is over `limit`. An oversize body is read and
 *  discarded up to 8× the limit so the client sees the 413; past that the
 *  connection is dropped. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit * 8) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
