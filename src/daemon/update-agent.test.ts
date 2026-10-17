import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
import { agentMatches } from './autostart.js';
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; vi.resetAllMocks(); });
const environment = (env: Record<string, string>) => vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: JSON.stringify(env) } as ReturnType<typeof spawnSync>);
it('requires both the requested home and port before using launchd', () => {
  environment({ TL_HOME: '/home-a', TL_PORT: '7788' });
  expect(agentMatches('/home-b', 7788)).toBe(false);
  expect(agentMatches('/home-a', 7789)).toBe(false);
  expect(agentMatches('/home-a', 7788)).toBe(true);
});
it('reads the home port file when the agent has no explicit port', () => {
  dir = mkdtempSync(join(tmpdir(), 'tl-agent-update-')); writeFileSync(join(dir, 'port'), '8888\n');
  environment({ TL_HOME: dir });
  expect(agentMatches(dir, 8888)).toBe(true);
  expect(agentMatches(dir, 7788)).toBe(false);
});
it('fails closed when the agent environment cannot be read', () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as ReturnType<typeof spawnSync>);
  expect(agentMatches('/home-a', 7788)).toBe(false);
});
