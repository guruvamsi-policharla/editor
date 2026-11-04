import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // A backstop for a hang: a machine paused for minutes (VM snapshots, a laptop lid) would otherwise fire it.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
