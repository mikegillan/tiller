/** Human/admin Settings HTTP contract. null removes an explicit override. */
export type SettingsScope = 'project' | 'home';
export interface SettingsEntry { value?: unknown; source: string }
export interface SettingsSnapshot {
  scope: SettingsScope;
  path: string;
  projectPath: string | null;
  revision: string;
  values: Record<string, unknown>;
  entries: Record<string, SettingsEntry>;
  inherited: Record<string, SettingsEntry>;
}
export interface SettingsUpdate { scope: SettingsScope; nodeId?: string; revision: string; changes: Record<string, unknown | null> }
export interface SettingsField {
  key: string; label: string; type: 'text' | 'number' | 'boolean' | 'select' | 'lines';
  options?: readonly string[]; min?: number; integer?: boolean; description?: string;
}
export const SETTINGS_HARNESSES = ['claude', 'pi', 'codex'] as const;
export const SETTINGS_PROFILES = ['orchestrator', 'implementation', 'explorer', 'mechanical', 'reviewer'] as const;
export const SETTINGS_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
} as const;
const field = (key: string, type: SettingsField['type'], extra: Partial<SettingsField> = {}): SettingsField => ({ key, label: key.split('.').at(-1)!, type, ...extra });
export const SETTINGS_FIELDS: SettingsField[] = [
  ...SETTINGS_HARNESSES.flatMap(h => SETTINGS_PROFILES.flatMap(p => [field(`profiles.${h}.${p}.model`, 'text'), field(`profiles.${h}.${p}.effort`, 'select', { options: SETTINGS_EFFORTS[h] })])),
  ...['orchestrator', 'worker'].flatMap(r => [field(`roles.${r}.model`, 'text'), field(`roles.${r}.effort`, 'select', { options: ['low', 'medium', 'high', 'xhigh', 'max'] })]),
  field('approvals.close', 'select', { options: ['never', 'done', 'always'] }), field('approvals.merge', 'boolean'),
  field('worktrees.isolation', 'select', { options: ['none', 'worktree'] }),
  field('worktrees.mergeStyle', 'select', { options: ['merge', 'squash', 'ff-only'] }),
  ...['branchPrefix', 'taskBranch'].map(k => field(`worktrees.${k}`, 'text')),
  ...['include', 'setup', 'teardown', 'protected'].map(k => field(`worktrees.${k}`, 'lines')),
  field('gate.command', 'text'), field('gate.retries', 'number', { min: 0, integer: true }), field('gate.timeoutMinutes', 'number', { min: 0 }),
  field('daemon.resumeOnStart', 'boolean'),
  ...['resumeMaxAgeDays', 'sessionsKeepDays', 'digestAfterMinutes', 'maxLiveNodes', 'maxWorking'].map(k => field(`daemon.${k}`, 'number', { min: 0, integer: k.startsWith('max') })),
  ...['needsYou', 'done', 'errored', 'exited'].map(k => field(`notifications.kinds.${k}`, 'select', { options: ['banner', 'sound', 'silent'] })),
  field('notifications.treeDoneSummary', 'boolean'), field('notifications.quietHours', 'text'),
  ...['maxDepth', 'maxChildren', 'stallMinutes', 'maxMessagesPer10Min'].map(k => field(`limits.${k}`, 'number', { min: 0, integer: k !== 'stallMinutes' })),
];
