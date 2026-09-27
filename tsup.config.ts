import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "cli/index": "src/cli/index.ts", "cli/hook": "src/cli/hook-main.ts" },
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
