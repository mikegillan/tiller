import { configDefaults, defineConfig } from 'vitest/config';

// mod/tests run under `claude plugin test`, not vitest.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'mod/**'] } });
