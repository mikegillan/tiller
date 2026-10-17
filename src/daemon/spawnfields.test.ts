import { describe, expect, it } from 'vitest';
import { SPAWN_FIELDS, spawnKind } from './spawnfields.js';

describe('SPAWN_FIELDS harness and kind', () => {
  it('accepts claude and pi and rejects anything else', () => {
    expect(SPAWN_FIELDS.harness.parse('pi')).toBe('pi');
    expect(SPAWN_FIELDS.harness.parse('claude')).toBe('claude');
    expect(SPAWN_FIELDS.harness.safeParse('bogus').success).toBe(false);
    expect(SPAWN_FIELDS.harness.safeParse(undefined).success).toBe(true);
  });

  it('accepts the agent kind alongside the legacy claude and terminal kinds', () => {
    expect(SPAWN_FIELDS.kind.parse('agent')).toBe('agent');
    expect(SPAWN_FIELDS.kind.parse('claude')).toBe('claude');
    expect(SPAWN_FIELDS.kind.parse('terminal')).toBe('terminal');
    expect(SPAWN_FIELDS.kind.safeParse('bogus').success).toBe(false);
  });
});

describe('spawnKind', () => {
  it('infers agent when --harness pi has no --kind', () => {
    expect(spawnKind(undefined, 'pi')).toBe('agent');
  });

  it('leaves an explicit kind untouched and defaults nothing without a pi harness', () => {
    expect(spawnKind('claude', 'pi')).toBe('claude');
    expect(spawnKind('terminal', 'pi')).toBe('terminal');
    expect(spawnKind(undefined, undefined)).toBeUndefined();
    expect(spawnKind(undefined, 'claude')).toBeUndefined();
  });
});

describe('profile validation shared by CLI, MCP and WebSocket', () => {
  it('accepts exactly the five task profiles and leaves coordination roles separate', () => {
    for (const profile of ['orchestrator', 'implementation', 'explorer', 'mechanical', 'reviewer']) expect(SPAWN_FIELDS.profile.parse(profile)).toBe(profile);
    expect(SPAWN_FIELDS.profile.parse(undefined)).toBeUndefined();
    for (const profile of ['worker', 'none', 'researcher', 'bogus']) expect(SPAWN_FIELDS.profile.safeParse(profile).success).toBe(false);
    expect(SPAWN_FIELDS.role.safeParse('implementation').success).toBe(false);
  });
});
