import { describe, expect, it, vi } from 'vitest';
import { profileFor } from '../src/shared/protocol';
import { restartMsg, spawnMsg } from './Dialogs';

vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 0 })); // hooks.ts reaches for window on import

type Choice = 'claude' | 'pi' | 'codex' | 'terminal';
const form = (choice: Choice, extra: Partial<Parameters<typeof spawnMsg>[1]> = {}): Parameters<typeof spawnMsg>[1] =>
  ({ choice, title: '', cwd: '/repo', prompt: '', model: '', role: 'orchestrator', defaultRole: 'orchestrator', isolate: false, ...extra });

describe('spawnMsg', () => {
  it('sends profile and effort independently of the coordination role and omits them for terminals', () => {
    expect(spawnMsg({ parentId: 'p' }, form('codex', { profile: 'mechanical', effort: 'low', role: 'none' }))).toMatchObject({ profile: 'mechanical', effort: 'low', role: 'none' });
    const terminal = spawnMsg({ parentId: null }, form('terminal', { profile: 'reviewer', effort: 'high' }));
    expect(terminal).not.toHaveProperty('profile');
    expect(terminal).not.toHaveProperty('effort');
  });
  it('sends a legacy claude spawn with no harness, keeping the agent fields', () => {
    expect(spawnMsg({ parentId: null }, form('claude', { title: ' t ', prompt: ' go ', model: ' m ' })))
      .toEqual({ t: 'spawn', kind: 'claude', title: 't', cwd: '/repo', parentId: null, prompt: ' go ', model: 'm' });
  });

  it('sends a pi agent with harness pi and the agent fields', () => {
    expect(spawnMsg({ parentId: 'p' }, form('pi', { role: 'worker', defaultRole: 'orchestrator', isolate: true, prompt: 'go' })))
      .toEqual({ t: 'spawn', kind: 'agent', harness: 'pi', title: 'pi', cwd: '/repo', parentId: 'p', prompt: 'go', role: 'worker', isolation: 'worktree' });
  });

  it('sends a terminal with no harness and no agent-only fields', () => {
    expect(spawnMsg({ parentId: null }, form('terminal', { prompt: 'go', isolate: true, role: 'worker', defaultRole: 'orchestrator', model: 'm' })))
      .toEqual({ t: 'spawn', kind: 'terminal', title: 'terminal', cwd: '/repo', parentId: null, model: 'm' });
  });

  it('sends a Codex agent with its selected model', () => {
    expect(spawnMsg({ parentId: null }, form('codex', { prompt: 'go', model: 'model-id' })))
      .toEqual({ t: 'spawn', kind: 'agent', harness: 'codex', title: 'codex', cwd: '/repo', parentId: null, prompt: 'go', model: 'model-id' });
  });
});

describe('restartMsg', () => {
  it('carries a first prompt for pi and claude agents and drops it for a terminal', () => {
    expect(restartMsg('n-1', 'agent', ' go ')).toEqual({ t: 'restart', id: 'n-1', prompt: ' go ' });
    expect(restartMsg('n-1', 'claude', ' go ')).toEqual({ t: 'restart', id: 'n-1', prompt: ' go ' });
    expect(restartMsg('n-1', 'terminal', ' go ')).toEqual({ t: 'restart', id: 'n-1' });
    expect(restartMsg('n-1', 'claude', '  ')).toEqual({ t: 'restart', id: 'n-1' });
  });
});

describe('spawn dialog profile choice', () => {
  it('follows effective role changes until a task profile is explicitly selected', () => {
    expect(profileFor(undefined, 'parent', 'worker')).toBe('implementation');
    expect(profileFor(undefined, 'parent', 'orchestrator')).toBe('orchestrator');
    expect(profileFor(undefined, null, 'worker')).toBe('implementation');
    expect(profileFor(undefined, null, 'none')).toBe('implementation');
    expect(profileFor('mechanical', 'parent', 'orchestrator')).toBe('mechanical');
    expect(profileFor('mechanical', null, 'worker')).toBe('mechanical');
  });
});
