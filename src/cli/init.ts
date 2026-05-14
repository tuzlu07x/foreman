import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { closeDb, getDb } from "../db/client.js";
import { loadOrCreateMasterKey } from "../identity/keypair.js";
import { getForemanPaths, type ForemanPaths } from "../utils/config.js";
import { legacyHasInterestingFiles } from "../utils/migrate-config.js";
import { bold, dim, green, orange, red } from "./colors.js";
import { DEFAULT_POLICY_YAML } from "./policy-template.js";

export interface InitOptions {
  resetPolicy?: boolean;
}

export interface InitResult {
  paths: ForemanPaths;
  publicKey: Buffer;
  identityWasNew: boolean;
  policyWasNew: boolean;
  policyWasReset: boolean;
}

/** Pure logic — no console output, no process.exit. CLI action wraps this. */
export function runInit(options: InitOptions = {}): InitResult {
  const paths = getForemanPaths();
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  const identityWasNew = !existsSync(paths.identityPath);
  const { publicKey } = loadOrCreateMasterKey();
  const policyExisted = existsSync(paths.policyPath);
  const policyWasNew = !policyExisted;
  const policyWasReset = policyExisted && options.resetPolicy === true;
  if (policyWasNew || policyWasReset) {
    writeFileSync(paths.policyPath, DEFAULT_POLICY_YAML);
  }
  getDb();
  closeDb();
  return { paths, publicKey, identityWasNew, policyWasNew, policyWasReset };
}

export const initCommand = new Command("init")
  .description("Initialise ~/.foreman/ (identity, policy, database)")
  .option(
    "--reset-policy",
    "overwrite policy.yaml with the smart-default template",
  )
  .action((options: InitOptions) => {
    if (legacyHasInterestingFiles()) {
      console.error(
        red("warn: ") +
          "found a legacy ~/.foreman/ install with config or state files. Run 'foreman migrate-config' before you keep going — this init will write to the new platform-native dirs and ignore the legacy ones.",
      );
    }
    const { paths, publicKey, identityWasNew, policyWasNew, policyWasReset } =
      runInit(options);
    const fp = publicKey.subarray(0, 4).toString("hex");
    const policyTag = policyWasNew
      ? "(template)"
      : policyWasReset
        ? "(reset to template)"
        : "(kept)";
    console.log(`${orange(bold("Foreman"))} initialised`);
    console.log();
    console.log(
      `  ${green("✓")} identity   ${paths.identityPath} ${dim(`(ed25519:${fp}…${identityWasNew ? ", new" : ", reused"})`)}`,
    );
    console.log(
      `  ${green("✓")} policy     ${paths.policyPath} ${dim(policyTag)}`,
    );
    console.log(`  ${green("✓")} database   ${paths.dbPath}`);
    console.log();
    if (!policyWasNew && !policyWasReset) {
      console.log(
        dim(
          "Tip: run 'foreman policy reset' (or 'foreman init --reset-policy') to overwrite policy.yaml with the latest defaults.",
        ),
      );
    }
    console.log(
      dim(
        "Next: run 'foreman setup' to configure agents and keys in 5 minutes, or 'foreman start' to boot straight to the TUI.",
      ),
    );
  });
