import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./update.js', () => ({ updateLocked: vi.fn(() => false), REPO: '/checkout' }));
vi.mock('./up.js', async (original) => ({ ...await original<typeof import('./up.js')>(), restartDaemon: vi.fn(async () => {}) }));
import { restartDaemon } from './up.js';

const argv = process.argv;
let home: string;
afterEach(() => { process.argv = argv; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

it('routes detached reload through the restart helper that validates daemon home and launchd home/port', async () => {
  home = mkdtempSync(join(tmpdir(), 'tl-cli-reload-'));
  vi.stubEnv('TL_HOME', home);
  vi.stubEnv('TL_PORT', '7799');
  process.argv = [process.execPath, 'tl', 'reload', '--detached'];
  await import('./cli.js');
  // The foreground tl reload already waited for agents, so the detached helper restarts at once.
  expect(restartDaemon).toHaveBeenCalledExactlyOnceWith(home, 7799, undefined, expect.any(Function), { reason: 'tl reload', now: true });
});
