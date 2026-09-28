import { randomInt } from "node:crypto";

// =============================================================================
// Chat confirmation codes (`/integration remove jira confirm K7Q2PX`)
// =============================================================================
//
// Removing an integration from chat takes two messages: the first returns a
// code, the second repeats the command with it. A code is random,
// single-use, expires after two minutes, and is bound to the surface, the
// user, the action and the server: a code issued to one person for one
// integration can't confirm anything else. Any mismatch burns it. Codes live
// in memory in `foreman start` only.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const CODE_LENGTH = 6;
export const CONFIRMATION_TTL_MS = 120_000;

export interface ConfirmationScope {
  surface: string;
  user: string;
  action: string;
  server: string;
}

interface Pending extends ConfirmationScope {
  expiresAt: number;
}

export class ConfirmationStore {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(scope: ConfirmationScope): string {
    this.sweep();
    // One live code per scope: a new request replaces the old one.
    for (const [code, p] of this.pending) if (sameScope(p, scope)) this.pending.delete(code);
    let code = "";
    do {
      code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    } while (this.pending.has(code));
    this.pending.set(code, { ...scope, expiresAt: this.now() + CONFIRMATION_TTL_MS });
    return code;
  }

  /** True once for the right code and scope; the code is used up either way. */
  consume(code: string, scope: ConfirmationScope): boolean {
    this.sweep();
    const key = code.trim().toUpperCase();
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    return sameScope(pending, scope) && pending.expiresAt > this.now();
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(code);
  }
}

function sameScope(a: ConfirmationScope, b: ConfirmationScope): boolean {
  return a.surface === b.surface && a.user === b.user && a.action === b.action && a.server === b.server;
}
