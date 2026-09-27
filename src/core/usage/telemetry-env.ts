import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OTLP_PORT, USAGE_KEY_HEADER } from "./otlp-receiver.js";

// =============================================================================
// Telemetry wiring for agents (#629)
// =============================================================================
//
// The receiver key lives in `<foreman home>/usage.key` (0600). It keeps other
// local processes from writing usage; it grants nothing else.

export function loadOrCreateUsageKey(foremanRoot: string): string {
  const path = join(foremanRoot, "usage.key");
  if (existsSync(path)) {
    const key = readFileSync(path, "utf-8").trim();
    if (/^[a-f0-9]{32,}$/.test(key)) return key;
  }
  const key = randomBytes(24).toString("hex");
  try {
    writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "w" });
    chmodSync(path, 0o600);
  } catch {
    // Read-only home: the key still works for this process.
  }
  return key;
}

export function otlpPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FOREMAN_OTLP_PORT);
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_OTLP_PORT;
}

/** Environment that makes Claude Code send per-request usage to Foreman.
 *  Codex reads its telemetry settings from ~/.codex/config.toml instead
 *  (see codexTelemetrySnippet); other env is harmless to it. */
export function telemetryEnv(opts: {
  port: number;
  key: string;
  agentId: string;
  taskRef?: string | null;
}): Record<string, string> {
  const resource = [`foreman.agent=${safe(opts.agentId)}`, ...(opts.taskRef ? [`foreman.task=${safe(opts.taskRef)}`] : [])];
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${opts.port}`,
    OTEL_EXPORTER_OTLP_HEADERS: `${USAGE_KEY_HEADER}=${opts.key}`,
    OTEL_RESOURCE_ATTRIBUTES: resource.join(","),
    // Counts only: never export prompt text.
    OTEL_LOG_USER_PROMPTS: "0",
  };
}

export function codexTelemetrySnippet(opts: { port: number; key: string }): string {
  return [
    "[otel]",
    "log_user_prompt = false",
    `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${opts.port}/v1/logs", protocol = "json", headers = { "${USAGE_KEY_HEADER}" = "${opts.key}" } } }`,
  ].join("\n");
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}
