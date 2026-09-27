import type { Key } from "ink";
import type { WizardContext } from "./context.js";

/** Notice shown when Ctrl-C is pressed while agents are installing. */
export const INSTALL_QUIT_NOTICE =
  "Install in progress — Ctrl-C again after it finishes";

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
 * installed: nothing starts or aborts, a one-line notice explains, and
 * Ctrl-C quits normally once the install has finished (Done screen).
 */
export function handleCtrlC(ctx: WizardContext): void {
  if (ctx.currentStep === "install") {
    ctx.set.setInstallQuitNotice(true);
    return;
  }
  ctx.quit();
}
