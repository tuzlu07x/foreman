import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "cli/index": "src/cli/index.ts" },
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: false,
  treeshake: true,
  minify: false,
  onSuccess:
    "chmod +x dist/cli/index.js && mkdir -p dist/db/migrations/meta && cp src/db/migrations/*.sql dist/db/migrations/ && cp src/db/migrations/meta/*.json dist/db/migrations/meta/",
});
