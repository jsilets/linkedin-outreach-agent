import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts (which sets root: 'client' for the SPA
// build) so vitest scans both trees. The client entry covers pure helpers only;
// there is no DOM environment here, so component tests would need one added.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'client/**/*.test.ts'],
  },
});
