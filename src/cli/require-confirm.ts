import { createInterface } from "node:readline";
import { red } from "./colors.js";

// =============================================================================
// requireConfirm + requireTty — shared TTY guards for destructive CLI commands
// =============================================================================
//
// The same shape was duplicated across 7 destructive commands during the QA
// round-1 fixes (#260 secrets remove, #268 policy reset/edit, #272 agent
// remove/regenerate-key, #274 identity reset/edit). Extracting it here so
// the next destructive command we add doesn't have to remember every part.
//
// Two helpers:
//   - requireConfirm(): commands with a --yes flag — prompt in TTY, refuse
//     loudly in non-TTY unless --yes was passed.
//   - requireTty():     commands without a --yes equivalent (editor sessions
//     in particular) — refuse upfront if either stdin OR stdout isn't a TTY.

export interface RequireConfirmOptions {
  /** Caller's --yes flag, if any. */
  yes?: boolean;
  /** The y/N question to render in TTY contexts (no trailing colon or `?`
   *  — we append `[y/N]` ourselves). */
  question: string;
  /** Used in the non-TTY refusal message: `refusing to <noun> in a
   *  non-interactive context.` Keep it as a verb phrase + object. */
  noun: string;
}

/**
 * Confirm a destructive operation:
 * - When `yes === true`, returns `true` immediately (the caller can proceed).
 * - In a TTY context, prompts the user with `<question> [y/N]`. Returns
 *   true on "y" / "yes", false otherwise.
 * - In a non-TTY context without --yes, prints the standardised refusal
 *   message and exits 1 (does NOT return).
 *
 * The action handler does its existence checks BEFORE calling this — that
 * pattern (validate then confirm) was set in #260 and we keep it consistent.
 */
export async function requireConfirm(
  opts: RequireConfirmOptions,
): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.error(
      red("error: ") +
        `refusing to ${opts.noun} in a non-interactive context. Pass --yes to confirm.`,
    );
    process.exit(1);
  }
  return promptYesNo(`${opts.question} [y/N]`);
}

export interface RequireTtyOptions {
  /** The user-facing command name, e.g. "policy edit". */
  command: string;
  /** Optional path the user can edit by hand instead. Surfaces a "→ open
   *  the file directly:" hint. */
  fallbackPath?: string;
}

/**
 * Refuse a command that has no scripted equivalent (an editor session, an
 * interactive wizard) when stdin OR stdout isn't a TTY. Exits 1 with a
 * friendly message; returns nothing otherwise.
 */
export function requireTty(opts: RequireTtyOptions): void {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  console.error(
    red("error: ") +
      `'${opts.command}' requires an interactive terminal — open the file directly:`,
  );
  if (opts.fallbackPath) {
    console.error(`       ${opts.fallbackPath}`);
  }
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Internal: y/N prompt
// -----------------------------------------------------------------------------

async function promptYesNo(question: string): Promise<boolean> {
  // Already gated by the isTTY check above — this is the live prompt path.
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
