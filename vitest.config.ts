import { configDefaults, defineConfig } from 'vitest/config';

// mod/tests run under `claude plugin test`, not vitest. Worker worktrees under .claude/worktrees hold copies of the tests.
// Files run one at a time: several tests drive real git and a fake claude process with timing budgets, and in parallel they
// starve each other (58 s sequential against 51 s parallel). 20 s per test: the worktree tests take 5 to 9 s on a loaded machine.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'mod/**', '**/.claude/worktrees/**'], fileParallelism: false, testTimeout: 20_000, expect: { poll: { timeout: 10_000 } } } });
