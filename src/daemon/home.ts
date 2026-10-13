// The daemon's home directory and the files in it that the CLI, the daemon and the app shell share.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 7788;
/** Admin token for the human: mcp.ts writes it once the server listens; the CLI and the app read it. */
export const ADMIN_TOKEN_FILE = 'admin-token';
/** The port the daemon bound, so `o8` finds it without O8_PORT. */
export const PORT_FILE = 'port';
/** This checkout's root, so the app shell can find bin/o8d. */
export const REPO_FILE = 'repo';

/** O8_HOME, else ~/.orchestr8. */
export const homeDir = (): string => process.env.O8_HOME ?? join(homedir(), '.orchestr8');

/** O8_PORT when set and non-empty, else the port file, else DEFAULT_PORT. */
export function daemonPort(home = homeDir()): number {
  if (process.env.O8_PORT) return Number(process.env.O8_PORT);
  try { return Number(readFileSync(join(home, PORT_FILE), 'utf8').trim()) || DEFAULT_PORT; } catch { return DEFAULT_PORT; }
}
