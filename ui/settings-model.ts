import type { UsageSource } from '../src/shared/protocol';
import { SETTINGS_FIELDS, SETTINGS_EFFORTS, SETTINGS_PROFILES, SETTINGS_PROFILE_DEFAULTS, type SettingsField } from '../src/shared/settings';
export type { SettingsSnapshot } from '../src/shared/settings';
import type { SettingsSnapshot } from '../src/shared/settings';
export type { SettingsScope as Scope } from '../src/shared/settings';
export type Field = SettingsField & { help?: string };
export const profiles = SETTINGS_PROFILES;
export const efforts = SETTINGS_EFFORTS;
function field(key: string, label: string, extra: { help?: string } = {}): Field {
  const metadata = SETTINGS_FIELDS.find((entry) => entry.key === key);
  if (!metadata) throw new Error(`Missing settings metadata: ${key}`);
  return { ...metadata, label: label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), ...extra };
}
function recommendations(harness: keyof typeof efforts): Record<string, string> {
  return Object.fromEntries(Object.entries(SETTINGS_PROFILE_DEFAULTS[harness]).flatMap(([profile, defaults]) => Object.entries(defaults).map(([leaf, value]) => [`profiles.${harness}.${profile}.${leaf}`, value])));
}
export const claudeRecommendations = recommendations('claude');
export const codexRecommendations = recommendations('codex');
export const profileFields = (harness: keyof typeof efforts): Field[] => profiles.flatMap((profile) => [
  field(`profiles.${harness}.${profile}.model`, `${profile} model`, { help: harness === 'pi' ? 'Provider/model ID accepted by Pi.' : 'Model ID accepted by this harness.' }),
  field(`profiles.${harness}.${profile}.effort`, `${profile} effort`),
]);
export const groups: { title: string; homeOnly?: boolean; help?: string; fields: Field[] }[] = [
  { title: 'Notifications', fields: [
    ...['needsYou', 'errored', 'done', 'exited'].map((kind) => field(`notifications.kinds.${kind}`, kind)),
    field('notifications.treeDoneSummary', 'One completion summary per tree'),
    field('notifications.quietHours', 'Quiet hours', { help: 'Local time HH:MM-HH:MM; can cross midnight. Needs-you banners remain visible without sound.' }),
  ] },
  { title: 'Limits', help: 'Spawn caps apply to agents; the human is exempt.', fields: ['maxDepth', 'maxChildren', 'stallMinutes', 'maxMessagesPer10Min'].map((key) => field(`limits.${key}`, key)) },
  { title: 'Worktrees', fields: [
    field('worktrees.isolation', 'Default isolation'), field('worktrees.branchPrefix', 'Branch prefix'),
    field('worktrees.taskBranch', 'Task branch', { help: 'Must contain {slug}.' }), field('worktrees.mergeStyle', 'Merge style'),
    ...['include', 'protected', 'setup', 'teardown'].map((key) => field(`worktrees.${key}`, key, { help: key === 'include' ? 'One pattern per line. Inherit to use .worktreeinclude; an empty list copies nothing.' : key === 'protected' ? 'One branch per line. An empty list protects no branches.' : 'One shell command per line. Saving does not execute commands.' })),
  ] },
  { title: 'Approvals & completion gate', fields: [
    field('approvals.close', 'Agent close approval', { help: 'Skip human approval: never; only when every node is done, exited or has an outcome; or always.' }),
    field('approvals.merge', 'Allow agent merges without approval'),
    field('gate.command', 'Completion gate command', { help: 'Must pass before a worker reports success. Saving does not run it. Use the inherited value to remove this scope’s gate.' }),
    field('gate.retries', 'Gate retries'), field('gate.timeoutMinutes', 'Gate timeout (minutes)'),
  ] },
  { title: 'Legacy Claude roles', help: 'Fallback model and effort for legacy Claude role defaults. Task profiles take precedence.', fields: ['orchestrator', 'worker'].flatMap((role) => [field(`roles.${role}.model`, `${role} model`), field(`roles.${role}.effort`, `${role} effort`)]) },
  { title: 'Daemon', homeOnly: true, help: 'Global daemon settings. maxWorking = 0 means unlimited.', fields: [field('daemon.resumeOnStart', 'Resume on start'), ...['resumeMaxAgeDays', 'sessionsKeepDays', 'digestAfterMinutes', 'maxLiveNodes', 'maxWorking'].map((key) => field(`daemon.${key}`, key))] },
];
export function formatValue(value: unknown): string { return value === undefined ? 'Harness default / unset' : typeof value === 'string' ? value : JSON.stringify(value); }
export function inputValue(value: unknown, field: Field): string {
  return value === undefined ? '' : field.type === 'lines' && Array.isArray(value) ? value.join('\n') : String(value);
}
// null removes only the explicit target-layer value; untouched inherited fields never enter changes.
export function buildChanges(snapshot: SettingsSnapshot, drafts: Record<string, string | null>, fields: Field[]): Record<string, unknown | null> {
  const changes: Record<string, unknown | null> = {};
  for (const [key, raw] of Object.entries(drafts)) {
    const f = fields.find((f) => f.key === key);
    if (!f) throw new Error(`Unknown field: ${key}`);
    let value: unknown = raw;
    if (raw !== null) {
      if (f.type === 'number') { if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`${f.label}: enter a number.`); value = Number(raw); }
      else if (f.type === 'boolean') value = raw === 'true';
      else if (f.type === 'lines') value = raw === '' ? [] : raw.split('\n').filter((line) => line.trim());
      else if (!raw.trim()) throw new Error(`${f.label}: enter a value or use the inherited default.`);
    }
    if (value === null ? Object.hasOwn(snapshot.values, key) : JSON.stringify(value) !== JSON.stringify(snapshot.values[key])) changes[key] = value;
  }
  return changes;
}

export function cliStatus(source?: Pick<UsageSource, 'installed' | 'executableStatus'>): string {
  if (source?.installed === false) return 'Not detected';
  if (source?.installed !== true) return 'Unknown';
  if (source.executableStatus === 'broken') return 'Detected · version check failed';
  if (source.executableStatus === 'ready') return 'Detected · ready';
  return 'Detected · check unknown';
}

// The API snapshot resolves one reset at a time. It cannot reliably identify a
// lower-layer profile versus a legacy-role fallback from source paths alone.
export function fieldPreview(snapshot: SettingsSnapshot, drafts: Record<string, string | null>, field: Field) {
  const drafted = Object.hasOwn(drafts, field.key);
  const explicit = drafted ? drafts[field.key] !== null : Object.hasOwn(snapshot.values, field.key);
  const profile = /^profiles\.claude\.([^.]+)\.(model|effort)$/.exec(field.key);
  const role = profile?.[1] === 'orchestrator' ? 'orchestrator' : 'worker';
  const profileValueWins = drafted ? drafts[field.key] !== null : explicit && snapshot.values[field.key] === snapshot.entries[field.key]?.value;
  const previewUnavailable = !!profile && Object.hasOwn(drafts, `roles.${role}.${profile[2]}`) && !profileValueWins;
  const entry = previewUnavailable ? undefined : drafted ? drafts[field.key] === null ? snapshot.inherited[field.key] : { value: drafts[field.key], source: 'Unsaved change' } : snapshot.entries[field.key];
  const raw = previewUnavailable && !explicit ? '' : drafted && drafts[field.key] !== null ? drafts[field.key]! : inputValue(explicit ? snapshot.values[field.key] : snapshot.inherited[field.key]?.value, field);
  return { drafted, explicit, entry, raw, previewUnavailable };
}
