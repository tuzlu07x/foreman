import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  splitting: false,
  sourcemap: true,
  shims: false,
  onSuccess:
    'chmod +x dist/cli/index.js && rm -rf dist/db/migrations && mkdir -p dist/db && cp -R src/db/migrations dist/db/migrations',
})
