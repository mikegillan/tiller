import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountForProject, accountViews, claudeAccounts, claudeConfigDir, claudeHomes, loginCommand } from './claude-accounts.js';

let dir: string, home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-accounts-'));
  vi.stubEnv('HOME', dir);
  home = join(dir, 'tl');
  mkdirSync(home);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const configure = (accounts: unknown) => writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts } }));

describe('account lookup', () => {
  it('canonicalizes configDir and projects: ~/ expanded, no trailing slash', () => {
    configure([{ name: 'work', configDir: '~/x/', projects: ['~/ws/a/', '/abs/./b'] }]);
    expect(claudeAccounts(home)).toEqual([{ name: 'work', configDir: join(dir, 'x'), projects: [join(dir, 'ws/a'), '/abs/b'] }]);
    expect(claudeConfigDir(home, 'work')).toBe(join(dir, 'x'));
    expect(claudeHomes(home)).toEqual([undefined, join(dir, 'x')]);
  });

  it('maps a project to the longest matching entry, then config order, then the named default', () => {
    configure([
      { name: 'personal' },
      { name: 'broad', configDir: '/c/broad', projects: ['/ws'] },
      { name: 'first', configDir: '/c/first', projects: ['/ws/repo'] },
      { name: 'second', configDir: '/c/second', projects: ['/ws/repo'] },
    ]);
    expect(accountForProject(home, '/ws/repo/sub')).toBe('first');
    expect(accountForProject(home, '/ws/other')).toBe('broad');
    expect(accountForProject(home, '/ws-not-inside')).toBe('personal');
    configure([{ name: 'work', configDir: '/c/w', projects: ['/ws'] }]);
    expect(accountForProject(home, '/elsewhere')).toBeUndefined();
  });

  it('names an unconfigured account in its error', () => {
    configure([]);
    expect(() => claudeConfigDir(home, 'gone')).toThrow(`Claude account "gone" is not configured in ${join(home, 'config.json')} (claude.accounts)`);
  });

  it('quotes the login command for a path with spaces', () => {
    expect(loginCommand()).toBe('claude auth login');
    expect(loginCommand('/Users/me/.claude-work')).toBe('CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login');
    expect(loginCommand("/Users/me/my 'work'")).toBe(`CLAUDE_CONFIG_DIR='/Users/me/my '\\''work'\\''' claude auth login`);
  });
});

describe('accountViews', () => {
  it('reports login state from claude auth status --json, and never runs it on a missing dir', async () => {
    const bin = join(dir, 'bin'), marker = join(dir, 'ran');
    mkdirSync(bin);
    // Fake claude: logged in only in the "in" dir; records every CLAUDE_CONFIG_DIR it ran under.
    writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo "\${CLAUDE_CONFIG_DIR:-default}" >> '${marker}'
case "$CLAUDE_CONFIG_DIR" in
  */in) echo '{"loggedIn":true,"email":"me@work.example","orgName":"Work"}'; exit 0;;
  *) echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;;
esac
`);
    chmodSync(join(bin, 'claude'), 0o755);
    mkdirSync(join(dir, 'in'));
    mkdirSync(join(dir, 'out'));
    configure([{ name: 'personal' }, { name: 'work', configDir: '~/in' }, { name: 'side', configDir: '~/out' }, { name: 'new', configDir: '~/missing' }]);
    const views = await accountViews(home, `${bin}:/usr/bin:/bin`);
    expect(views).toEqual([
      { name: 'personal', projects: [], isDefault: true, loggedIn: false, loginCommand: 'claude auth login' },
      { name: 'work', configDir: join(dir, 'in'), projects: [], isDefault: false, loggedIn: true, email: 'me@work.example', orgName: 'Work', loginCommand: `CLAUDE_CONFIG_DIR=${join(dir, 'in')} claude auth login` },
      { name: 'side', configDir: join(dir, 'out'), projects: [], isDefault: false, loggedIn: false, loginCommand: `CLAUDE_CONFIG_DIR=${join(dir, 'out')} claude auth login` },
      expect.objectContaining({ name: 'new', loggedIn: false, error: expect.stringContaining('does not exist') }),
    ]);
    expect(readFileSync(marker, 'utf8').split('\n').filter(Boolean).sort()).toEqual(['default', join(dir, 'in'), join(dir, 'out')].sort());
    expect(existsSync(join(dir, 'missing'))).toBe(false);
  });

  it('reports an unknown state when claude cannot be run', async () => {
    configure([{ name: 'personal' }]);
    const [view] = await accountViews(home, join(dir, 'empty-bin'));
    expect(view).toMatchObject({ name: 'personal', loggedIn: null, error: expect.any(String) });
  });
});
