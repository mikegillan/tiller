import { describe, expect, it } from 'vitest';
import { cwdBase, titleFor } from './format';

describe('format', () => {
  it('cwdBase, titleFor', () => {
    expect([cwdBase('/a/b/'), cwdBase('/'), cwdBase('')]).toEqual(['b', '/', '/']);
    expect([titleFor(0), titleFor(2)]).toEqual(['orchestr8', '(2) orchestr8']);
  });
});
