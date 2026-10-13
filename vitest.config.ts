import { configDefaults, defineConfig } from 'vitest/config';

// mod/tests run under `claude plugin test`, not vitest. Worker worktrees under .claude/worktrees hold copies of the tests.
// Files run one at a time: several tests drive real git and a fake claude process with timing budgets, and in parallel they
// starve each other (58 s sequential against 51 s parallel). 120 s per test is a hang detector, not a budget: the worktree
// tests take 5 to 9 s idle and over 30 s when several workers and their test runs share the machine.
// Tests make real git commits; the daemon inherits the user's git config, and a signing key or agent prompt must not block them.
const GIT_NO_SIGN = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
export default defineConfig({ test: { env: GIT_NO_SIGN, exclude: [...configDefaults.exclude, 'mod/**', '**/.claude/worktrees/**'], fileParallelism: false, testTimeout: 120_000, expect: { poll: { timeout: 10_000 } } } });
