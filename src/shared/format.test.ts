import { describe, expect, it } from 'vitest';
import { shortEffort, shortModel } from './format.js';

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
});
