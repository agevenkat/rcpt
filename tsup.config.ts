import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // The GitHub Action ships as one committed file with everything bundled.
    entry: { index: 'action/src/main.ts' },
    outDir: 'action/dist',
    format: ['esm'],
    target: 'node22',
    clean: true,
    noExternal: [/.*/],
  },
]);
