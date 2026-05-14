#!/usr/bin/env node
import { exec as packagePkg } from "@yao-pkg/pkg";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const OUT_DIR = join(REPO_ROOT, "dist-binaries");
const MAX_BYTES = 80 * 1024 * 1024;

const SHORT_TO_PKG = new Map([
  ["darwin-arm64", "node20-macos-arm64"],
  ["darwin-x64", "node20-macos-x64"],
  ["linux-x64", "node20-linux-x64"],
  ["linux-arm64", "node20-linux-arm64"],
]);

const RENAME = new Map([
  ["macos-arm64", "darwin-arm64"],
  ["macos-x64", "darwin-x64"],
  ["linux-x64", "linux-x64"],
  ["linux-arm64", "linux-arm64"],
]);

async function main() {
  const argv = process.argv.slice(2);
  const explicit = argv.length > 0 ? argv : null;
  const targets = explicit
    ? explicit.map((t) => {
        const pkg = SHORT_TO_PKG.get(t) ?? t;
        if (!pkg.startsWith("node20-")) {
          throw new Error(`unknown target: ${t}`);
        }
        return pkg;
      })
    : [...SHORT_TO_PKG.values()];

  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    if (f.startsWith("foreman-")) rmSync(join(OUT_DIR, f));
  }

  console.log(`Building foreman binaries (${targets.length} target(s))…`);
  await packagePkg([
    ENTRY,
    "--targets",
    targets.join(","),
    "--out-path",
    OUT_DIR,
    "--config",
    join(REPO_ROOT, "package.json"),
  ]);

  for (const f of readdirSync(OUT_DIR)) {
    const m = f.match(/^index-(macos|linux)-(arm64|x64)(\.exe)?$/);
    if (m) {
      const os = m[1];
      const arch = m[2];
      const short = `${os === "macos" ? "darwin" : "linux"}-${arch}`;
      const dest = join(OUT_DIR, `foreman-${short}`);
      rmSync(dest, { force: true });
      // Some pkg builds emit `index-<os>-<arch>`; rename them.
      const { renameSync } = await import("node:fs");
      renameSync(join(OUT_DIR, f), dest);
    }
  }
  void RENAME;

  console.log("");
  let failed = false;
  for (const f of readdirSync(OUT_DIR)) {
    if (!f.startsWith("foreman-")) continue;
    const path = join(OUT_DIR, f);
    const size = statSync(path).size;
    const mb = (size / 1024 / 1024).toFixed(1);
    const within = size <= MAX_BYTES;
    console.log(`  ${within ? "✓" : "✗"} ${f.padEnd(22)} ${path}  (${mb} MB)`);
    if (!within) failed = true;
  }
  if (failed) {
    console.error("");
    console.error(
      `error: at least one binary is over the ${MAX_BYTES / 1024 / 1024} MB budget`,
    );
    process.exit(1);
  }
  console.log("");
  console.log("done. binaries in dist-binaries/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
