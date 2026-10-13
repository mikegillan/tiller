import { describe, expect, it } from 'vitest';
import { plist } from './autostart.js';

describe('plist', () => {
  it('runs o8d at load with the environment, relaunches only after a failed exit and logs to daemon.log', () => {
    const p = plist({ label: 'com.orchestr8.daemon', program: '/repo/bin/o8d', env: { O8_HOME: '/h & co', PATH: '/opt/homebrew/bin:/usr/bin' }, log: '/h/daemon.log' });
    const flat = p.replace(/\s+/g, '');
    expect(flat).toContain('<key>Label</key><string>com.orchestr8.daemon</string>');
    expect(flat).toContain('<key>ProgramArguments</key><array><string>/repo/bin/o8d</string></array>');
    expect(flat).toContain('<key>O8_HOME</key><string>/h&amp;co</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(flat).toContain('<key>RunAtLoad</key><true/>');
    expect(flat).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(flat).toContain('<key>StandardOutPath</key><string>/h/daemon.log</string><key>StandardErrorPath</key><string>/h/daemon.log</string>');
  });
});
