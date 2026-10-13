import { configDefaults, defineConfig } from 'vitest/config';

// mod/tests run under `claude plugin test`, not vitest. Worker worktrees under .claude/worktrees hold copies of the tests.
// 20 s: the worktree tests run real git and take 5 to 9 s when several workers load the machine.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'mod/**', '**/.claude/worktrees/**'], testTimeout: 20_000, expect: { poll: { timeout: 10_000 } } } });
