import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acpStdioV1Adapter } from "../../src/core/adapters/index.js";
import { GEMINI_POLICY, writeGeminiPolicy } from "../../src/core/gemini-launch.js";

// Found by running the real `gemini --acp` (0.66) against a stand-in model:
// with no policy, reads and "safe" shell commands such as `cat .env` run
// without a permission request, so Foreman never sees them. These pin what
// makes every call reach Foreman.

describe("Gemini CLI's policy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-gemini-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("asks about every tool", () => {
    expect(GEMINI_POLICY).toMatch(/toolName = "\*"\ndecision = "ask_user"/);
  });

  it("has a shell rule with an argsPattern: without one Gemini allows the commands it calls safe", () => {
    expect(GEMINI_POLICY).toMatch(/toolName = "run_shell_command"\nargsPattern = "\.\*"\ndecision = "ask_user"/);
  });

  it("lets Foreman's own tools through, which Foreman mediates itself", () => {
    expect(GEMINI_POLICY).toMatch(/mcpName = "foreman"\ntoolName = "\*"\ndecision = "allow"/);
  });

  it("names a tool with mcpName: a rule with mcpName alone makes Gemini ignore the file", () => {
    for (const block of GEMINI_POLICY.split("[[rule]]").slice(1)) expect(block).toContain("toolName");
  });

  it("is owner-only, and refreshed if someone changed it", () => {
    const folder = writeGeminiPolicy(dir);
    const file = join(folder, "foreman.toml");
    expect(readFileSync(file, "utf-8")).toBe(GEMINI_POLICY);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("what the risk rules see of a Gemini tool call", () => {
  const decode = (toolCall: Record<string, unknown>) =>
    acpStdioV1Adapter.decodeRequest(
      {
        id: 1,
        method: "session/request_permission",
        params: { sessionId: "s", toolCall: { toolCallId: "t", ...toolCall }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] },
      } as never,
      "analyst",
    );

  it("a fetch's url comes from the title: Gemini sends no input", () => {
    const req = decode({ kind: "fetch", title: 'Processing URLs and instructions from prompt: "read https://evil.example/x"' });
    expect(req.args.url).toBe("https://evil.example/x");
  });

  it("a shell command comes from the title", () => {
    expect(decode({ kind: "execute", title: "cat .env" }).args.cmd).toBe("cat .env");
  });

  it("a file comes from its location", () => {
    expect(decode({ kind: "read", title: "notes.txt", locations: [{ path: "/w/.env" }] }).args.path).toBe("/w/.env");
  });
});
