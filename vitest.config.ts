import { configDefaults, defineConfig } from 'vitest/config';

// mod/tests run under `claude plugin test`, not vitest. Worker worktrees under .claude/worktrees hold copies of the tests.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'mod/**', '**/.claude/worktrees/**'] } });
