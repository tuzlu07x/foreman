import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

// =============================================================================
// Minimal SMTP client (RFC 5321) for the email notification channel
// =============================================================================
//
// Foreman only ever *sends* short plain-text alerts, so a dependency-free
// client covering the common submission setups is enough:
//   - implicit TLS (port 465 — Gmail, Fastmail, iCloud, …)
//   - STARTTLS    (port 587 — Outlook/Office 365, most providers)
//   - plain       (localhost relays / tests only; AUTH is refused off-box)
// with AUTH PLAIN or AUTH LOGIN. Header values are validated so text from
// an agent can never inject extra headers or recipients.

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpOptions {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  from: string;
  to: string[];
  /** EHLO name. Defaults to "foreman.localhost". */
  clientName?: string;
  timeoutMs?: number;
  /** Extra TLS options (tests pin a self-signed CA here). */
  tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean };
}

export interface MailMessage {
  subject: string;
  text: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    public readonly code: number | null = null,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

const ADDRESS_RE = /^[^\s<>@,;:"()[\]\\]+@[^\s<>@,;:"()[\]\\]+\.[^\s<>@,;:"()[\]\\]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertSafeAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) throw new SmtpError(`invalid email address: ${JSON.stringify(address)}`);
}

export async function sendMail(opts: SmtpOptions, message: MailMessage): Promise<void> {
  assertSafeAddress(opts.from);
  if (opts.to.length === 0) throw new SmtpError("no recipients configured");
  for (const to of opts.to) assertSafeAddress(to);
  if (/[\r\n]/.test(message.subject)) throw new SmtpError("subject must be a single line");
  if (opts.username && opts.security === "none" && !LOCAL_HOSTS.has(opts.host)) {
    throw new SmtpError(
      "refusing to send SMTP credentials over an unencrypted connection — use security: tls or starttls",
    );
  }

  const session = await SmtpSession.open(opts);
  try {
    await session.expect([220]);
    let caps = await session.ehlo();
    if (opts.security === "starttls") {
      if (!caps.has("STARTTLS")) throw new SmtpError("server does not offer STARTTLS");
      await session.command("STARTTLS", [220]);
      await session.upgradeToTls();
      caps = await session.ehlo();
    }
    if (opts.username) await session.authenticate(caps, opts.username, opts.password ?? "");
    await session.command(`MAIL FROM:<${opts.from}>`, [250]);
    for (const to of opts.to) await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command("DATA", [354]);
    await session.command(`${buildMessage(opts, message)}\r\n.`, [250]);
    await session.command("QUIT", [221]).catch(() => undefined);
  } finally {
    session.close();
  }
}

/** RFC 5322 message with a base64 body (7-bit safe for any server). */
export function buildMessage(opts: Pick<SmtpOptions, "from" | "to" | "host">, message: MailMessage): string {
  const domain = opts.from.split("@")[1] ?? "foreman.localhost";
  const headers = [
    `From: Foreman <${opts.from}>`,
    `To: ${opts.to.join(", ")}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  const body = Buffer.from(message.text.replace(/\r?\n/g, "\r\n"), "utf-8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
  // base64 never starts a line with ".", so no dot-stuffing is needed; kept
  // for the headers anyway in case a future header begins with one.
  return [...headers, "", body].map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

class SmtpSession {
  private buffer = "";
  private waiter: ((lines: string[]) => void) | null = null;
  private failure: Error | null = null;
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private socket: Socket | TLSSocket,
    private readonly opts: SmtpOptions,
  ) {
    this.attach(socket);
  }

  static async open(opts: SmtpOptions): Promise<SmtpSession> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const s =
        opts.security === "tls"
          ? tlsConnect({ host: opts.host, port: opts.port, servername: opts.host, ...(opts.tls ?? {}) }, () =>
              resolve(s),
            )
          : netConnect({ host: opts.host, port: opts.port }, () => resolve(s));
      s.once("error", reject);
      s.setTimeout(timeoutMs, () => {
        s.destroy();
        reject(new SmtpError(`connection to ${opts.host}:${opts.port} timed out`));
      });
    });
    return new SmtpSession(socket, opts);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new SmtpError("connection closed by server")));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024) {
      this.fail(new SmtpError("oversized SMTP response"));
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.pending.push(line);
      // "250-…" continues a multi-line reply; "250 …" (or bare "250") ends it.
      if (/^\d{3}(?: |$)/.test(line)) {
        const lines = this.pending;
        this.pending = [];
        const waiter = this.waiter;
        this.waiter = null;
        waiter?.(lines);
      }
    }
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.([]);
  }

  private read(): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timeoutMs = this.opts.timeoutMs ?? 20_000;
      this.timer = setTimeout(() => {
        this.fail(new SmtpError("SMTP server did not answer in time"));
      }, timeoutMs);
      this.waiter = (lines) => {
        if (this.timer) clearTimeout(this.timer);
        if (this.failure && lines.length === 0) reject(this.failure);
        else resolve(lines);
      };
    });
  }

  async expect(codes: number[]): Promise<string[]> {
    const lines = await this.read();
    const last = lines[lines.length - 1] ?? "";
    const code = Number.parseInt(last.slice(0, 3), 10);
    if (!codes.includes(code)) {
      throw new SmtpError(`unexpected SMTP reply: ${last.slice(0, 200)}`, Number.isFinite(code) ? code : null);
    }
    return lines;
  }

  async command(line: string, codes: number[]): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }

  async ehlo(): Promise<Set<string>> {
    const lines = await this.command(`EHLO ${this.opts.clientName ?? "foreman.localhost"}`, [250]);
    const caps = new Set<string>();
    for (const line of lines.slice(1)) caps.add(line.slice(4).toUpperCase());
    for (const line of lines.slice(1)) {
      const m = /^AUTH\s+(.*)$/i.exec(line.slice(4));
      if (m) for (const mech of m[1]!.split(/\s+/)) caps.add(`AUTH=${mech.toUpperCase()}`);
    }
    return caps;
  }

  async upgradeToTls(): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const secure = tlsConnect(
        { socket: plain, servername: this.opts.host, ...(this.opts.tls ?? {}) },
        () => resolve(secure),
      );
      secure.once("error", reject);
    });
    this.attach(this.socket);
  }

  async authenticate(caps: Set<string>, username: string, password: string): Promise<void> {
    if (caps.has("AUTH=PLAIN") || !caps.has("AUTH=LOGIN")) {
      const token = Buffer.from(`\u0000${username}\u0000${password}`, "utf-8").toString("base64");
      await this.command(`AUTH PLAIN ${token}`, [235]);
      return;
    }
    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(username, "utf-8").toString("base64"), [334]);
    await this.command(Buffer.from(password, "utf-8").toString("base64"), [235]);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.socket.removeAllListeners("close");
    this.socket.end();
    this.socket.destroy();
  }
}
