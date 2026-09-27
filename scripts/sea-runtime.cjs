"use strict";
// Start-up code for the standalone `foreman` binary (a Node.js single
// executable application, built by scripts/build-binaries.mjs).
//
// The npm package runs as `node dist/cli/index.js` next to its files on
// disk. The binary is one file, so before Foreman's own code runs this
// makes it look the same:
//
//   - The files Foreman reads next to itself (database migrations, the
//     bundled registry, the mascot art) and the better-sqlite3 native addon
//     are written once to a private runtime directory in Foreman's cache
//     dir, and checked against their SHA-256 on every start. A missing or
//     changed file makes the whole directory be written again.
//   - `import.meta.url` in the bundle points into that directory, so every
//     `../db/migrations`-style lookup finds the same layout as `dist/`.
//   - Node SEA passes `[binary, argv0, ...args]`. `foreman demo` re-runs
//     the CLI as `process.execPath <script> <command>`; here the "script"
//     is the binary itself, so that argument is dropped. And a script whose
//     `#!` line names this binary (the demo's stand-in agents) is run the
//     way `node <script>` would run it.
//
// Only Node built-ins may be required here: a SEA main script has no
// module resolution. This file is inlined into the binary's main script
// and is also loaded directly by tests/scripts/sea-runtime.test.ts.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const url = require("node:url");

/** The only native addon the binary carries. */
const ADDON = "better_sqlite3.node";

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sameFile(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** The interpreter a `#!` line names, or null. Reads at most 4 KiB. */
function readShebang(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString("utf8").split("\n", 1)[0] ?? "";
    return line.startsWith("#!") ? line.slice(2).trim() : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * What a SEA invocation asks for. `argv` is Node's `process.argv` inside a
 * single executable: `[execPath, argv0, ...args]`.
 *
 *   - `{ mode: "cli", argv }`: run Foreman with this argv (`argv[1]` is the
 *     binary, like the script path under `node`).
 *   - `{ mode: "script", argv }`: run the script `argv[1]` as `node` would.
 */
function classifyInvocation(argv, execPath) {
  let args = argv.slice(2);
  const first = args[0];
  if (first !== undefined && first.includes("/")) {
    if (sameFile(first, execPath)) {
      // `<binary> <binary> <command>`: the CLI re-running itself.
      args = args.slice(1);
    } else {
      const interpreter = readShebang(first);
      if (interpreter !== null && sameFile(interpreter, execPath)) {
        return { mode: "script", argv: [execPath, path.resolve(first), ...args.slice(1)] };
      }
    }
  }
  return { mode: "cli", argv: [execPath, execPath, ...args] };
}

/** Where the runtime directories live: Foreman's own cache dir. Mirrors
 *  `resolveDirs` in src/utils/config.ts. */
function runtimeRoot(env, platform, home) {
  if (env.FOREMAN_HOME) return path.resolve(env.FOREMAN_HOME, "cache", "runtime");
  if (platform === "darwin") return path.resolve(home, "Library", "Caches", "foreman", "runtime");
  return path.resolve(env.XDG_CACHE_HOME || path.join(home, ".cache"), "foreman", "runtime");
}

/** True when `dir` is a directory owned by us that nobody else can write
 *  to, and holds exactly the payload's bytes at real (non-symlinked) paths. */
function verifyDir(dir, files) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o022) !== 0) return false;
    const real = fs.realpathSync(dir);
    for (const f of files) {
      const p = path.join(real, f.path);
      if (fs.realpathSync(p) !== p) return false;
      if (readRegularFile(p) !== f.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** SHA-256 of a regular file, read through one descriptor that never
 *  follows a symlink, so the type check and the bytes are the same file. */
function readRegularFile(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    return sha256(fs.readFileSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

function writeFiles(dir, files) {
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, Buffer.from(f.data, "base64"), { mode: f.mode, flag: "wx" });
  }
}

function removeQuietly(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Make `<root>/<name>` hold the payload and return its path. Writes into a
 * fresh private temp dir first and renames it into place, so a reader
 * never sees a half-written directory and concurrent starts are safe.
 */
function materialize(root, name, files) {
  const target = path.join(root, name);
  if (verifyDir(target, files)) return target;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(root, `.${name}-`));
  try {
    writeFiles(tmp, files);
    if (!verifyDir(tmp, files)) throw new Error(`could not write the runtime files to ${tmp}`);
    try {
      fs.renameSync(tmp, target);
      return target;
    } catch {
      // Another start won the race, or a stale/changed copy is in the way.
      if (verifyDir(target, files)) return target;
      const aside = fs.mkdtempSync(path.join(root, ".stale-"));
      fs.renameSync(target, path.join(aside, "old"));
      removeQuietly(aside);
      fs.renameSync(tmp, target);
      if (!verifyDir(target, files)) throw new Error(`runtime files at ${target} changed while starting`);
      return target;
    }
  } finally {
    removeQuietly(tmp);
  }
}

/** The runtime dir for this payload: Foreman's cache dir, or a private
 *  per-process temp dir (removed on exit) when the cache isn't writable. */
function ensureRuntimeDir(payload, env = process.env, platform = process.platform, home = os.homedir()) {
  const name = `${payload.version}-${payload.digest.slice(0, 16)}`;
  try {
    return materialize(runtimeRoot(env, platform, home), name, payload.files);
  } catch {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-runtime-"));
    process.once("exit", () => removeQuietly(dir));
    writeFiles(dir, payload.files);
    if (!verifyDir(dir, payload.files)) throw new Error(`could not prepare Foreman's runtime files in ${dir}`);
    return dir;
  }
}

function isSea() {
  try {
    return require("node:sea").isSea();
  } catch {
    return false;
  }
}

/**
 * Prepare the process for the bundled CLI. Returns `{ mode: "script" }`
 * when this invocation ran a script instead (see classifyInvocation), else
 * the values the bundle is built against: `metaUrl` for `import.meta.url`,
 * `resolve` for `import.meta.resolve` and `loadAddon` for `bindings()`.
 */
function boot(payload) {
  if (isSea()) {
    const inv = classifyInvocation(process.argv, process.execPath);
    process.argv.splice(0, process.argv.length, ...inv.argv);
    if (inv.mode === "script") {
      require("node:module").runMain();
      return { mode: "script" };
    }
  }
  const dir = ensureRuntimeDir(payload);
  let addon;
  return {
    mode: "cli",
    metaUrl: url.pathToFileURL(path.join(dir, "cli", "index.js")).href,
    resolve(specifier) {
      throw new Error(`Cannot resolve '${specifier}' inside the standalone foreman binary`);
    },
    loadAddon(name) {
      if (name !== ADDON) throw new Error(`the standalone foreman binary has no native addon '${name}'`);
      if (addon === undefined) {
        const mod = { exports: {} };
        process.dlopen(mod, path.join(dir, "lib", ADDON));
        addon = mod.exports;
      }
      return addon;
    },
  };
}

module.exports = { ADDON, boot, classifyInvocation, ensureRuntimeDir, runtimeRoot, verifyDir, sha256 };
