import { describe, expect, it, vi } from 'vitest';
import { restartMsg, spawnMsg } from './Dialogs';

vi.mock('./conn', () => ({ send: vi.fn() }));
vi.mock('./hooks', () => ({ useNow: () => 0 })); // hooks.ts reaches for window on import

type Choice = 'claude' | 'pi' | 'terminal';
const form = (choice: Choice, extra: Partial<Parameters<typeof spawnMsg>[1]> = {}): Parameters<typeof spawnMsg>[1] =>
  ({ choice, title: '', cwd: '/repo', prompt: '', model: '', role: 'orchestrator', defaultRole: 'orchestrator', isolate: false, ...extra });

describe('spawnMsg', () => {
  it('sends a legacy claude spawn with no harness, keeping the agent fields', () => {
    expect(spawnMsg({ parentId: null }, form('claude', { title: ' t ', prompt: ' go ', model: ' m ' })))
      .toEqual({ t: 'spawn', kind: 'claude', title: 't', cwd: '/repo', parentId: null, prompt: ' go ', model: 'm' });
  });

  it('sends a pi agent with harness pi and the agent fields', () => {
    expect(spawnMsg({ parentId: 'p' }, form('pi', { role: 'worker', defaultRole: 'orchestrator', isolate: true, prompt: 'go' })))
      .toEqual({ t: 'spawn', kind: 'agent', harness: 'pi', title: 'agent', cwd: '/repo', parentId: 'p', prompt: 'go', role: 'worker', isolation: 'worktree' });
  });

  it('sends a terminal with no harness and no agent-only fields', () => {
    expect(spawnMsg({ parentId: null }, form('terminal', { prompt: 'go', isolate: true, role: 'worker', defaultRole: 'orchestrator', model: 'm' })))
      .toEqual({ t: 'spawn', kind: 'terminal', title: 'terminal', cwd: '/repo', parentId: null, model: 'm' });
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
