import { describe, expect, it } from 'vitest';
import { ctxLevel, fmtAge, fmtTokens, shortEffort, shortModel } from './format.js';

describe('format', () => {
  it('shortens model ids', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5');
    expect(shortModel('claude-haiku-5-5')).toBe('haiku 5.5');
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1');
    expect(shortModel('claude-3-7-sonnet')).toBe('3-7-sonnet');
    expect(shortModel('gpt-x')).toBe('gpt-x');
    expect(shortModel(undefined)).toBe('');
  });
  it('shortens effort', () => {
    expect(shortEffort('medium')).toBe('med');
    expect(shortEffort('xhigh')).toBe('xhigh');
  });
  it('fmtAge', () => {
    expect([0, 4_000, 5_000, 59_000, 180_000, 3_600_000, 90_000_000, -5].map(fmtAge)).toEqual(['now', 'now', '5s', '59s', '3m', '1h', '1d', 'now']);
  });
  it('ctxLevel thresholds: green below 50, amber 50 to 80 inclusive, red above', () => {
    expect([0, 49.9, 50, 80, 80.1, 100].map(ctxLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad']);
  });
  it('fmtTokens', () => {
    expect([999, 84_000, 1_500_000].map(fmtTokens)).toEqual(['999', '84k', '1.5M']);
  });
});
