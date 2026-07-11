import { configDefaults, defineConfig } from 'vitest/config';

// Root test config. Only job: keep the default vitest behavior but never scan
// sibling checkouts under .claude/worktrees/, which carry their own (possibly
// stale) copies of these test files and would otherwise be swept into the run.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
