import type { Key } from "ink";
import type { WizardContext } from "./context.js";

/** Notice shown when Ctrl-C is pressed while agents are installing. */
export const INSTALL_QUIT_NOTICE =
  "Install in progress — Ctrl-C again after it finishes";

/** Notice when the install is paused on a failure prompt: it won't finish
 *  on its own until the user answers it. */
export const INSTALL_PAUSED_QUIT_NOTICE =
  "Install paused on a failure — press [r] retry or [s] skip; Ctrl-C works once it finishes";

/** Which quit notice is true for the install screen right now. */
export function installQuitNoticeText(pendingFailure: boolean): string {
  return pendingFailure ? INSTALL_PAUSED_QUIT_NOTICE : INSTALL_QUIT_NOTICE;
}

/**
 * A letter pressed together with Ctrl or Meta. The wizard's single-letter
 * hotkeys ([s]kip, [c]ontinue, [o]pen, [q]uit, …) must not fire for these:
 * in raw mode Ctrl-C reaches the handlers as input "c" + key.ctrl, and
 * required-setup read it as "[c] continue" — Ctrl-C started the install.
 * Esc and arrow keys arrive with an empty `input`, so they are unaffected.
 */
export function isModifiedLetter(input: string, key: Key): boolean {
  return (key.ctrl || key.meta) && /^[a-z]$/i.test(input);
}

/**
 * Ctrl-C quits through the wizard's normal exit on every screen — except
 * while the installer runs, where quitting would leave agents half
 * installed: nothing starts or aborts and a one-line notice explains.
 * Once the runner has settled (resolved or rejected) and no failure prompt
 * is waiting on the user, Ctrl-C quits normally again.
 */
export function handleCtrlC(ctx: WizardContext): void {
  if (ctx.currentStep === "install") {
    const { installSettled, pendingFailure } = ctx.state;
    const awaitingUser =
      pendingFailure !== null || ctx.failureResolverRef.current !== null;
    if (!installSettled || awaitingUser) {
      ctx.set.setInstallQuitNotice(true);
      return;
    }
  }
  ctx.quit();
}
