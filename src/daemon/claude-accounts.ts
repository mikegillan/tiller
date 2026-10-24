// Claude accounts (home config claude.accounts): each is a CLAUDE_CONFIG_DIR, or Claude's default home when it has none.
// A node records the account's name; its directory is looked up in the config at every launch.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeAccountView } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { buildChildEnv } from './pty.js';
import { expandHome, inside } from './util.js';

export interface ClaudeAccount { name: string; configDir?: string; projects: string[] }

/** The configured accounts, with configDir and projects in canonical form (see expandHome): the same string everywhere. */
export function claudeAccounts(home: string): ClaudeAccount[] {
  return loadConfig(null, home).claude.accounts.map((a) => ({
    name: a.name, ...(a.configDir ? { configDir: expandHome(a.configDir) } : {}), projects: (a.projects ?? []).map(expandHome),
  }));
}

/** The account a root node in `dir` runs in: the one whose project contains it (longest wins, then config order), else the default. */
export function accountForProject(home: string, dir: string): string | undefined {
  const accounts = claudeAccounts(home), at = expandHome(dir);
  let best: { name: string; length: number } | undefined;
  for (const a of accounts) {
    for (const p of a.projects) if (inside(at, p) && p.length > (best?.length ?? -1)) best = { name: a.name, length: p.length };
  }
  return best?.name ?? accounts.find((a) => !a.configDir)?.name;
}

/** CLAUDE_CONFIG_DIR for a named account (undefined: Claude's default home). Throws for an account no longer configured. */
export function claudeConfigDir(home: string, name: string): string | undefined {
  const a = claudeAccounts(home).find((x) => x.name === name);
  if (!a) throw new Error(`Claude account "${name}" is not configured in ${join(home, 'config.json')} (claude.accounts)`);
  return a.configDir;
}

/** Where Claude keeps an account's files (projects/ holds transcripts); the default home for none or an unconfigured one. */
export function claudeHomeOf(home: string, account: string | undefined): string {
  return (account && claudeAccounts(home).find((a) => a.name === account)?.configDir) || join(homedir(), '.claude');
}

/** Every Claude home Tiller knows: the default (undefined) and each configured configDir. */
export const claudeHomes = (home: string): (string | undefined)[] => [undefined, ...claudeAccounts(home).flatMap((a) => (a.configDir ? [a.configDir] : []))];

const shellQuote = (s: string) => (/^[\w/.,:@%+=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** The command the human runs to log an account in. */
export const loginCommand = (configDir?: string) => `${configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ` : ''}claude auth login`;

/**
 * Each account with its login state from `claude auth status --json`, run under its CLAUDE_CONFIG_DIR. The probe writes
 * into the directory, so a missing one is reported logged out without running claude.
 */
export function accountViews(home: string, path: string): Promise<ClaudeAccountView[]> {
  const defaultName = claudeAccounts(home).find((a) => !a.configDir)?.name;
  return Promise.all(claudeAccounts(home).map((a) => {
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
