// Per-project settings: <cwd>/.orchestr8/config.json, then <home>/config.json, then built-in defaults. Read fresh on every call.
// Daemon settings (resumeOnStart, resumeMaxAgeDays, sessionsKeepDays, digestAfterMinutes) come from the home file only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EFFORTS, ISOLATIONS, type Isolation } from '../shared/protocol.js';
import { homeDir } from './home.js';

export const MERGE_STYLES = ['merge', 'squash', 'ff-only'] as const;
export type MergeStyle = (typeof MERGE_STYLES)[number];

const RoleDefaults = z.object({ model: z.string().min(1).optional(), effort: z.enum(EFFORTS).optional() });
const ConfigFile = z.object({
  roles: z.object({ orchestrator: RoleDefaults.optional(), worker: RoleDefaults.optional() }).optional(),
  closeWithoutConfirm: z.enum(['never', 'done', 'always']).optional(),
  worktrees: z.object({
    isolation: z.enum(ISOLATIONS).optional(),
    branchPrefix: z.string().min(1).optional(),
    include: z.array(z.string().min(1)).optional(),
    merge: z.enum(MERGE_STYLES).optional(),
    mergeWithoutConfirm: z.boolean().optional(),
    setup: z.array(z.string().min(1)).optional(),
    teardown: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
  resumeOnStart: z.boolean().optional(),
  resumeMaxAgeDays: z.number().nonnegative().optional(),
  sessionsKeepDays: z.number().nonnegative().optional(),
  digestAfterMinutes: z.number().nonnegative().optional(),
  limits: z.object({
    maxDepth: z.number().int().nonnegative().optional(),
    maxChildren: z.number().int().nonnegative().optional(),
    maxLiveNodes: z.number().int().nonnegative().optional(),
    stallMinutes: z.number().positive().optional(),
    maxMessagesPer10Min: z.number().int().positive().optional(),
  }).strict().optional(),
});
type ConfigFile = z.infer<typeof ConfigFile>;
type RoleDefaults = z.infer<typeof RoleDefaults>;

type Key = `roles.${'orchestrator' | 'worker'}.${'model' | 'effort'}` | 'closeWithoutConfirm' | `worktrees.${'isolation' | 'branchPrefix' | 'include' | 'merge' | 'mergeWithoutConfirm' | 'setup' | 'teardown'}` | 'resumeOnStart' | 'resumeMaxAgeDays' | 'sessionsKeepDays' | 'digestAfterMinutes' | `limits.${LimitKey}`;
type LimitKey = keyof Limits;

/** Guardrails for unattended agents; the human is exempt from the spawn caps. */
export interface Limits {
  /** Levels below the root a spawned node may sit at; a root is level 0. */
  maxDepth: number;
  /** Live children per node. */
  maxChildren: number;
  /** Live nodes in the whole daemon. */
  maxLiveNodes: number;
  /** A working node with no hook event this long gets a notice to its parent. */
  stallMinutes: number;
  /** Messages one sender may send one target in 10 minutes. */
  maxMessagesPer10Min: number;
}
const LIMIT_DEFAULTS: Limits = { maxDepth: 3, maxChildren: 8, maxLiveNodes: 20, stallMinutes: 5, maxMessagesPer10Min: 20 };

export interface Config {
  roles: { orchestrator: RoleDefaults; worker: RoleDefaults };
  closeWithoutConfirm: 'never' | 'done' | 'always';
  /**
   * isolation: what a spawn that omits it gets, for claude nodes whose role is worker or none.
   * branchPrefix: a worktree's branch is <prefix><nodeId>. include: gitignored files to copy in; absent means .worktreeinclude.
   * merge: how the merge verb brings a branch into its base. mergeWithoutConfirm: an agent's merge skips the human's approval.
   * setup, teardown: shell commands run in a new worktree before launch, and in a worktree before it is removed.
   */
  worktrees: { isolation: Isolation; branchPrefix: string; include?: string[]; merge: MergeStyle; mergeWithoutConfirm: boolean; setup: string[]; teardown: string[] };
  /** On start, resume the nodes that were live when the daemon last went away, unless idle for more than resumeMaxAgeDays. */
  resumeOnStart: boolean;
  resumeMaxAgeDays: number;
  /** A session directory is deleted this long after its root closed (or, with the root gone, after its last write). */
  sessionsKeepDays: number;
  /** A client regaining focus after this long with no focused client gets an away digest. */
  digestAfterMinutes: number;
  limits: Limits;
  /** Where each key came from: a file path, or 'default'. */
  sources: Record<Key, string>;
}

/** The project file for `cwd` (none when null), then the home file; earlier wins. */
export const configPaths = (cwd: string | null, home = homeDir()): string[] => [...(cwd === null ? [] : [join(cwd, '.orchestr8', 'config.json')]), join(home, 'config.json')];

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

export function loadConfig(cwd: string | null, home = homeDir()): Config {
  const layers = configPaths(cwd, home).flatMap((path) => { const c = readLayer(path); return c ? [{ path, c }] : []; });
  const homeFile = join(home, 'config.json');
  const pick = <T>(get: (c: ConfigFile) => T | undefined, homeOnly = false): [T | undefined, string] => {
    for (const { path, c } of layers) { const v = homeOnly && path !== homeFile ? undefined : get(c); if (v !== undefined) return [v, path]; }
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
  const [merge, smerge] = pick((c) => c.worktrees?.merge);
  const [mergeWithoutConfirm, smwc] = pick((c) => c.worktrees?.mergeWithoutConfirm);
  const [setup, ssetup] = pick((c) => c.worktrees?.setup);
  const [teardown, steardown] = pick((c) => c.worktrees?.teardown);
  sources['worktrees.isolation'] = si; sources['worktrees.branchPrefix'] = sb; sources['worktrees.include'] = sinc;
  sources['worktrees.merge'] = smerge; sources['worktrees.mergeWithoutConfirm'] = smwc; sources['worktrees.setup'] = ssetup; sources['worktrees.teardown'] = steardown;
  const worktrees = {
    isolation: isolation ?? 'none', branchPrefix: branchPrefix ?? 'o8/', ...(include ? { include } : {}),
    merge: merge ?? 'merge', mergeWithoutConfirm: mergeWithoutConfirm ?? false, setup: setup ?? [], teardown: teardown ?? [],
  };
  const [resumeOnStart, sr] = pick((c) => c.resumeOnStart, true);
  const [resumeMaxAgeDays, sa] = pick((c) => c.resumeMaxAgeDays, true);
  sources.resumeOnStart = sr; sources.resumeMaxAgeDays = sa;
  const [sessionsKeepDays, sk] = pick((c) => c.sessionsKeepDays, true);
  const [digestAfterMinutes, sd] = pick((c) => c.digestAfterMinutes, true);
  sources.sessionsKeepDays = sk; sources.digestAfterMinutes = sd;
  const limits = { ...LIMIT_DEFAULTS };
  for (const k of Object.keys(LIMIT_DEFAULTS) as LimitKey[]) {
    const [v, src] = pick((c) => c.limits?.[k]);
    if (v !== undefined) limits[k] = v;
    sources[`limits.${k}`] = src;
  }
  return { roles, closeWithoutConfirm: close ?? 'never', worktrees, resumeOnStart: resumeOnStart ?? true, resumeMaxAgeDays: resumeMaxAgeDays ?? 3,
    sessionsKeepDays: sessionsKeepDays ?? 14, digestAfterMinutes: digestAfterMinutes ?? 10, limits, sources };
}
