import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    alias: {
      '@lumalink/core/node': fileURLToPath(
        new URL('./packages/core/src/platform/node/index.ts', import.meta.url),
      ),
      '@lumalink/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
});
