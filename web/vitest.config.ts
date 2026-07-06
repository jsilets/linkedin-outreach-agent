import { defineConfig } from 'vitest/config';

// Server tests only. Kept separate from vite.config.ts (which sets root:
// 'client' for the SPA build) so vitest scans the server/ tree.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
  },
});
