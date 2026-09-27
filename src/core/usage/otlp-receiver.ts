import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
// The endpoint accepts JSON only (OTEL_EXPORTER_OTLP_PROTOCOL=http/json),
// needs the per-install key in `x-foreman-usage-key`, and caps bodies at
// 1 MB. Usage is reporting, never an input to an approval decision, but the
// key keeps other local processes from padding someone's bill.

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
}

export class OtlpReceiver {
  private server: Server | null = null;
  private boundPort: number | null = null;

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

  async stop(): Promise<void> {
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
    if (!this.authorised(req.headers[USAGE_KEY_HEADER])) return reply(401, { error: "missing or wrong usage key" });
    if (!String(req.headers["content-type"] ?? "").includes("json")) {
      return reply(415, { error: "set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" });
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      return reply(413, { error: "body too large" });
    }
    // Metrics and traces are accepted (so exporters don't retry) and ignored.
    if (path === "/v1/logs") {
      try {
        this.ingestLogs(JSON.parse(raw) as unknown);
      } catch (err) {
        this.opts.onError?.(`telemetry: ${err instanceof Error ? err.message : String(err)}`);
        return reply(400, { error: "not OTLP JSON" });
      }
    }
    reply(200, { partialSuccess: {} });
  }

  private authorised(header: string | string[] | undefined): boolean {
    const given = Buffer.from(Array.isArray(header) ? (header[0] ?? "") : (header ?? ""));
    const expected = Buffer.from(this.opts.key);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Record the usage events in an OTLP logs payload; returns how many. */
  ingestLogs(payload: unknown): number {
    let recorded = 0;
    for (const entry of usageEntriesFromLogs(payload)) {
      if (this.opts.ledger.record(entry)) recorded += 1;
    }
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
  const out: Record<string, unknown> = {};
  for (const item of list) {
    const kv = obj(item) as KeyValue | null;
    if (!kv?.key || !kv.value) continue;
    const v = kv.value;
    out[kv.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
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

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
