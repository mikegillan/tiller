export type Scope = 'project' | 'home';
export interface SettingEntry { value?: unknown; source: string }
export interface SettingsSnapshot {
  scope: Scope; path: string; projectPath: string | null; revision: string;
  values: Record<string, unknown>; entries: Record<string, SettingEntry>; inherited: Record<string, SettingEntry>;
}
export interface Field { key: string; label: string; kind?: 'number' | 'boolean' | 'list'; options?: readonly string[]; help?: string }
export const profiles = ['orchestrator', 'implementation', 'explorer', 'mechanical', 'reviewer'] as const;
export const efforts = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], pi: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] };
export const codexRecommendations: Record<string, string> = Object.fromEntries([
  ['orchestrator', 'gpt-6-astra', 'medium'], ['implementation', 'gpt-6.1-sol', 'medium'],
  ['explorer', 'gpt-6-luna', 'high'], ['mechanical', 'gpt-6-luna', 'low'], ['reviewer', 'gpt-6.1-sol', 'high'],
].flatMap(([profile, model, effort]) => [[`profiles.codex.${profile}.model`, model], [`profiles.codex.${profile}.effort`, effort]]));
export const profileFields = (harness: keyof typeof efforts): Field[] => profiles.flatMap((profile) => [
  { key: `profiles.${harness}.${profile}.model`, label: `${profile} model`, help: harness === 'pi' ? 'Provider/model ID accepted by Pi.' : 'Model ID accepted by this harness.' },
  { key: `profiles.${harness}.${profile}.effort`, label: `${profile} effort`, options: efforts[harness] },
]);
const field = (key: string, label: string, extra: Omit<Field, 'key' | 'label'> = {}): Field => ({ key, label: label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), ...extra });
export const groups: { title: string; homeOnly?: boolean; help?: string; fields: Field[] }[] = [
  { title: 'Notifications', fields: [
    ...['needsYou', 'errored', 'done', 'exited'].map((kind) => field(`notifications.kinds.${kind}`, kind, { options: ['banner', 'sound', 'silent'] })),
    field('notifications.treeDoneSummary', 'One completion summary per tree', { kind: 'boolean' }),
    field('notifications.quietHours', 'Quiet hours', { help: 'Local time HH:MM-HH:MM; can cross midnight. Needs-you banners remain visible without sound.' }),
  ] },
  { title: 'Limits', help: 'Spawn caps apply to agents; the human is exempt.', fields: ['maxDepth', 'maxChildren', 'stallMinutes', 'maxMessagesPer10Min'].map((key) => field(`limits.${key}`, key, { kind: 'number' })) },
  { title: 'Worktrees', fields: [
    field('worktrees.isolation', 'Default isolation', { options: ['none', 'worktree'] }), field('worktrees.branchPrefix', 'Branch prefix'),
    field('worktrees.taskBranch', 'Task branch', { help: 'Must contain {slug}.' }), field('worktrees.mergeStyle', 'Merge style', { options: ['merge', 'squash', 'ff-only'] }),
    ...['include', 'protected', 'setup', 'teardown'].map((key) => field(`worktrees.${key}`, key, { kind: 'list', help: key === 'include' ? 'One pattern per line. Inherit to use .worktreeinclude; an empty list copies nothing.' : key === 'protected' ? 'One branch per line. An empty list protects no branches.' : 'One shell command per line. Saving does not execute commands.' })),
  ] },
  { title: 'Approvals & completion gate', fields: [
    field('approvals.close', 'Agent close approval', { options: ['never', 'done', 'always'], help: 'Skip human approval: never; only when every node is done, exited or has an outcome; or always.' }),
    field('approvals.merge', 'Allow agent merges without approval', { kind: 'boolean' }),
    field('gate.command', 'Completion gate command', { help: 'Must pass before a worker reports success. Saving does not run it. Reset to inherit to remove a local gate.' }),
    field('gate.retries', 'Gate retries', { kind: 'number' }), field('gate.timeoutMinutes', 'Gate timeout (minutes)', { kind: 'number' }),
  ] },
  { title: 'Legacy Claude roles', homeOnly: true, help: 'Fallback model and effort for legacy Claude role defaults. Task profiles take precedence.', fields: ['orchestrator', 'worker'].flatMap((role) => [field(`roles.${role}.model`, `${role} model`), field(`roles.${role}.effort`, `${role} effort`, { options: efforts.claude })]) },
  { title: 'Daemon', homeOnly: true, help: 'Global daemon settings. maxWorking = 0 means unlimited.', fields: [field('daemon.resumeOnStart', 'Resume on start', { kind: 'boolean' }), ...['resumeMaxAgeDays', 'sessionsKeepDays', 'digestAfterMinutes', 'maxLiveNodes', 'maxWorking'].map((key) => field(`daemon.${key}`, key, { kind: 'number' }))] },
];
export function formatValue(value: unknown): string { return value === undefined ? 'Harness default / unset' : typeof value === 'string' ? value : JSON.stringify(value); }
export function inputValue(value: unknown, field: Field): string {
  return value === undefined ? '' : field.kind === 'list' && Array.isArray(value) ? value.join('\n') : String(value);
}
// null removes only the explicit target-layer value; untouched inherited fields never enter changes.
export function buildChanges(snapshot: SettingsSnapshot, drafts: Record<string, string | null>, fields: Field[]): Record<string, unknown | null> {
  const changes: Record<string, unknown | null> = {};
  for (const [key, raw] of Object.entries(drafts)) {
    const f = fields.find((f) => f.key === key);
    if (!f) throw new Error(`Unknown field: ${key}`);
    let value: unknown = raw;
    if (raw !== null) {
      if (f.kind === 'number') { if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`${f.label}: enter a number.`); value = Number(raw); }
      else if (f.kind === 'boolean') value = raw === 'true';
      else if (f.kind === 'list') value = raw === '' ? [] : raw.split('\n').filter((line) => line.trim());
      else if (!raw.trim()) throw new Error(`${f.label}: enter a value or reset to inherit.`);
    }
    if (value === null ? Object.hasOwn(snapshot.values, key) : JSON.stringify(value) !== JSON.stringify(snapshot.values[key])) changes[key] = value;
  }
  return changes;
}
