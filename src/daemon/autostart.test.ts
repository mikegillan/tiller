import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHome, LABEL, plist } from './autostart.js';

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

describe('agentHome', () => {
  it('reads TL_HOME back from a plist, so reload uses launchd only for the home it serves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-plist-'));
    const path = join(dir, 'a.plist');
    writeFileSync(path, plist({ label: 'x', program: '/tld', env: { TL_HOME: '/h & co', PATH: '/bin' }, log: '/l' }));
    expect(agentHome(path)).toBe('/h & co');
    expect(agentHome(join(dir, 'missing.plist'))).toBeUndefined();
    rmSync(dir, { recursive: true });
  });
});
