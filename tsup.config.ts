import { defineConfig } from 'tsup';
export default defineConfig([
  { entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, clean: true, sourcemap: true, target: 'node20' },
  { entry: ['src/cli.ts'], format: ['esm'], target: 'node20', banner: { js: '#!/usr/bin/env node' } },
]);
