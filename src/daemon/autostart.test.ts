import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, PORT_FILE } from './home.js';
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
import { agentMatches, LABEL, plist } from './autostart.js';

describe('plist', () => {
  it('installs com.tiller.daemon', () => {
    expect(LABEL).toBe('com.tiller.daemon');
  });

  it('runs tld at load with the environment, relaunches only after a failed exit and logs to daemon.log', () => {
    const p = plist({ label: 'com.tiller.daemon', program: '/repo/bin/tld', env: { TL_HOME: '/h & co', PATH: '/opt/homebrew/bin:/usr/bin' }, log: '/h/daemon.log' });
    const flat = p.replace(/\s+/g, '');
    expect(flat).toContain('<key>Label</key><string>com.tiller.daemon</string>');
    expect(flat).toContain('<key>ProgramArguments</key><array><string>/repo/bin/tld</string></array>');
    expect(flat).toContain('<key>TL_HOME</key><string>/h&amp;co</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(flat).toContain('<key>RunAtLoad</key><true/>');
    expect(flat).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(flat).toContain('<key>StandardOutPath</key><string>/h/daemon.log</string><key>StandardErrorPath</key><string>/h/daemon.log</string>');
  });
});


describe('agentMatches', () => {
  afterEach(() => vi.resetAllMocks());
  const env = (value: unknown) => vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: JSON.stringify(value) } as any);

  it('requires explicit matching home and port, including homes with XML characters', () => {
    env({ TL_HOME: '/h & <co>', TL_PORT: '7799' });
    expect(agentMatches('/h & <co>', 7799, '/test/agent.plist')).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith('plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', '/test/agent.plist'], { encoding: 'utf8' });
    expect(agentMatches('/other', 7799)).toBe(false);
    expect(agentMatches('/h & <co>', 7788)).toBe(false);
    env({ TL_PORT: '7799' });
    expect(agentMatches('/h', 7799)).toBe(false);
  });

  it('uses the home port file or default when the agent has no explicit port', () => {
    const home = mkdtempSync(join(tmpdir(), 'tl-agent-'));
    try {
      env({ TL_HOME: home });
      expect(agentMatches(home, DEFAULT_PORT)).toBe(true);
      writeFileSync(join(home, PORT_FILE), '7799\n');
      expect(agentMatches(home, 7799)).toBe(true);
      expect(agentMatches(home, DEFAULT_PORT)).toBe(false);
      env({ TL_HOME: home, TL_PORT: '7800' });
      expect(agentMatches(home, 7799)).toBe(false);
      expect(agentMatches(home, 7800)).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses unreadable or malformed agent environments', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as any);
    expect(agentMatches('/h', 7788)).toBe(false);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'invalid' } as any);
    expect(agentMatches('/h', 7788)).toBe(false);
  });
});
