import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The cores' published exports point node at dist/; tests must resolve their
// TypeScript source so a fresh clone is testable without a prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@gatewarden/score': fileURLToPath(new URL('../score/src/index.ts', import.meta.url)),
      '@gatewarden/govern': fileURLToPath(new URL('../govern/src/index.ts', import.meta.url)),
    },
  },
});
