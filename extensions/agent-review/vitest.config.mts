import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@editor/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // A backstop for a hang: a machine paused for minutes (VM snapshots, a laptop lid) would otherwise fire it.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
