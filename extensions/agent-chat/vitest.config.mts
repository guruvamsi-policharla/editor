import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@editor/acp-client': fileURLToPath(new URL('../../packages/acp-client/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
