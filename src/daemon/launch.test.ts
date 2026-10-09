import { describe, expect, it } from 'vitest';
import { launchArgs, terminalBundleFor } from './launch.js';

describe('terminalBundleFor', () => {
  it('maps known TERM_PROGRAM values', () => {
    expect(terminalBundleFor('ghostty')).toBe('com.mitchellh.ghostty');
    expect(terminalBundleFor('iTerm.app')).toBe('com.googlecode.iterm2');
    expect(terminalBundleFor('WezTerm')).toBe('com.github.wez.wezterm');
  });
  it('returns undefined for unknown or missing values', () => {
    expect(terminalBundleFor('xterm')).toBeUndefined();
    expect(terminalBundleFor(undefined)).toBeUndefined();
  });
});

describe('launchArgs', () => {
  const base = { nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: null, sessionId: 's' };
  it('passes the permission mode only when set', () => {
    const i = launchArgs({ ...base, permissionMode: 'auto' }).indexOf('--permission-mode');
    expect(launchArgs({ ...base, permissionMode: 'auto' }).slice(i, i + 2)).toEqual(['--permission-mode', 'auto']);
    expect(launchArgs(base)).not.toContain('--permission-mode');
  });
});
