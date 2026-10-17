import { describe, expect, it } from 'vitest';
import { HARNESSES, harnessFor, isAgentKind, NODE_KINDS } from './protocol.js';

describe('node kinds and harnesses', () => {
  it('keeps claude and terminal and adds agent, so legacy values stay valid', () => {
    expect(NODE_KINDS).toEqual(['claude', 'agent', 'terminal']);
    expect(HARNESSES).toEqual(['claude', 'pi', 'codex']);
  });

  it('treats every kind but terminal as an agent', () => {
    expect(isAgentKind('claude')).toBe(true);
    expect(isAgentKind('agent')).toBe(true);
    expect(isAgentKind('terminal')).toBe(false);
  });

  it('defaults an absent harness to claude (legacy nodes and terminal callers)', () => {
    expect(harnessFor({})).toBe('claude');
    expect(harnessFor({ harness: 'pi' })).toBe('pi');
    expect(harnessFor({ harness: 'claude' })).toBe('claude');
  });
});
