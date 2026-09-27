#!/usr/bin/env node
// Builds the standalone `foreman` binary for the machine it runs on:
//
//   npm run build && node scripts/build-binaries.mjs [darwin-arm64|darwin-x64|linux-x64|linux-arm64]
//
// The binary is a Node.js single executable application (SEA) on the
// official Node.js build (full ICU, which Ink's text layout needs; pkg's
// own small-ICU base binaries crash the TUI). Steps:
//
//   1. Bundle dist/cli/index.js and every dependency into one ESM file
//      (tsup/esbuild). Node built-ins become `require()` calls, better-sqlite3's
//      `bindings()` lookup loads the addon from the runtime dir, and
//      `import.meta.url` points at that dir (see scripts/sea-runtime.cjs).
//   2. Wrap it in a CommonJS main script: the runtime prologue, the files
//      it writes out (migrations, registry, mascot art, the native addon),
//      then the bundle inside an async function, which keeps the top-level
//      awaits in Ink and yoga-layout working.
//   3. Check the script with `node --check` and run `--version` on it.
//   4. `pkg --sea` downloads the official Node.js binary for this host
//      (same version as the Node running this script, SHA-256 checked
//      against nodejs.org's SHASUMS256.txt), injects the script with
//      postject and ad-hoc signs it on macOS.
//
// The native addon comes from this machine's node_modules, so a binary can
// only be built for the platform and architecture it is built on.

import { exec as pkgExec } from "@yao-pkg/pkg";
import { build } from "tsup";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist");
const ENTRY = join(DIST, "cli", "index.js");
const STAGE = join(REPO_ROOT, "build", "sea");
const OUT_DIR = join(REPO_ROOT, "dist-binaries");
const RUNTIME_SRC = join(REPO_ROOT, "scripts", "sea-runtime.cjs");
const ADDON_SRC = join(REPO_ROOT, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

// The official Node.js 22 binary is ~119 MB on linux-x64 and Foreman adds
// ~8 MB. The budget catches an accidental second copy of Node or a runaway
// bundle, not normal growth.
const MAX_BYTES = 160 * 1024 * 1024;

const LABELS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

/** dist/ files the CLI reads next to itself, by path relative to dist/. */
const DATA_DIRS = ["db/migrations", "registry", "assets/mascot"];

function hostLabel() {
  return `${process.platform}-${process.arch}`;
}

function parseArgs(argv) {
  const host = hostLabel();
  if (argv.length > 1) throw new Error("usage: build-binaries.mjs [<label>]  (one target per run)");
  const label = argv[0] ?? host;
  if (!LABELS.includes(label)) throw new Error(`unknown target '${label}' (expected one of ${LABELS.join(", ")})`);
  if (label !== host) {
    throw new Error(
      `cannot build ${label} on ${host}: the binary embeds this machine's better-sqlite3 addon, ` +
        `so each target has to be built on its own platform and architecture`,
    );
  }
  return label;
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out.sort();
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** The files the runtime prologue writes out, with their hashes. */
function collectPayload(version) {
  const files = [];
  const add = (relPath, abs, mode) => {
    const data = readFileSync(abs);
    files.push({ path: relPath, sha256: sha256(data), mode, data: data.toString("base64") });
  };
  for (const d of DATA_DIRS) {
    const abs = join(DIST, d);
    if (!existsSync(abs)) throw new Error(`missing ${relative(REPO_ROOT, abs)}; run \`npm run build\` first`);
    for (const f of listFiles(abs)) add(relative(DIST, f).split(sep).join("/"), f, 0o644);
  }
  if (!existsSync(ADDON_SRC)) throw new Error(`missing ${relative(REPO_ROOT, ADDON_SRC)}; run \`npm ci\` first`);
  add("lib/better_sqlite3.node", ADDON_SRC, 0o755);
  const digest = sha256(files.map((f) => `${f.path}\0${f.sha256}\n`).join(""));
  return { version, digest, files };
}

const BUILTIN_RE = new RegExp(
  `^(?:node:.+|${builtinModules.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`,
);

/** esbuild plugin: see the header comment, step 1. */
function seaPlugin() {
  return {
    name: "foreman-sea",
    setup(b) {
      // Built-ins: a CommonJS shim per module, so the output has no
      // `import` statements left and runs as a SEA's CommonJS main.
      b.onResolve({ filter: BUILTIN_RE }, (args) =>
        args.namespace === "sea-builtin"
          ? { path: args.path, external: true }
          : { path: args.path.startsWith("node:") ? args.path : `node:${args.path}`, namespace: "sea-builtin" },
      );
      b.onLoad({ filter: /.*/, namespace: "sea-builtin" }, (args) => ({
        contents: `module.exports = require(${JSON.stringify(args.path)});`,
        loader: "js",
      }));
      // better-sqlite3 finds its addon through `bindings`, which searches
      // node_modules on disk. Load it from the runtime dir instead.
      b.onResolve({ filter: /^bindings$/ }, () => ({ path: "bindings", namespace: "sea-addon" }));
      b.onLoad({ filter: /.*/, namespace: "sea-addon" }, () => ({
        contents: "module.exports = function bindings(name) { return __foremanSea.loadAddon(name); };",
        loader: "js",
      }));
      // Optional packages that aren't installed, so npm installs lack them
      // too: Ink's React DevTools hook (behind `import.meta.resolve`, which
      // throws in the binary) and ws's native speed-ups (behind a
      // try/catch). They fail the way a missing module does.
      b.onResolve({ filter: /^(?:react-devtools-core|bufferutil|utf-8-validate)$/ }, (args) => ({
        path: args.path,
        namespace: "sea-missing",
      }));
      b.onLoad({ filter: /.*/, namespace: "sea-missing" }, (args) => ({
        contents: `throw Object.assign(new Error(${JSON.stringify(`Cannot find module '${args.path}'`)}), { code: "MODULE_NOT_FOUND" });`,
        loader: "js",
      }));
    },
  };
}

async function bundle() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  await build({
    config: false,
    entry: { bundle: ENTRY },
    outDir: STAGE,
    outExtension: () => ({ js: ".mjs" }),
    format: ["esm"],
    platform: "node",
    target: "node22",
    bundle: true,
    noExternal: [/.*/],
    removeNodeProtocol: false,
    splitting: false,
    treeshake: false,
    minify: false,
    sourcemap: false,
    shims: false,
    dts: false,
    clean: false,
    metafile: true,
    silent: true,
    esbuildPlugins: [seaPlugin()],
    define: {
      "import.meta.url": "__foremanSea.metaUrl",
      "import.meta.resolve": "__foremanSea.resolve",
    },
  });
  const code = readFileSync(join(STAGE, "bundle.mjs"), "utf8").replace(/^#!.*\n/, "");
  const meta = JSON.parse(readFileSync(join(STAGE, "metafile-esm.json"), "utf8"));

  // A SEA main script can only `require()` built-ins: nothing else may be
  // left outside the bundle, and no `import` statement or `import()`. (A
  // leftover `import.meta` is a syntax error, which `node --check` catches.)
  const problems = [];
  for (const output of Object.values(meta.outputs)) {
    for (const imp of output.imports ?? []) {
      if (!imp.external) continue;
      if (imp.kind !== "require-call" || !imp.path.startsWith("node:")) problems.push(`${imp.kind} ${imp.path}`);
    }
  }
  if (problems.length > 0) throw new Error(`bundle is not self-contained:\n  ${problems.join("\n  ")}`);
  return code;
}

function wrap(bundleCode, payload) {
  const runtime = readFileSync(RUNTIME_SRC, "utf8");
  return [
    '"use strict";',
    "// Foreman standalone binary main script. Generated by scripts/build-binaries.mjs.",
    "const __foremanSeaRuntime = (function () {",
    "  const module = { exports: {} };",
    "  const exports = module.exports;",
    runtime,
    "  return module.exports;",
    "})();",
    `const __foremanSea = __foremanSeaRuntime.boot(${JSON.stringify(payload)});`,
    'if (__foremanSea.mode === "cli") {',
    "  (async () => {",
    bundleCode,
    "  })().catch((err) => {",
    "    // Same as a rejected top-level await under `node dist/cli/index.js`.",
    "    process.nextTick(() => {",
    "      throw err;",
    "    });",
    "  });",
    "}",
    "",
  ].join("\n");
}

/** Run the main script under plain Node before baking it into a binary. */
function preflight(mainPath, version) {
  const scratch = mkdtempSync(join(tmpdir(), "foreman-sea-preflight-"));
  try {
    execFileSync(process.execPath, ["--check", mainPath], { stdio: "inherit" });
    const out = execFileSync(process.execPath, [mainPath, "--version"], {
      cwd: scratch,
      env: { ...process.env, FOREMAN_HOME: join(scratch, "home"), FOREMAN_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
    }).trim();
    if (out !== version) throw new Error(`preflight: --version printed '${out}', expected '${version}'`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const label = parseArgs(process.argv.slice(2));
  if (!existsSync(ENTRY)) throw new Error("missing dist/cli/index.js; run `npm run build` first");
  const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const [os, arch] = label.split("-");
  const target = `node${process.versions.node}-${os === "darwin" ? "macos" : os}-${arch}`;
  const outPath = join(OUT_DIR, `foreman-${label}`);

  console.log(`Building foreman ${version} for ${label} (Node.js ${process.versions.node} SEA)…`);
  const bundleCode = await bundle();
  const payload = collectPayload(version);
  const mainPath = join(STAGE, "foreman.cjs");
  writeFileSync(mainPath, wrap(bundleCode, payload));
  console.log(`  main script  ${relative(REPO_ROOT, mainPath)}  (${(statSync(mainPath).size / 1024 / 1024).toFixed(1)} MB)`);
  preflight(mainPath, version);
  console.log("  preflight    ok");

  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(outPath, { force: true });
  await pkgExec([mainPath, "--sea", "--targets", target, "--output", outPath]);
  if (!existsSync(outPath)) throw new Error(`pkg did not write ${outPath}`);
  if (os === "darwin") {
    // pkg only warns when ad-hoc signing fails; macOS kills an arm64
    // binary without a valid signature, so fail here instead.
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", outPath], { stdio: "inherit" });
  }

  const built = readFileSync(outPath);
  const size = built.length;
  const digest = sha256(built);
  console.log("");
  console.log(`  ${size <= MAX_BYTES ? "✓" : "✗"} ${relative(REPO_ROOT, outPath)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`    sha256 ${digest}`);
  if (size > MAX_BYTES) {
    console.error(`error: over the ${MAX_BYTES / 1024 / 1024} MB budget`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
