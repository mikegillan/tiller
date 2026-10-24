import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountForProject, accountViews, claudeAccounts, claudeConfigDir, claudeHomes, loginCommand, projectAccount } from './claude-accounts.js';

let dir: string, home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-accounts-'));
  vi.stubEnv('HOME', dir);
  home = join(dir, 'tl');
  mkdirSync(home);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const configure = (accounts: unknown, account?: string) => writeFileSync(join(home, 'config.json'), JSON.stringify({ claude: { accounts, account } }));

describe('account lookup', () => {
  it('canonicalizes configDir and projects: ~/ expanded, no trailing slash', () => {
    configure([{ name: 'work', configDir: '~/x/', projects: ['~/ws/a/', '/abs/./b'] }]);
    expect(claudeAccounts(home)).toEqual([{ name: 'work', configDir: join(dir, 'x'), projects: [join(dir, 'ws/a'), '/abs/b'] }]);
    expect(claudeConfigDir(home, 'work')).toBe(join(dir, 'x'));
    expect(claudeHomes(home)).toEqual([undefined, join(dir, 'x')]);
  });

  it('maps a project to the longest matching entry, then config order, then claude.account', () => {
    const accounts = [
      { name: 'personal' },
      { name: 'broad', configDir: '/c/broad', projects: ['/ws'] },
      { name: 'first', configDir: '/c/first', projects: ['/ws/repo'] },
      { name: 'second', configDir: '/c/second', projects: ['/ws/repo'] },
    ];
    configure(accounts, 'second');
    expect(projectAccount(home, '/ws/repo/sub')).toEqual({ account: 'first', project: '/ws/repo' });
    expect(projectAccount(home, '/ws/other')).toEqual({ account: 'broad', project: '/ws' });
    expect(projectAccount(home, '/ws-not-inside')).toEqual({ account: 'second' });
    configure(accounts); // an entry without configDir is only Claude's default home, not the default account
    expect(accountForProject(home, '/elsewhere')).toBeUndefined();
  });

  it('fails closed when claude.account names no configured account', () => {
    configure([{ name: 'work', configDir: '/c/w' }], 'gone');
    expect(() => accountForProject(home, '/elsewhere')).toThrow(`claude.account in ${join(home, 'config.json')} names "gone", which is not an account in claude.accounts`);
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

describe('an invalid claude.accounts list', () => {
  it('fails closed with the file and the problem; trust and transcript lookups fall back to the default home', async () => {
    configure([{ name: 'work', configDir: '~/w', project: ['~/ws'] }]); // a typo: projects
    const error = `claude.accounts in ${join(home, 'config.json')} is invalid`;
    expect(() => accountForProject(home, join(dir, 'ws'))).toThrow(error);
    expect(() => claudeConfigDir(home, 'work')).toThrow(/claude\.accounts\.0: .*project/);
    expect(claudeHomes(home)).toEqual([undefined]);
    expect(await accountViews(home, '')).toEqual([expect.objectContaining({ name: 'claude.accounts', loggedIn: null, error: expect.stringContaining(error) })]);
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
    configure([{ name: 'personal' }, { name: 'work', configDir: '~/in' }, { name: 'side', configDir: '~/out' }, { name: 'new', configDir: '~/missing' }], 'personal');
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

describe('accountViews refreshes', () => {
  // Fake claude: logs "+dir" on start and "-dir" on exit, after a short pause so runs overlap.
  const fakeClaude = () => {
    const bin = join(dir, 'bin'), log = join(dir, 'log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo "+\${CLAUDE_CONFIG_DIR:-default}" >> '${log}'
sleep 0.2
echo "-\${CLAUDE_CONFIG_DIR:-default}" >> '${log}'
echo '{"loggedIn":false}'; exit 1
`);
    chmodSync(join(bin, 'claude'), 0o755);
    const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('+')).length : 0);
    return { path: `${bin}:/usr/bin:/bin`, log, starts };
  };

  it('shares one probe per account between concurrent calls and reuses it briefly', async () => {
    const { path, starts } = fakeClaude();
    configure([{ name: 'personal' }, { name: 'work', configDir: dir }]);
    const [a, b] = await Promise.all([accountViews(home, path), accountViews(home, path)]);
    expect(b).toBe(a);
    expect(starts()).toBe(2);
    await accountViews(home, path);
    expect(starts()).toBe(2);
    await accountViews(home, path, Date.now() + 10_000); // stale
    expect(starts()).toBe(4);
  });

  it('probes again when the accounts change or a configDir appears', async () => {
    const { path, starts } = fakeClaude();
    configure([{ name: 'personal' }]);
    await accountViews(home, path);
    configure([{ name: 'personal' }, { name: 'work', configDir: '~/work' }]);
    expect((await accountViews(home, path))[1]).toMatchObject({ name: 'work', error: expect.stringContaining('does not exist') });
    expect(starts()).toBe(2);
    mkdirSync(join(dir, 'work')); // claude auth login created it
    expect((await accountViews(home, path)).map((v) => v.name)).toEqual(['personal', 'work']);
    expect(starts()).toBe(4);
  });

  it('runs at most four probes at once', async () => {
    const { path, log } = fakeClaude();
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const n of names) mkdirSync(join(dir, n));
    configure(names.map((n) => ({ name: n, configDir: `~/${n}` })));
    expect(await accountViews(home, path)).toHaveLength(6);
    let running = 0, peak = 0;
    for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) { running += line.startsWith('+') ? 1 : -1; peak = Math.max(peak, running); }
    expect(peak).toBe(4);
  });
});
