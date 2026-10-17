import { describe, expect, it } from 'vitest';
import { buildChanges, groups, profileFields, type SettingsSnapshot } from './settings-model';
const snapshot: SettingsSnapshot = { scope: 'project', path: '/tmp/project/.tiller/config.json', projectPath: '/tmp/project', revision: 'a', values: { 'limits.maxDepth': 3, 'worktrees.include': ['local'], 'approvals.merge': true }, entries: {}, inherited: {} };
const fields = [...groups.flatMap((g) => g.fields), ...profileFields('codex')];
describe('settings drafts', () => {
  it('leaves inherited and untouched fields absent', () => {
    expect(buildChanges(snapshot, {}, fields)).toEqual({});
    expect(buildChanges(snapshot, { 'profiles.codex.explorer.model': null }, fields)).toEqual({});
  });
  it('resets only an explicit local value and preserves empty lists and false', () => {
    expect(buildChanges(snapshot, { 'limits.maxDepth': null, 'worktrees.include': '', 'approvals.merge': 'false' }, fields)).toEqual({ 'limits.maxDepth': null, 'worktrees.include': [], 'approvals.merge': false });
  });
  it('omits unchanged values and converts numeric drafts', () => {
    expect(buildChanges(snapshot, { 'limits.maxDepth': '3' }, fields)).toEqual({});
    expect(buildChanges(snapshot, { 'limits.maxDepth': '0' }, fields)).toEqual({ 'limits.maxDepth': 0 });
  });
  it('rejects empty or nonfinite numeric drafts before sending', () => {
    for (const value of ['', 'abc', 'Infinity']) expect(() => buildChanges(snapshot, { 'limits.maxDepth': value }, fields)).toThrow('enter a number');
  });
  it('keeps model IDs literal and rejects blank strings without treating them as resets', () => {
    expect(buildChanges(snapshot, { 'profiles.codex.explorer.model': 'model/custom-id' }, fields)).toEqual({ 'profiles.codex.explorer.model': 'model/custom-id' });
    expect(() => buildChanges(snapshot, { 'profiles.codex.explorer.model': '' }, fields)).toThrow('reset to inherit');
  });
});
