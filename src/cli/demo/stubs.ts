import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Stand-in agent CLIs for `foreman demo`. They sit first on the demo's PATH,
// so a task Foreman hands to "claude" or "codex" runs these instead of the
// real tools: canned output, no file access, no network except reporting
// usage to the demo's own 127.0.0.1 telemetry endpoint, the way Claude Code
// does when Foreman sets its exporter env.

const CLAUDE = `// foreman demo stand-in for Claude Code. Never touches files.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const header = (process.env.OTEL_EXPORTER_OTLP_HEADERS || '').split('=')
const resource = (process.env.OTEL_RESOURCE_ATTRIBUTES || '').split(',').filter(Boolean).map((kv) => {
  const [key, value] = kv.split('=')
  return { key, value: { stringValue: value } }
})
const n = (key, v) => ({ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } })
const log = {
  resourceLogs: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }, ...resource] },
    scopeLogs: [{ logRecords: [{
      body: { stringValue: 'claude_code.api_request' },
      attributes: [{ key: 'model', value: { stringValue: 'claude-sonnet-4-5' } }, n('input_tokens', 18250), n('output_tokens', 2140), n('cache_read_tokens', 96000), n('cost_usd', 0.1204)],
    }] }],
  }],
}
setTimeout(async () => {
  if (endpoint && endpoint.startsWith('http://127.0.0.1:')) {
    await fetch(endpoint + '/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json', [header[0]]: header[1] }, body: JSON.stringify(log) }).catch(() => {})
  }
  console.log('Planned the change: a token bucket per API key, 100 requests a minute.')
  console.log('Added src/middleware/rate-limit.ts and 4 tests. All green.')
}, 1500)
`;

const CODEX = `# foreman demo stand-in for Codex. Never touches files.
sleep 2
echo "Wrote 6 tests for the rate limiter: burst, refill and per-key isolation."
echo "npm test: 6 passed."
echo "tokens used: 48,213" >&2
`;

/** Long-running agents (gateways, daemons) just stay up quietly: one
 *  process that leaves nothing behind when Foreman stops it. */
const DAEMON = `// foreman demo stand-in agent. Stays up quietly; never touches files.
const stop = () => process.exit(0)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1 << 30)
`;

/** Agent CLIs and installers the demo has no stand-in for. They refuse to
 *  run, so one installed next to system tools (/usr/bin) is still out of
 *  reach. */
const REFUSED = [
  "gemini",
  "aider",
  "goose",
  "opencode",
  "cursor-agent",
  "amp",
  "qwen",
  "crush",
  "copilot",
  "cline",
  "droid",
  "npm",
  "npx",
  "uvx",
  "pipx",
];

const refused = (name: string): string => `# foreman demo: ${name} is not available here.
echo "${name} isn't available in foreman demo" >&2
exit 127
`;

const NODE = "node";
const SH = "sh";

export const DEMO_STUBS: Record<string, { interpreter: typeof NODE | typeof SH; body: string }> = {
  claude: { interpreter: NODE, body: CLAUDE },
  codex: { interpreter: SH, body: CODEX },
  hermes: { interpreter: NODE, body: DAEMON },
  openclaw: { interpreter: NODE, body: DAEMON },
  zeroclaw: { interpreter: NODE, body: DAEMON },
  "generic-mcp": { interpreter: NODE, body: DAEMON },
  ...Object.fromEntries(REFUSED.map((name) => [name, { interpreter: SH, body: refused(name) }])),
};

/** Write the stand-ins. Their interpreters are absolute paths (this very
 *  node, /bin/sh), so the demo's PATH can hold nothing but the stand-ins and
 *  system tools: a real agent CLI next to node is never found. */
export function writeDemoStubs(binDir: string, nodePath: string = process.execPath): string[] {
  const written: string[] = [];
  for (const [name, stub] of Object.entries(DEMO_STUBS)) {
    const path = join(binDir, name);
    const shebang = stub.interpreter === NODE ? nodeShebang(nodePath) : "#!/bin/sh";
    writeFileSync(path, `${shebang}\n${stub.body}`, { mode: 0o755 });
    chmodSync(path, 0o755);
    written.push(path);
  }
  return written;
}

/** A shebang line can't hold spaces or run long; fall back to `env node`
 *  (the demo then puts node's own directory on PATH, after the stand-ins). */
function nodeShebang(nodePath: string): string {
  return needsEnvNode(nodePath) ? "#!/usr/bin/env node" : `#!${nodePath}`;
}

export function needsEnvNode(nodePath: string = process.execPath): boolean {
  return /\s/.test(nodePath) || nodePath.length > 120;
}
