import {
  bus as defaultBus,
  type EventBus,
  type ForemanEventMap,
} from "./event-bus.js";

export interface ApprovalRequest {
  requestId: string;
  sourceAgent: string;
  targetAgent?: string;
  targetTool?: string;
  args: unknown;
  riskScore: number;
  riskReasons: string[];
  context?: string;
}

export interface ApprovalDecision {
  decision: "allowed" | "denied";
  remember?: "allow" | "deny";
}

export interface ApprovalService {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export class DenyAllApprovalService implements ApprovalService {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return { decision: "denied" };
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export interface ReadlineApprovalOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
  bus?: EventBus<ForemanEventMap>;
}

export class ReadlineApprovalService implements ApprovalService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ReadlineApprovalOptions = {}) {
    this.bus = opts.bus ?? defaultBus;
    this.timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const input = this.opts.input ?? process.stdin;
    const output = this.opts.output ?? process.stdout;
    const useColor = (output as { isTTY?: boolean }).isTTY === true;

    output.write(renderPrompt(req, useColor));
    const reader = new LineReader(input, this.timeoutMs);
    try {
      output.write("> ");
      const first = await reader.nextLine();
      if (first === null) {
        return this.resolve(req, { decision: "denied" }, "timeout");
      }
      const key = first.trim().toLowerCase();
      if (key === "a")
        return this.resolve(req, { decision: "allowed" }, "user");
      if (key === "r") {
        output.write(rememberHint(useColor));
        output.write("> ");
        const second = await reader.nextLine();
        if (second === null) {
          return this.resolve(req, { decision: "denied" }, "timeout");
        }
        const c = second.trim().toLowerCase();
        if (c === "a") {
          return this.resolve(
            req,
            { decision: "allowed", remember: "allow" },
            "user",
          );
        }
        return this.resolve(
          req,
          { decision: "denied", remember: "deny" },
          "user",
        );
      }
      return this.resolve(req, { decision: "denied" }, "user");
    } finally {
      reader.dispose();
    }
  }

  private resolve(
    req: ApprovalRequest,
    decision: ApprovalDecision,
    resolvedBy: "user" | "timeout",
  ): ApprovalDecision {
    this.bus.emit("approval:resolved", {
      requestId: req.requestId,
      decision: decision.decision,
      remember: decision.remember,
      resolvedBy,
    });
    return decision;
  }
}

export interface BusApprovalOptions {
  timeoutMs?: number;
  bus?: EventBus<ForemanEventMap>;
}

export class BusApprovalService implements ApprovalService {
  private readonly bus: EventBus<ForemanEventMap>;
  private readonly timeoutMs: number;

  constructor(opts: BusApprovalOptions = {}) {
    this.bus = opts.bus ?? defaultBus;
    this.timeoutMs = opts.timeoutMs ?? envTimeoutMs() ?? DEFAULT_TIMEOUT_MS;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      let settled = false;
      const off = this.bus.on("approval:resolved", (e) => {
        if (e.requestId !== req.requestId) return;
        finish({ decision: e.decision, remember: e.remember });
      });
      const timer = setTimeout(() => {
        finish({ decision: "denied" }, true);
      }, this.timeoutMs);
      const finish = (
        decision: ApprovalDecision,
        fromTimeout = false,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        if (fromTimeout) {
          this.bus.emit("approval:resolved", {
            requestId: req.requestId,
            decision: "denied",
            resolvedBy: "timeout",
          });
        }
        resolve(decision);
      };
    });
  }
}

class LineReader {
  private buffer = "";
  private queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private waiterTimer: NodeJS.Timeout | null = null;
  private wasPaused: boolean;
  private onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        if (this.waiterTimer) {
          clearTimeout(this.waiterTimer);
          this.waiterTimer = null;
        }
        resolve(line);
      } else {
        this.queue.push(line);
      }
    }
  };

  constructor(
    private readonly stream: NodeJS.ReadableStream,
    private readonly timeoutMs: number,
  ) {
    this.wasPaused = stream.isPaused?.() ?? false;
    stream.on("data", this.onData);
    stream.resume?.();
  }

  nextLine(): Promise<string | null> {
    const buffered = this.queue.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.waiterTimer = setTimeout(() => {
        this.waiter = null;
        this.waiterTimer = null;
        resolve(null);
      }, this.timeoutMs);
    });
  }

  dispose(): void {
    this.stream.off("data", this.onData);
    if (this.waiterTimer) {
      clearTimeout(this.waiterTimer);
      this.waiterTimer = null;
    }
    if (this.wasPaused) this.stream.pause?.();
  }
}

function envTimeoutMs(): number | undefined {
  const v = process.env.FOREMAN_APPROVAL_TIMEOUT;
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

function renderPrompt(req: ApprovalRequest, useColor: boolean): string {
  const orange = wrap(useColor, "38;2;255;140;66", "0");
  const yellow = wrap(useColor, "38;2;255;197;66", "0");
  const dim = wrap(useColor, "2", "22");
  const bold = wrap(useColor, "1", "22");

  const divider = "═".repeat(60);
  const flow = req.targetAgent
    ? `${orange(req.sourceAgent)} → ${orange(req.targetAgent)}`
    : `${orange(req.sourceAgent)}`;
  const toolLine = req.targetTool
    ? `  ${bold(req.targetTool)}(${renderArgs(req.args)})`
    : "  (no tool specified)";
  const reasons = req.riskReasons.length
    ? req.riskReasons.map((r) => `    ${dim("◆")} ${r}`).join("\n")
    : `    ${dim("(no flagged reasons)")}`;

  return (
    "\n" +
    `${dim(divider)}\n` +
    `   ___\n` +
    `  (o.o)  ${yellow("⚠ Approval Required")}${pad(yellow(`risk: ${req.riskScore}`), 60)}\n` +
    `   \\_/\n` +
    `\n` +
    `  ${flow}\n` +
    `${toolLine}\n` +
    `\n` +
    `  Reasons:\n` +
    `${reasons}\n` +
    `\n` +
    `${dim(divider)}\n` +
    `[${orange("a")}]llow once  [${orange("d")}]eny  [${orange("r")}]emember rule  ${dim("(default deny on timeout)")}\n`
  );
}

function rememberHint(useColor: boolean): string {
  const orange = wrap(useColor, "38;2;255;140;66", "0");
  const dim = wrap(useColor, "2", "22");
  return `${dim("Remember as")}: [${orange("a")}]llways allow  [${orange("d")}]eny always\n`;
}

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function wrap(useColor: boolean, open: string, close: string) {
  return (text: string): string =>
    useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}

function pad(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const padding = Math.max(0, width - visible.length - 16);
  return " ".repeat(padding) + text;
}
