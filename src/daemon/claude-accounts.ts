// Claude accounts (home config claude.accounts): each is a CLAUDE_CONFIG_DIR, or Claude's default home when it has none.
// A node records the account's name; its directory is looked up in the config at every launch.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeAccountView } from '../shared/protocol.js';
import { claudeAccountsError, loadConfig } from './config.js';
import { buildChildEnv } from './pty.js';
import { expandHome, inside } from './util.js';

export interface ClaudeAccount { name: string; configDir?: string; projects: string[] }

/**
 * The configured accounts, with configDir and projects in canonical form (see expandHome): the same string everywhere.
 * Throws when the home file sets an invalid list, so no node silently runs in the wrong account.
 */
export function claudeAccounts(home: string): ClaudeAccount[] {
  const error = claudeAccountsError(home);
  if (error) throw new Error(`${error}; fix it before starting Claude nodes`);
  return loadConfig(null, home).claude.accounts.map((a) => ({
    name: a.name, ...(a.configDir ? { configDir: expandHome(a.configDir) } : {}), projects: (a.projects ?? []).map(expandHome),
  }));
}

/** A project path for comparison: expanded and, when it exists, its real path (Settings writes real paths). */
export const canonicalProject = (path: string) => { const p = expandHome(path); try { return realpathSync(p); } catch { return p; } };

/**
 * The account a root node in `dir` runs in and why: the account whose `projects` entry contains it (longest wins, then
 * config order; `project` is that entry), else the default account (claude.account), else none.
 */
export function projectAccount(home: string, dir: string): { account?: string; project?: string } {
  const accounts = claudeAccounts(home), at = canonicalProject(dir);
  let best: { account: string; project: string } | undefined;
  for (const a of accounts) {
    for (const p of a.projects.map(canonicalProject)) if (inside(at, p) && p.length > (best?.project.length ?? -1)) best = { account: a.name, project: p };
  }
  return best ?? { account: defaultAccount(home) };
}

export const accountForProject = (home: string, dir: string): string | undefined => projectAccount(home, dir).account;

/** claude.account, the default account for root nodes no `projects` entry covers. */
const defaultAccount = (home: string): string | undefined => loadConfig(null, home).claude.account;

/** CLAUDE_CONFIG_DIR for a named account (undefined: Claude's default home). Throws for an account no longer configured. */
export function claudeConfigDir(home: string, name: string): string | undefined {
  const a = claudeAccounts(home).find((x) => x.name === name);
  if (!a) throw new Error(`Claude account "${name}" is not configured in ${join(home, 'config.json')} (claude.accounts)`);
  return a.configDir;
}

/** Where Claude keeps an account's files (projects/ holds transcripts); the default home for none or an unconfigured one. */
export function claudeHomeOf(home: string, account: string | undefined): string {
  return (account && validAccounts(home).find((a) => a.name === account)?.configDir) || join(homedir(), '.claude');
}

/** Every Claude home Tiller knows: the default (undefined) and each configured configDir; only the default while the list is invalid. */
export const claudeHomes = (home: string): (string | undefined)[] => [undefined, ...validAccounts(home).flatMap((a) => (a.configDir ? [a.configDir] : []))];

/** For lookups that may fall back to Claude's default home: none while the list is invalid. */
function validAccounts(home: string): ClaudeAccount[] {
  try { return claudeAccounts(home); } catch { return []; }
}

const shellQuote = (s: string) => (/^[\w/.,:@%+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The command the human runs to log an account in. */
export const loginCommand = (configDir?: string) => `${configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ` : ''}claude auth login`;

/**
 * Each account with its login state from `claude auth status --json`, run under its CLAUDE_CONFIG_DIR. The probe writes
 * into the directory, so a missing one is reported logged out without running claude.
 */
export function accountViews(home: string, path: string): Promise<ClaudeAccountView[]> {
  let accounts: ClaudeAccount[];
  try {
    accounts = claudeAccounts(home);
  } catch (err) { // one view carrying the error, so the spawn dialog shows it
    return Promise.resolve([{ name: 'claude.accounts', projects: [], isDefault: false, loggedIn: null, loginCommand: '', error: (err as Error).message }]);
  }
  const defaultName = defaultAccount(home);
  return Promise.all(accounts.map((a) => {
    const view: ClaudeAccountView = { ...a, isDefault: a.name === defaultName, loggedIn: null, loginCommand: loginCommand(a.configDir) };
    if (a.configDir && !existsSync(a.configDir)) return { ...view, loggedIn: false, error: `${a.configDir} does not exist yet; log in to create it` };
    return new Promise<ClaudeAccountView>((resolve) => {
      const env = buildChildEnv({ PATH: path, ...(a.configDir ? { CLAUDE_CONFIG_DIR: a.configDir } : {}) });
      execFile('claude', ['auth', 'status', '--json'], { env, timeout: 5000, maxBuffer: 65_536 }, (err, stdout) => {
        try { // logged out exits 1 with the same JSON
          const s = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown; orgName?: unknown };
          resolve({ ...view, loggedIn: typeof s.loggedIn === 'boolean' ? s.loggedIn : null,
            ...(typeof s.email === 'string' ? { email: s.email } : {}), ...(typeof s.orgName === 'string' ? { orgName: s.orgName } : {}) });
        } catch {
          resolve({ ...view, error: (err?.message ?? 'claude auth status printed no JSON').slice(0, 300) });
        }
      });
    });
  }));
}
