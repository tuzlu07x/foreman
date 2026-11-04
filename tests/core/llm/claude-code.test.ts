import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LlmProviderError } from "../../../src/core/llm/client.js";
import { loadLlmConfig, saveLlmConfig, defaultLlmConfig } from "../../../src/core/llm/config.js";
import { removeLegacyClaudeTokens } from "../../../src/core/llm/oauth/token-store.js";
import {
  claudeCodeArgs,
  ClaudeCodeLlmClient,
  claudeCodeEnv,
  ClaudeCodeNotReadyError,
} from "../../../src/core/llm/providers/claude-code.js";

// Foreman's brain on the user's own `claude`. A stand-in binary records what
// it was given, since what must never reach it matters as much as the answer.
describe("ClaudeCodeLlmClient", () => {
  let dir: string;
  const opts = { feature: "test", maxTokens: 32 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-claude-code-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stub(body: string): ClaudeCodeLlmClient {
    const path = join(dir, "claude");
    writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(path, 0o755);
    return new ClaudeCodeLlmClient({ model: "claude-haiku-5-5", command: path });
  }

  const answer = JSON.stringify({
    is_error: false,
    result: "pong",
    usage: { input_tokens: 7, output_tokens: 2 },
    total_cost_usd: 0.5,
  });

  const recording = (stdout: string) => `
    const fs = require("node:fs");
    let input = "";
    process.stdin.on("data", (d) => (input += d)).on("end", () => {
      fs.writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({
        argv: process.argv.slice(2), input, cwd: process.cwd(), env: process.env,
      }));
      process.stdout.write(${JSON.stringify(stdout)});
    });`;

  const seen = () =>
    JSON.parse(readFileSync(join(dir, "seen.json"), "utf-8")) as {
      argv: string[];
      input: string;
      cwd: string;
      env: Record<string, string>;
    };

  it("returns the answer and reports no spend against the API budget", async () => {
    const res = await stub(recording(answer)).call("hi", opts);
    expect(res).toMatchObject({ text: "pong", inputTokens: 7, outputTokens: 2, costUsd: 0, cacheHit: false });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the prompt on stdin, never in argv", async () => {
    await stub(recording(answer)).call("secret-looking prompt", opts);
    expect(seen().input).toBe("secret-looking prompt");
    expect(seen().argv.join(" ")).not.toContain("secret-looking");
  });

  it("can do nothing but answer: no tools, MCP, settings or saved session", () => {
    const args = claudeCodeArgs("claude-haiku-5-5");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("does not depend on the working directory's project", async () => {
    await stub(recording(answer)).call("hi", opts);
    expect(seen().cwd).not.toBe(process.cwd());
  });

  it("keeps Foreman's token and API keys out of the child", () => {
    const env = claudeCodeEnv(32, {
      PATH: "/bin",
      FOREMAN_AGENT_TOKEN: "x",
      ANTHROPIC_API_KEY: "y",
      ANTHROPIC_AUTH_TOKEN: "z",
    });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32" });
  });

  it("reports a revoked login as signed out, however `auth status` looks", async () => {
    const out = JSON.stringify({
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
    });
    const err = await stub(`process.stdout.write(${JSON.stringify(out)}); process.exitCode = 1`)
      .call("hi", opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCodeNotReadyError);
    expect((err as ClaudeCodeNotReadyError).reason).toBe("signed-out");
    expect((err as Error).message).toContain("claude auth login");
  });

  it("surfaces any other error without treating it as signed out", async () => {
    const out = JSON.stringify({ is_error: true, result: "model not found" });
    const err = await stub(`process.stdout.write(${JSON.stringify(out)})`)
      .call("hi", opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err).not.toBeInstanceOf(ClaudeCodeNotReadyError);
    expect((err as Error).message).toContain("model not found");
  });

  it("says so when `claude` is not installed", async () => {
    const client = new ClaudeCodeLlmClient({ model: "m", command: join(dir, "no-such-claude") });
    const err = await client.call("hi", opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCodeNotReadyError);
    expect((err as ClaudeCodeNotReadyError).reason).toBe("missing");
  });

  it("fails on output that is not its JSON, without echoing the prompt", async () => {
    const err = await stub(`console.error("boom"); process.exitCode = 3`)
      .call("my prompt", opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as Error).message).toContain("exit 3");
    expect((err as Error).message).toContain("boom");
    expect((err as Error).message).not.toContain("my prompt");
  });

  it("gives up after the timeout", async () => {
    const err = await stub("setTimeout(() => {}, 60000)")
      .call("hi", { ...opts, timeoutMs: 200 })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("did not answer");
  });

  it("survives a `claude` that exits before reading its stdin", async () => {
    const err = await stub("process.exit(1)")
      .call("x".repeat(2_000_000), opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
  });
});

describe("the Claude sign-in Foreman used to offer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-claude-legacy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves an old llm.yaml to Claude Code", () => {
    const path = join(dir, "llm.yaml");
    const config = defaultLlmConfig();
    config.credentials.anthropic = { auth_mode: "oauth", secret_name: "anthropic-key" };
    saveLlmConfig(path, config);
    expect(loadLlmConfig(path).credentials.anthropic).toMatchObject({
      auth_mode: "claude_code",
      secret_name: "anthropic-key",
    });
  });

  it("leaves a ChatGPT sign-in as it is", () => {
    const path = join(dir, "llm.yaml");
    const config = defaultLlmConfig();
    config.credentials.openai = { auth_mode: "oauth" };
    saveLlmConfig(path, config);
    expect(loadLlmConfig(path).credentials.openai?.auth_mode).toBe("oauth");
  });

  it("deletes tokens left in the store, once", () => {
    const names = new Set(["llm-oauth-anthropic", "llm-oauth-openai"]);
    const store = {
      exists: (n: string) => names.has(n),
      remove: (n: string) => void names.delete(n),
    };
    expect(removeLegacyClaudeTokens(store)).toBe(true);
    expect(removeLegacyClaudeTokens(store)).toBe(false);
    expect([...names]).toEqual(["llm-oauth-openai"]);
  });
});
