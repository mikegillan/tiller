import { describe, expect, it } from 'vitest';
import { ctxLevel, cwdBase, fmtAge, fmtTokens, titleFor } from './format';

describe('format', () => {
  it('fmtAge', () => {
    expect([0, 4_000, 5_000, 59_000, 180_000, 3_600_000, 90_000_000, -5].map(fmtAge)).toEqual(['now', 'now', '5s', '59s', '3m', '1h', '1d', 'now']);
  });

  it('ctxLevel thresholds: green below 50, amber 50 to 80 inclusive, red above', () => {
    expect([0, 49.9, 50, 80, 80.1, 100].map(ctxLevel)).toEqual(['ok', 'ok', 'warn', 'warn', 'bad', 'bad']);
  });

  it('fmtTokens, cwdBase, titleFor', () => {
    expect([999, 84_000, 1_500_000].map(fmtTokens)).toEqual(['999', '84k', '1.5M']);
    expect([cwdBase('/a/b/'), cwdBase('/'), cwdBase('')]).toEqual(['b', '/', '/']);
    expect([titleFor(0), titleFor(2)]).toEqual(['orchestr8', '(2) orchestr8']);
  });
});
