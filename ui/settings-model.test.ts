import { describe, expect, it } from 'vitest';
import { buildChanges, cliStatus, fieldPreview, groups, profileFields, type SettingsSnapshot } from './settings-model';
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
    expect(() => buildChanges(snapshot, { 'profiles.codex.explorer.model': '' }, fields)).toThrow('use the inherited default');
  });
});

describe('CLI executable status', () => {
  it('keeps unknown and absent distinct from detected executables', () => {
    expect(cliStatus()).toBe('Unknown');
    expect(cliStatus({ installed: null, executableStatus: 'unknown' })).toBe('Unknown');
    expect(cliStatus({ installed: false })).toBe('Not detected');
    expect(cliStatus({ installed: true })).toBe('Detected · check unknown');
  });
  it('shows a broken version check separately from missing installation', () => {
    expect(cliStatus({ installed: true, executableStatus: 'broken' })).toBe('Detected · version check failed');
    expect(cliStatus({ installed: true, executableStatus: 'ready' })).toBe('Detected · ready');
  });
});


describe('Claude previews with pending legacy role edits', () => {
  const implementationModel = profileFields('claude').find((field) => field.key === 'profiles.claude.implementation.model')!;
  const explorerModel = profileFields('claude').find((field) => field.key === 'profiles.claude.explorer.model')!;
  const implementationEffort = profileFields('claude').find((field) => field.key === 'profiles.claude.implementation.effort')!;
  // Global worker=sonnet; repository worker=opus; repository profile=custom.
  const state: SettingsSnapshot = { ...snapshot, values: { 'roles.worker.model': 'opus', [implementationModel.key]: 'custom' }, entries: { [implementationModel.key]: { value: 'custom', source: snapshot.path }, [explorerModel.key]: { value: 'opus', source: snapshot.path }, [implementationEffort.key]: { value: 'high', source: '/home/config.json' } }, inherited: { [implementationModel.key]: { value: 'opus', source: snapshot.path } } };
  it('withholds reset and untouched fallback predictions rather than showing the old opus value', () => {
    const drafts = { [implementationModel.key]: null, 'roles.worker.model': 'haiku' };
    for (const field of [implementationModel, explorerModel]) expect(fieldPreview(state, drafts, field)).toMatchObject({ previewUnavailable: true, entry: undefined, raw: '' });
    expect(fieldPreview(state, drafts, implementationEffort)).toMatchObject({ previewUnavailable: false, entry: { value: 'high' } });
    expect(buildChanges(state, drafts, [...profileFields('claude'), ...groups.flatMap((g) => g.fields)])).toEqual({ [implementationModel.key]: null, 'roles.worker.model': 'haiku' });
  });
  it('keeps explicit profile drafts and valid saved profile overrides independent of role changes', () => {
    expect(fieldPreview(state, { 'roles.worker.model': 'haiku' }, implementationModel)).toMatchObject({ previewUnavailable: false, entry: { value: 'custom' } });
    expect(fieldPreview(state, { [implementationModel.key]: 'sonnet', 'roles.worker.model': null }, implementationModel)).toMatchObject({ previewUnavailable: false, entry: { value: 'sonnet' } });
    expect(fieldPreview(state, { [implementationModel.key]: null, 'roles.worker.effort': 'low' }, implementationModel)).toMatchObject({ previewUnavailable: false, entry: { value: 'opus' } });
  });
});
