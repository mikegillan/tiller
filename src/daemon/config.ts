// Per-project settings: <cwd>/.orchestr8/config.json, then <home>/config.json, then built-in defaults. Read fresh on every call.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EFFORTS, ISOLATIONS, type Isolation } from '../shared/protocol.js';
import { homeDir } from './home.js';

const RoleDefaults = z.object({ model: z.string().min(1).optional(), effort: z.enum(EFFORTS).optional() });
const ConfigFile = z.object({
  roles: z.object({ orchestrator: RoleDefaults.optional(), worker: RoleDefaults.optional() }).optional(),
  closeWithoutConfirm: z.enum(['never', 'done', 'always']).optional(),
  worktrees: z.object({
    isolation: z.enum(ISOLATIONS).optional(),
    branchPrefix: z.string().min(1).optional(),
    include: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
});
type ConfigFile = z.infer<typeof ConfigFile>;
type RoleDefaults = z.infer<typeof RoleDefaults>;

type Key = `roles.${'orchestrator' | 'worker'}.${'model' | 'effort'}` | 'closeWithoutConfirm' | `worktrees.${'isolation' | 'branchPrefix' | 'include'}`;

export interface Config {
  roles: { orchestrator: RoleDefaults; worker: RoleDefaults };
  closeWithoutConfirm: 'never' | 'done' | 'always';
  /**
   * isolation: what a spawn that omits it gets, for claude nodes whose role is worker or none.
   * branchPrefix: a worktree's branch is <prefix><nodeId>. include: gitignored files to copy in; absent means .worktreeinclude.
   */
  worktrees: { isolation: Isolation; branchPrefix: string; include?: string[] };
  /** Where each key came from: a file path, or 'default'. */
  sources: Record<Key, string>;
}

/** The project file for `cwd`, then the home file; earlier wins. */
export const configPaths = (cwd: string, home = homeDir()): string[] => [join(cwd, '.orchestr8', 'config.json'), join(home, 'config.json')];

const warned = new Set<string>();

function readLayer(path: string): ConfigFile | undefined {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return undefined; } // absent: nothing to say
  try { return ConfigFile.parse(JSON.parse(raw)); } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
    if (!warned.has(`${path}\0${msg}`)) { warned.add(`${path}\0${msg}`); console.error(`orchestr8: ignoring ${path}: ${msg}`); }
    return undefined;
  }
}

export function loadConfig(cwd: string, home = homeDir()): Config {
  const layers = configPaths(cwd, home).flatMap((path) => { const c = readLayer(path); return c ? [{ path, c }] : []; });
  const pick = <T>(get: (c: ConfigFile) => T | undefined): [T | undefined, string] => {
    for (const { path, c } of layers) { const v = get(c); if (v !== undefined) return [v, path]; }
    return [undefined, 'default'];
  };
  const sources = {} as Record<Key, string>;
  const role = (r: 'orchestrator' | 'worker'): RoleDefaults => {
    const [model, sm] = pick((c) => c.roles?.[r]?.model);
    const [effort, se] = pick((c) => c.roles?.[r]?.effort);
    sources[`roles.${r}.model`] = sm; sources[`roles.${r}.effort`] = se;
    return { model, effort };
  };
  const roles = { orchestrator: role('orchestrator'), worker: role('worker') };
  const [close, sc] = pick((c) => c.closeWithoutConfirm);
  sources.closeWithoutConfirm = sc;
  const [isolation, si] = pick((c) => c.worktrees?.isolation);
  const [branchPrefix, sb] = pick((c) => c.worktrees?.branchPrefix);
  const [include, sinc] = pick((c) => c.worktrees?.include);
  sources['worktrees.isolation'] = si; sources['worktrees.branchPrefix'] = sb; sources['worktrees.include'] = sinc;
  const worktrees = { isolation: isolation ?? 'none', branchPrefix: branchPrefix ?? 'o8/', ...(include ? { include } : {}) };
  return { roles, closeWithoutConfirm: close ?? 'never', worktrees, sources };
}
