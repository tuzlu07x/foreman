import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "cli/hook": "src/cli/hook-main.ts",
    "cli/hook-inproc": "src/cli/hook-inproc.ts",
    "cli/env-preflight": "src/cli/env-preflight.ts",
  },
  // Kept as a separate file so its import stays first in index.js and runs
  // before chalk / Ink read the environment (see env-preflight.ts).
  // hook-inproc.js: the hook's mediation stack, loaded by dist/cli/hook.js
  // only when no daemon answers (#616).
  external: ["./env-preflight.js", "./hook-inproc.js"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: false,
  treeshake: true,
  minify: false,
  onSuccess:
    "chmod +x dist/cli/index.js dist/cli/hook.js && mkdir -p dist/db/migrations/meta && cp src/db/migrations/*.sql dist/db/migrations/ && cp src/db/migrations/meta/*.json dist/db/migrations/meta/ && mkdir -p dist/assets/mascot && cp assets/mascot/terminal-*.png dist/assets/mascot/ && rm -rf dist/registry && mkdir -p dist/registry && cp -R registry/. dist/registry/",
});
