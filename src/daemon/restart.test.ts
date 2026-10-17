import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./autostart.js', () => ({ agentMatches: vi.fn(), agentStatus: vi.fn(), kickstart: vi.fn() }));
import { spawn } from 'node:child_process';
import { agentMatches, agentStatus, kickstart } from './autostart.js';
import { restartDaemon } from './up.js';

const health = (home: string, sha = 'released') => new Response(JSON.stringify({ ok: true, pid: 123, home, sha }));
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tl-restart-'));
  vi.mocked(agentStatus).mockReturnValue({ installed: true, loaded: true });
  vi.mocked(spawn).mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); rmSync(home, { recursive: true, force: true }); });

describe('restartDaemon shared by update and reload', () => {
  it('refuses to signal another home even when called directly by a detached helper', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(health('/other')));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(restartDaemon(home, 7799)).rejects.toThrow('another home');
    expect(kill).not.toHaveBeenCalled();
    expect(kickstart).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses launchd only for matching home and port (matches=%s)', async (matches) => {
    vi.mocked(agentMatches).mockReturnValue(matches);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(health(home))
      .mockRejectedValueOnce(new Error('stopped'))
      .mockResolvedValueOnce(health(home)));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const say = vi.fn();
    await restartDaemon(home, 7799, 'released', say);
    expect(kill).toHaveBeenCalledExactlyOnceWith(123, 'SIGTERM');
    expect(agentMatches).toHaveBeenCalledExactlyOnceWith(home, 7799);
    expect(kickstart).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect(spawn).toHaveBeenCalledTimes(matches ? 0 : 1);
    if (!matches) expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ env: { TL_HOME: home, TL_PORT: '7799' } });
    expect(say).toHaveBeenLastCalledWith(expect.stringContaining('it resumes the nodes that were live'));
  });

  it('retains verification of the released commit after restart', async () => {
    vi.mocked(agentMatches).mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('absent')).mockResolvedValueOnce(health(home, 'wrong')));
    await expect(restartDaemon(home, 7799, 'released')).rejects.toThrow('expected commit released');
  });
});
