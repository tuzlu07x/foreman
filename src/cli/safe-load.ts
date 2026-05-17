import { ZodError } from "zod";
import { red } from "./colors.js";

// =============================================================================
// safeLoadConfig — friendly failure for user-edited config files (#262)
// =============================================================================
//
// Every CLI command that reads `~/.foreman/llm.yaml`, `notify.yaml`, etc.
// must NOT crash with a raw YAMLParseError stacktrace when the user mistypes
// a colon. This helper wraps the loader, catches the usual parse-time errors
// (yaml's `YAMLParseError`, Zod's `ZodError`), prints a single friendly line
// + remediation, and exits 1.
//
// Usage:
//   const config = safeLoadConfig(paths.llmConfigPath, loadLlmConfig);
//
// Both `loadXConfig` functions can throw a YAMLParseError before Zod ever
// runs OR a ZodError if the YAML parses but doesn't match the schema. Both
// produce useful messages; we extract them without exposing the stack.

export interface SafeLoadOptions {
  /** Label used in the error message ("llm.yaml", "notify.yaml"). Defaults to
   *  the file's basename. */
  label?: string;
}

export function safeLoadConfig<T>(
  path: string,
  loader: (path: string) => T,
  options: SafeLoadOptions = {},
): T {
  const label = options.label ?? basename(path);
  try {
    return loader(path);
  } catch (err) {
    if (err && typeof err === "object" && (err as { name?: string }).name === "YAMLParseError") {
      const e = err as { message?: string };
      console.error(
        red("error: ") +
          `${label} (${path}) failed to parse: ${e.message ?? "invalid YAML"}`,
      );
      console.error(
        `  → Open ${path} and fix the YAML syntax (online validators help).`,
      );
      process.exit(1);
    }
    if (err instanceof ZodError) {
      const issues = err.issues
        .slice(0, 5)
        .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n");
      console.error(
        red("error: ") + `${label} (${path}) is missing or invalid:`,
      );
      console.error(issues);
      if (err.issues.length > 5) {
        console.error(`  (+ ${err.issues.length - 5} more issues)`);
      }
      console.error(`  → Check the field types match the documented schema.`);
      process.exit(1);
    }
    // Unknown error — re-throw so the surrounding command can decide.
    throw err;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
