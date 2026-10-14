import { describe, expect, it } from 'vitest';
import { LABEL, OLD_LABEL, plist, plistPath } from './autostart.js';

describe('plist', () => {
  it('installs com.tiller.daemon and knows where the pre-rename agent lives', () => {
    expect(LABEL).toBe('com.tiller.daemon');
    expect(plistPath(OLD_LABEL)).toMatch(/\/Library\/LaunchAgents\/com\.orchestr8\.daemon\.plist$/);
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
