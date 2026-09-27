// Minimal WebSocket surface used by the Slack Socket Mode and Discord
// Gateway listeners. Production uses Node's built-in WebSocket (Node 22+),
// so no dependency is added; tests pass an in-memory socket.

export interface SocketMessageEvent {
  data: unknown;
}

export interface SocketCloseEvent {
  code: number;
  reason: string;
}

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: SocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (ev: SocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export interface TrackedSocket {
  socket: SocketLike;
  /** Resolves when the socket is closed, or given up on. */
  closed: Promise<SocketCloseEvent>;
  /** Close from our side. A peer that never answers the close handshake
   *  (a dead link) would leave the socket CLOSING forever, so `closed`
   *  resolves after `graceMs` regardless. */
  close(code: number, reason: string): void;
}

export function trackSocket(socket: SocketLike, graceMs = 2_000): TrackedSocket {
  let finish: (ev: SocketCloseEvent) => void = () => {};
  const closed = new Promise<SocketCloseEvent>((resolve) => {
    let done = false;
    finish = (ev) => {
      if (done) return;
      done = true;
      resolve(ev);
    };
  });
  socket.addEventListener("close", (ev) => finish({ code: ev.code, reason: ev.reason }));
  socket.addEventListener("error", () => {
    // An error is normally followed by close; this covers a socket that
    // never opened and never closes.
    setTimeout(() => finish({ code: 1006, reason: "error" }), 1_000).unref?.();
  });
  return {
    socket,
    closed,
    close(code, reason) {
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
      setTimeout(() => finish({ code, reason }), graceMs).unref?.();
    },
  };
}

export function messageText(ev: SocketMessageEvent): string | null {
  if (typeof ev.data === "string") return ev.data;
  if (ev.data instanceof ArrayBuffer) return Buffer.from(ev.data).toString("utf8");
  if (Buffer.isBuffer(ev.data)) return ev.data.toString("utf8");
  return null;
}
