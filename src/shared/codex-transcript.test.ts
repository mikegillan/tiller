import { describe, expect, it } from 'vitest';
import { codexHeader } from './codex-transcript.js';

describe('Codex readable transcript header', () => {
  it('reads only the header and preserves native identity, fork intent and unknown metadata', () => {
    const header = { type: 'codex_session', threadId: 'native-id', fork: true, extra: { opaque: true } };
    expect(codexHeader(JSON.stringify(header) + '\ninvalid tail')).toEqual(header);
    expect(codexHeader(JSON.stringify(header))).toEqual(header);
  });

  it.each([null, {}, { type: 'session', threadId: 'native-id' }, { type: 'codex_session' },
    { type: 'codex_session', threadId: '' }, { type: 'codex_session', threadId: 1 }])('rejects an invalid header: %j', (header) => {
    expect(() => codexHeader(JSON.stringify(header))).toThrow('invalid Codex session header');
  });

  it('keeps native JSON parse errors for malformed JSON', () => {
    expect(() => codexHeader('invalid')).toThrow(SyntaxError);
  });
});
