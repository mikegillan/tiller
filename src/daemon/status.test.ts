import { describe, expect, it } from 'vitest';
import type { NodeStatus } from '../shared/protocol.js';
import { interruptKeyPressed, interruptTimeout, ptyExited, reduce, stall, sweep, turnComplete, type HookEvent } from './status.js';

const T0 = 1_000_000;
const st = (p: Partial<NodeStatus> = {}): NodeStatus => ({ state: 'unknown', changedAt: T0, ...p });
const ev = (hook_event_name: string, extra: Record<string, unknown> = {}): HookEvent => ({ hook_event_name, session_id: 's1', ...extra });
const NOW = T0 + 10_000;

describe('reduce', () => {
  it('UserPromptSubmit starts a new turn', () => {
    const prev = st({ state: 'done', errored: true, interrupted: true, stale: true, lastAssistantMessage: 'x', activity: 'a' });
    const r = reduce(prev, ev('UserPromptSubmit', { prompt: 'hi' }), NOW);
    expect(r).toEqual({ state: 'working', changedAt: NOW });
    expect(r.errored).toBeUndefined();
    expect(r.lastAssistantMessage).toBeUndefined();
  });

  it('PreToolUse sets working with activity', () => {
    const w = st({ state: 'working' });
    expect(reduce(w, ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), NOW))
      .toMatchObject({ state: 'working', activity: 'Bash: npm test', changedAt: NOW });
    const long = 'x'.repeat(100);
    expect(reduce(w, ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: long } }), NOW).activity)
      .toBe('Bash: ' + 'x'.repeat(60));
    for (const t of ['Edit', 'Write', 'Read']) {
      expect(reduce(w, ev('PreToolUse', { tool_name: t, tool_input: { file_path: '/a/b/c.ts' } }), NOW).activity).toBe(`${t}: c.ts`);
    }
    expect(reduce(w, ev('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'x' } }), NOW).activity).toBe('Grep');
  });

  it('PreToolUse AskUserQuestion waits; PostToolUse returns to working', () => {
    const w = reduce(st({ state: 'working' }), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }), NOW);
    expect(w.state).toBe('waiting');
    expect(reduce(w, ev('PostToolUse', { tool_name: 'AskUserQuestion' }), NOW + 5000).state).toBe('working');
  });

  it('records permission_mode from any event, even inside the done holdoff', () => {
    const d = st({ state: 'done', changedAt: NOW - 100 });
    expect(reduce(d, ev('PostToolUse', { permission_mode: 'auto' }), NOW)).toEqual({ ...d, permissionMode: 'auto' });
    expect(reduce(st({ state: 'working' }), ev('Stop', { permission_mode: 'plan' }), NOW)).toMatchObject({ state: 'done', permissionMode: 'plan' });
  });

  it('a permission request shows what the node waits on, and approval clears it', () => {
    const w = st({ state: 'working' });
    const b = reduce(w, ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'grep -r foo .' } }), NOW);
    expect(b).toMatchObject({ state: 'blocked', activity: 'needs approval: Bash grep -r foo .' });
    expect(reduce(w, ev('PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' } }), NOW).activity).toBe('needs approval: Edit b.ts');
    expect(reduce(w, ev('PermissionRequest', { tool_name: 'Grep', tool_input: {} }), NOW).activity).toBe('needs approval: Grep');
    // A later Notification without tool info keeps it; alone it falls back to the message.
    expect(reduce(b, ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }), NOW).activity).toBe(b.activity);
    expect(reduce(w, ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs permission' }), NOW).activity).toBe('Claude needs permission');
    expect(reduce(b, ev('PostToolUse', { tool_name: 'Bash' }), NOW + 1).activity).toBeUndefined();
  });

  it('AskUserQuestion shows the question', () => {
    const q = 'q'.repeat(100);
    expect(reduce(st({ state: 'working' }), ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q }] } }), NOW))
      .toMatchObject({ state: 'waiting', activity: 'question: ' + 'q'.repeat(60) });
  });

  it('PostToolUse sets working', () => {
    expect(reduce(st({ state: 'blocked' }), ev('PostToolUse', { tool_name: 'Bash' }), NOW).state).toBe('working');
  });

  it('PermissionRequest and permission_prompt block', () => {
    const w = st({ state: 'working' });
    expect(reduce(w, ev('PermissionRequest', { tool_name: 'Bash' }), NOW)).toMatchObject({ state: 'blocked', changedAt: NOW });
    expect(reduce(w, ev('Notification', { notification_type: 'permission_prompt' }), NOW).state).toBe('blocked');
  });

  it('elicitation_dialog and agent_needs_input wait', () => {
    for (const t of ['elicitation_dialog', 'agent_needs_input']) {
      expect(reduce(st({ state: 'working' }), ev('Notification', { notification_type: t }), NOW).state).toBe('waiting');
    }
  });

  it('idle_prompt finishes a working node without flags', () => {
    const r = reduce(st({ state: 'working', activity: 'Bash' }), ev('Notification', { notification_type: 'idle_prompt' }), NOW);
    expect(r).toEqual({ state: 'done', doneSource: 'idle_prompt', changedAt: NOW });
  });

  it('idle_prompt never sets waiting and changes nothing outside working', () => {
    for (const state of ['done', 'blocked', 'waiting', 'unknown'] as const) {
      const prev = st({ state });
      expect(reduce(prev, ev('Notification', { notification_type: 'idle_prompt' }), NOW)).toBe(prev);
    }
  });

  it('unknown notification types are ignored by reference', () => {
    const prev = st({ state: 'working' });
    expect(reduce(prev, ev('Notification', { notification_type: 'permission_whatever' }), NOW)).toBe(prev);
    expect(reduce(prev, ev('Notification', {}), NOW)).toBe(prev);
  });

  it('Stop finishes, with interrupt flag and message', () => {
    const w = st({ state: 'working', activity: 'Bash' });
    expect(reduce(w, ev('Stop', { last_assistant_message: 'ok' }), NOW)).toEqual({ state: 'done', doneSource: 'stop', lastAssistantMessage: 'ok', changedAt: NOW });
    expect(reduce(w, ev('Stop', { is_interrupt: true, last_assistant_message: 'ok' }), NOW).interrupted).toBe(true);
    expect(reduce(w, ev('Stop', { is_interrupt: false }), NOW).interrupted).toBeFalsy();
  });

  it('StopFailure finishes with errored', () => {
    const w = st({ state: 'working' });
    expect(reduce(w, ev('StopFailure', { last_assistant_message: 'API error' }), NOW))
      .toEqual({ state: 'done', doneSource: 'stop', errored: true, lastAssistantMessage: 'API error', changedAt: NOW });
    expect(reduce(w, ev('StopFailure'), NOW)).toMatchObject({ state: 'done', errored: true });
  });

  it('SessionStart and SessionEnd set unknown', () => {
    const r = reduce(st({ state: 'done' }), ev('SessionStart', { session_id: 's2', transcript_path: '/t.jsonl', cwd: '/', source: 'clear' }), NOW);
    expect(r).toMatchObject({ state: 'unknown', changedAt: NOW });
    expect(reduce(st({ state: 'working' }), ev('SessionEnd'), NOW).state).toBe('unknown');
  });

  it('other events apply across sessions', () => {
    expect(reduce(st({ state: 'done' }), ev('UserPromptSubmit', { session_id: 'new' }), NOW).state).toBe('working');
  });

  it('unrecognised events return prev by reference', () => {
    const prev = st({ state: 'working' });
    expect(reduce(prev, ev('SubagentStart'), NOW)).toBe(prev);
  });
});

describe('model and effort', () => {
  it('stamps model from SessionStart and effort from any event, even inside the done holdoff', () => {
    const d = st({ state: 'done', changedAt: NOW - 100 });
    expect(reduce(d, ev('PostToolUse', { effort: { level: 'high' } }), NOW)).toEqual({ ...d, effort: 'high' });
    const s = reduce(st({ state: 'working' }), ev('SessionStart', { model: 'claude-opus-5-5' }), NOW);
    expect(s).toMatchObject({ model: 'claude-opus-5-5', state: 'unknown', changedAt: NOW });
    expect(reduce(s, ev('Stop', {}), NOW).model).toBe('claude-opus-5-5');
  });
});

describe('done holdoff', () => {
  const done = st({ state: 'done', changedAt: T0 });
  it('ignores PostToolUse and PreToolUse within 3 s of done, by reference', () => {
    expect(reduce(done, ev('PostToolUse', { tool_name: 'Bash' }), T0 + 1000)).toBe(done);
    expect(reduce(done, ev('PreToolUse', { tool_name: 'Bash' }), T0 + 2999)).toBe(done);
  });
  it('does not ignore UserPromptSubmit', () => {
    expect(reduce(done, ev('UserPromptSubmit'), T0 + 1000).state).toBe('working');
  });
  it('accepts tool events once 3 s have passed', () => {
    expect(reduce(done, ev('PostToolUse', { tool_name: 'Bash' }), T0 + 3000).state).toBe('working');
  });
});

describe('stall', () => {
  const MIN5 = 5 * 60_000;
  it('marks a working node stalled after the limit, keeping changedAt; the next hook event clears it', () => {
    const w = st({ state: 'working', activity: 'Bash: npm test' });
    expect(stall(w, T0 + MIN5, MIN5)).toBe(w);
    const s = stall(w, T0 + MIN5 + 1, MIN5);
    expect(s).toEqual({ ...w, stalled: true });
    expect(stall(s, T0 + 2 * MIN5, MIN5)).toBe(s);
    expect(reduce(s, ev('PostToolUse'), T0 + 7 * 60_000)).toMatchObject({ state: 'working', stalled: undefined, changedAt: T0 + 7 * 60_000 });
    expect(sweep(s, T0 + 21 * 60_000)).toMatchObject({ state: 'done', stale: true, stalled: undefined });
  });
  it('leaves non-working nodes alone', () => {
    const d = st({ state: 'blocked' });
    expect(stall(d, T0 + 60 * 60_000, MIN5)).toBe(d);
  });
});

describe('sweep', () => {
  it('marks working nodes stale after 20 minutes', () => {
    const w = st({ state: 'working', activity: 'Bash' });
    expect(sweep(w, T0 + 20 * 60_000 + 1)).toEqual({ state: 'done', stale: true, doneSource: 'sweep', changedAt: T0 + 20 * 60_000 + 1 });
  });
  it('leaves recent working and non-working nodes alone', () => {
    const w = st({ state: 'working' });
    expect(sweep(w, T0 + 19 * 60_000)).toBe(w);
    const d = st({ state: 'done' });
    expect(sweep(d, T0 + 60 * 60_000)).toBe(d);
  });
});

describe('ptyExited', () => {
  it('sets exited and finishes active states, keeping flags', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      expect(ptyExited(st({ state, errored: true }), NOW)).toEqual({ state: 'done', doneSource: 'exit', errored: true, exited: true, changedAt: NOW });
    }
  });
  it('only sets exited for done and unknown', () => {
    expect(ptyExited(st({ state: 'done', interrupted: true }), NOW)).toEqual({ state: 'done', interrupted: true, exited: true, changedAt: NOW });
    expect(ptyExited(st({ state: 'unknown' }), NOW)).toEqual({ state: 'unknown', exited: true, changedAt: NOW });
  });
});

describe('interrupts', () => {
  it('detects a lone Esc or Ctrl-C only while working', () => {
    expect(interruptKeyPressed(st({ state: 'working' }), '\x1b')).toBe(true);
    expect(interruptKeyPressed(st({ state: 'working' }), '\x03')).toBe(true);
    expect(interruptKeyPressed(st({ state: 'working' }), 'a')).toBe(false);
    expect(interruptKeyPressed(st({ state: 'working' }), '\x1b[A')).toBe(false);
    expect(interruptKeyPressed(st({ state: 'done' }), '\x03')).toBe(false);
  });
  it('interruptTimeout flips working to done+interrupted, else no-op', () => {
    expect(interruptTimeout(st({ state: 'working', activity: 'Bash' }), NOW)).toEqual({ state: 'done', interrupted: true, doneSource: 'interrupt', changedAt: NOW });
    const d = st({ state: 'done' });
    expect(interruptTimeout(d, NOW)).toBe(d);
  });
});

describe('doneSource', () => {
  it('records how done was reached and clears it on a new turn', () => {
    const w = st({ state: 'working', changedAt: T0 });
    expect(reduce(w, ev('Stop'), NOW).doneSource).toBe('stop');
    expect(reduce(w, ev('StopFailure'), NOW).doneSource).toBe('stop');
    expect(reduce(w, ev('Notification', { notification_type: 'idle_prompt' }), NOW).doneSource).toBe('idle_prompt');
    expect(sweep(w, T0 + 21 * 60_000).doneSource).toBe('sweep');
    expect(interruptTimeout(w, NOW).doneSource).toBe('interrupt');
    expect(ptyExited(w, NOW).doneSource).toBe('exit');
    expect(reduce(reduce(w, ev('Stop'), NOW), ev('UserPromptSubmit'), NOW + 1).doneSource).toBeUndefined();
  });
});

describe('mod turn.complete', () => {
  const blocked = st({ state: 'blocked', activity: 'needs approval: Write tl-deny-probe.txt', promptId: 'p1' });
  it('an answer ends working, waiting and blocked as done, clearing the stale approval activity', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      const next = turnComplete({ ...blocked, state }, NOW, { reason: 'answer', isAborted: false });
      expect(next).toMatchObject({ state: 'done', activity: undefined, doneSource: 'stop', changedAt: NOW });
      expect(next.errored).toBeUndefined();
    }
  });
  it('a refusal ends the turn as plain done', () => {
    expect(turnComplete(blocked, NOW, { reason: 'refusal' })).toMatchObject({ state: 'done', activity: undefined, doneSource: 'stop' });
  });
  it('an aborted turn ends as done + interrupted, sourced as interrupt', () => {
    expect(turnComplete(blocked, NOW, { isAborted: true, reason: 'answer' })).toMatchObject({ state: 'done', interrupted: true, doneSource: 'interrupt', activity: undefined, changedAt: NOW });
  });
  it('an errored turn ends as done + errored', () => {
    expect(turnComplete(st({ state: 'working' }), NOW, { reason: 'error' })).toMatchObject({ state: 'done', errored: true, doneSource: 'stop', changedAt: NOW });
  });
  it('does nothing when the node is not mid-turn', () => {
    for (const state of ['done', 'unknown'] as const) {
      const idle = st({ state, doneSource: 'stop' });
      expect(turnComplete(idle, NOW, { reason: 'answer' })).toBe(idle);
    }
  });
});

describe('late permission events after the turn ended', () => {
  const ended = st({ state: 'done', changedAt: T0, promptId: 'p1', doneSource: 'stop' });
  it('Stop and turn.complete clear the activity', () => {
    expect(reduce(st({ state: 'blocked', activity: 'needs approval: Write x' }), ev('Stop'), NOW).activity).toBeUndefined();
  });
  it('a PermissionRequest or permission_prompt with the ended turn\'s prompt_id never re-blocks, even after the holdoff', () => {
    const later = T0 + 60_000;
    expect(reduce(ended, ev('PermissionRequest', { prompt_id: 'p1', tool_name: 'Write' }), later)).toBe(ended);
    expect(reduce(ended, ev('Notification', { notification_type: 'permission_prompt', prompt_id: 'p1' }), later)).toBe(ended);
    expect(reduce(ended, ev('Notification', { notification_type: 'elicitation_dialog', prompt_id: 'p1' }), later)).toBe(ended);
  });
  it('without a prompt_id on both events it falls back to the 3 s holdoff', () => {
    const bare = st({ state: 'done', changedAt: T0 });
    expect(reduce(bare, ev('PermissionRequest', { tool_name: 'Write' }), T0 + 1000)).toBe(bare);
    expect(reduce(bare, ev('PermissionRequest', { tool_name: 'Write' }), T0 + 3000).state).toBe('blocked');
  });
  it('a different prompt_id (a new turn) can still block', () => {
    expect(reduce(ended, ev('PermissionRequest', { prompt_id: 'p2', tool_name: 'Write' }), T0 + 60_000).state).toBe('blocked');
  });
  it('UserPromptSubmit records the prompt_id', () => {
    expect(reduce(ended, ev('UserPromptSubmit', { prompt_id: 'p2' }), NOW).promptId).toBe('p2');
  });
});
