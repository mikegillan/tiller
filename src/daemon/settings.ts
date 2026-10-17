import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SETTINGS_EFFORTS, SETTINGS_FIELDS, SETTINGS_PROFILES, type SettingsScope, type SettingsSnapshot, type SettingsUpdate } from '../shared/settings.js';
import { ConfigFile, DEFAULTS, configEntries } from './config.js';
import type { NodeManager } from './manager.js';
import { readBody } from './util.js';

export class SettingsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const keys = SETTINGS_FIELDS.map(f => f.key);
const get = (data: Record<string, unknown>, key: string): unknown => key.split('.').reduce<unknown>((v, k) => object(v) && Object.hasOwn(v, k) ? v[k] : undefined, data);
function validate(key: string, value: unknown): void {
  if (!keys.includes(key)) throw new SettingsError(400, `Unknown settings field: ${key}`);
  if (value === null) return;
  const parts = key.split('.');
  let schema: z.ZodType = ConfigFile;
  if (parts[0] === 'profiles') {
    schema = parts[3] === 'model' ? z.string().min(1) : z.enum(SETTINGS_EFFORTS[parts[1] as keyof typeof SETTINGS_EFFORTS]);
  } else {
    for (const part of parts) {
      while (schema instanceof z.ZodOptional) schema = schema.unwrap() as z.ZodType;
      schema = (schema as z.ZodObject).shape[part];
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new SettingsError(400, `${key}: ${result.error.issues.map(i => i.message).join('; ')}`);
}
function checkPath(path: string): void {
  for (const p of [dirname(path), path]) {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || (p === path ? !stat.isFile() : !stat.isDirectory())) throw new SettingsError(400, `Unsafe settings path: ${p}`);
    } catch (e) { if (!missing(e)) throw e; }
  }
}
function read(path: string): { raw: string | null; data: Record<string, unknown> } {
  checkPath(path);
  let raw: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw new SettingsError(400, `Unsafe settings path: ${path}`);
    raw = fs.readFileSync(fd, 'utf8');
  } catch (e) { if (missing(e)) return { raw: null, data: {} }; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new SettingsError(422, `Malformed JSON in ${path}; repair the file before saving`); }
  if (!object(data)) throw new SettingsError(422, `Expected a JSON object in ${path}`);
  // Unknown fields are retained. Known groups must be objects so edits cannot silently replace them.
  for (const key of keys) {
    const parts = key.split('.');
    let parent: unknown = data;
    for (const part of parts.slice(0, -1)) {
      if (!object(parent) || !Object.hasOwn(parent, part)) break;
      parent = parent[part];
      if (!object(parent)) throw new SettingsError(422, `Invalid settings group in ${path}: ${key}`);
    }
  }
  return { raw, data };
}
const revision = (raw: string | null) => createHash('sha256').update(raw === null ? 'missing' : `file:${raw}`).digest('hex');
function flatten(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).flatMap(([k, v]) => {
    const key = prefix + k;
    return object(v) ? Object.entries(flatten(v, key + '.')) : [[key, v]];
  }));
}
function target(manager: NodeManager, scope: SettingsScope, nodeId?: string) {
  if (scope !== 'project' && scope !== 'home') throw new SettingsError(400, 'scope must be project or home');
  let projectPath: string | null = null;
  if (nodeId !== undefined) {
    const node = manager.registry.get(nodeId);
    if (!node) throw new SettingsError(404, `No such node: ${nodeId}`);
    projectPath = fs.realpathSync(manager.projectDir(node));
  }
  if (scope === 'project' && !projectPath) throw new SettingsError(400, 'Project settings require nodeId');
  const home = fs.realpathSync(manager.home);
  return { path: scope === 'home' ? join(home, 'config.json') : join(projectPath!, '.tiller', 'config.json'), projectPath, homePath: join(home, 'config.json') };
}
export function settingsSnapshot(manager: NodeManager, scope: SettingsScope, nodeId?: string): SettingsSnapshot {
  const { path, projectPath, homePath } = target(manager, scope, nodeId);
  const layer = read(path);
  const lower = scope === 'project' ? read(homePath).data : {};
  const home = dirname(homePath);
  const effective = configEntries(scope === 'project' ? projectPath : null, home);
  const below = scope === 'project' ? configEntries(null, home) : null;
  const inherited: SettingsSnapshot['inherited'] = {}, entries: SettingsSnapshot['entries'] = {};
  // Before the profile schema is integrated, validate just those leaves independently.
  // Once configEntries includes them, use its results, including invalid-layer filtering.
  const profileValue = (data: Record<string, unknown>, key: string) => {
    const value = get(data, key);
    if (value === undefined || value === null) return undefined;
    try { validate(key, value); return value; } catch (e) { if (e instanceof SettingsError) return undefined; throw e; }
  };
  for (const key of keys) {
    const fallback = { value: (DEFAULTS as Record<string, unknown>)[key], source: 'default' };
    if (Object.hasOwn(effective, key)) {
      entries[key] = effective[key as keyof typeof effective];
      inherited[key] = below ? below[key as keyof typeof below] : fallback;
    } else {
      const homeValue = profileValue(lower, key);
      inherited[key] = homeValue === undefined ? fallback : { value: homeValue, source: homePath };
      const value = profileValue(layer.data, key);
      entries[key] = value === undefined ? inherited[key] : { value, source: path };
    }
  }
  // Profiles resolve before legacy roles, regardless of the file supplying either field.
  // Preview the usual coordination role: orchestrator for that profile, worker for the rest.
  for (const profile of SETTINGS_PROFILES) {
    const role = profile === 'orchestrator' ? 'orchestrator' : 'worker';
    for (const leaf of ['model', 'effort']) {
      const key = `profiles.claude.${profile}.${leaf}`, legacy = `roles.${role}.${leaf}`;
      if (entries[key].value === undefined) entries[key] = { ...entries[legacy] };
      if (inherited[key].value === undefined) inherited[key] = { ...inherited[legacy] };
    }
  }
  return { scope, path, projectPath, revision: revision(layer.raw), values: flatten(layer.data), entries, inherited };
}
export function updateSettings(manager: NodeManager, update: SettingsUpdate): SettingsSnapshot {
  const { scope, nodeId, changes } = update;
  const { path } = target(manager, scope, nodeId);
  settingsSnapshot(manager, scope, nodeId); // Refuse unreadable inherited layers before writing.
  const before = read(path);
  if (revision(before.raw) !== update.revision) throw new SettingsError(409, 'Settings changed; reload before saving');
  for (const [key, value] of Object.entries(changes)) {
    if (scope === 'project' && key.startsWith('daemon.')) throw new SettingsError(400, 'daemon settings are home-only');
    validate(key, value);
  }
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.');
    let parent = before.data;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part)) parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    if (value === null) delete parent[parts.at(-1)!];
    else parent[parts.at(-1)!] = value;
  }
  // Synchronous read/check/rename serializes this daemon's writers, including different HTTP requests.
  // External editors are detected up to the final check; portable rename has no cross-process CAS.
  fs.mkdirSync(dirname(path), { recursive: true });
  checkPath(path);
  const temp = join(dirname(path), `.config-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', before.raw === null ? 0o600 : fs.statSync(path).mode & 0o777);
    fs.writeFileSync(fd, JSON.stringify(before.data, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (revision(read(path).raw) !== update.revision) throw new SettingsError(409, 'Settings changed; reload before saving');
    fs.renameSync(temp, path);
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { try { fs.unlinkSync(temp); } catch (e) { if (!missing(e)) throw e; } }
  }
  return settingsSnapshot(manager, scope, nodeId);
}
const selection = { scope: z.enum(['project', 'home']), nodeId: z.string().min(1).optional() };
const querySchema = z.object(selection).strict();
const updateSchema = z.object({ ...selection, revision: z.string().min(1), changes: z.record(z.string(), z.unknown()) }).strict();
/** This route deliberately uses the admin bearer token alone, never node authentication or MCP. */
export function settingsApi(manager: NodeManager, isAdmin: (token: string) => boolean) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)); };
    if (!isAdmin(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '')) return reply(401, { error: 'Admin bearer token required' });
    try {
      if (req.method === 'GET') {
        const args = querySchema.parse(Object.fromEntries(url.searchParams));
        return reply(200, settingsSnapshot(manager, args.scope, args.nodeId));
      }
      if (req.method === 'POST') {
        const body = await readBody(req, res);
        if (body === undefined) return;
        let data: unknown;
        try { data = JSON.parse(body); } catch { throw new SettingsError(400, 'Expected JSON request body'); }
        const args = updateSchema.parse(data);
        return reply(200, updateSettings(manager, args));
      }
      res.setHeader('Allow', 'GET, POST');
      reply(405, { error: 'Method not allowed' });
    } catch (e) {
      reply(e instanceof SettingsError ? e.status : e instanceof z.ZodError ? 400 : 500, { error: e instanceof Error ? e.message : 'Settings read/write failed' });
    }
  };
}
