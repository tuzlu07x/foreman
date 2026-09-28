import type { PolicyLoadError } from "../core/policy-load.js";
import { dim, red } from "./colors.js";

/** The friendly policy.yaml error every command prints (#657). */
export function printPolicyLoadError(err: PolicyLoadError): void {
  console.error(red("error: ") + err.message);
  console.error(dim(`  → Open ${err.path} and fix it (YAML validators online help), then run the command again.`));
}
