import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { AGENT_TOKEN_ENV } from "../../agent-identity.js";
import {
  LlmProviderError,
  type LlmCallOptions,
  type LlmClient,
  type LlmResponse,
} from "../client.js";

// =============================================================================
// Claude Code as Foreman's brain
// =============================================================================
//
// For someone with a Claude plan and no API key: Foreman runs their own,
// unmodified `claude` binary, signed in through Anthropic's flow. Foreman
// never sees that credential. A third-party app may not offer Claude.ai login
// or hold those tokens itself (code.claude.com/docs/en/legal-and-compliance),
// so this is the only subscription route for Claude.
//
// A prompt can hold text from agents and chat users, so the call must be able
// to do nothing but answer: no tools, no MCP servers, no hooks or settings, no
// session left on disk, and a neutral working directory so no project's
// instructions load. The prompt goes over stdin, never argv, where `ps` shows
// it. `temperature` has no flag here and is ignored.

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 300;

const SYSTEM_PROMPT =
  "You are the assistant inside Foreman, a local security gateway for " +
  "developer agents. Answer with text only.";

export const CLAUDE_LOGIN_COMMAND = "claude auth login";

/** `claude` can't answer yet, and the user can fix that. */
export class ClaudeCodeNotReadyError extends LlmProviderError {
  constructor(
    public readonly reason: "missing" | "signed-out",
    message: string,
  ) {
    super(message, "anthropic");
    this.name = "ClaudeCodeNotReadyError";
  }
}

export interface ClaudeCodeClientOptions {
  model: string;
  /** Test hook: another binary name or path. */
  command?: string;
  defaultTimeoutMs?: number;
}

interface ClaudeResult {
  is_error?: boolean;
  api_error_status?: number;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function claudeCodeArgs(model: string): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--model",
    model,
    "--system-prompt",
    SYSTEM_PROMPT,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

/** The caller's env, minus what must not reach this call: an agent's Foreman
 *  token, and API keys, which would bill the API instead of the user's plan
 *  and so slip past the budget (this client reports a cost of 0). */
export function claudeCodeEnv(
  maxTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
  };
  delete out[AGENT_TOKEN_ENV];
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

export class ClaudeCodeLlmClient implements LlmClient {
  readonly providerId = "anthropic" as const;
  readonly model: string;
  private readonly command: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: ClaudeCodeClientOptions) {
    this.model = opts.model;
    this.command = opts.command ?? "claude";
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ping(): Promise<LlmResponse> {
    return this.call('Say "pong" in one word.', {
      feature: "test",
      maxTokens: 64,
      temperature: 0,
    });
  }

  async call(prompt: string, opts: LlmCallOptions): Promise<LlmResponse> {
    const t0 = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const run = await this.run(prompt, opts.maxTokens, timeoutMs);
    const durationMs = Date.now() - t0;
    if (run.timedOut) {
      throw new LlmProviderError(
        `Claude Code did not answer within ${Math.round(timeoutMs / 1000)}s`,
        "anthropic",
      );
    }
    const parsed = parseResult(run.stdout);
    if (!parsed) {
      throw new LlmProviderError(
        `Claude Code failed (exit ${run.exitCode ?? "?"}): ${clip(run.stderr || run.stdout)}`,
        "anthropic",
      );
    }
    if (parsed.is_error || run.exitCode !== 0) {
      throw errorFor(parsed);
    }
    return {
      text: parsed.result ?? "",
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      // Usage goes against the user's Claude plan, not an API budget.
      costUsd: 0,
      durationMs,
      cacheHit: false,
    };
  }

  private run(
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, claudeCodeArgs(this.model), {
        cwd: tmpdir(),
        env: claudeCodeEnv(maxTokens),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: timeoutMs,
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => stdout.push(d));
      child.stderr.on("data", (d: Buffer) => stderr.push(d));
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "ENOENT"
            ? new ClaudeCodeNotReadyError(
                "missing",
                "Claude Code is not installed: the `claude` command was not found. " +
                  "Install it from https://code.claude.com/docs",
              )
            : new LlmProviderError(`Claude Code could not start: ${err.message}`, "anthropic"),
        );
      });
      child.on("close", (exitCode, signal) => {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf-8"),
          stderr: Buffer.concat(stderr).toString("utf-8"),
          exitCode,
          timedOut: signal === "SIGTERM",
        });
      });
      // A `claude` that exits before reading must not take the gateway down.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  }
}

function parseResult(stdout: string): ClaudeResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudeResult) : null;
  } catch {
    return null;
  }
}

function errorFor(result: ClaudeResult): LlmProviderError {
  const text = result.result ?? "unknown error";
  if (result.api_error_status === 401 || /not logged in|\/login|authenticate/i.test(text)) {
    return new ClaudeCodeNotReadyError(
      "signed-out",
      `Claude Code is not signed in (${clip(text)}). Run: ${CLAUDE_LOGIN_COMMAND}`,
    );
  }
  return new LlmProviderError(`Claude Code error: ${clip(text)}`, "anthropic");
}

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat;
}
