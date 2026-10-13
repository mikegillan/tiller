import { describe, expect, it } from 'vitest';
import { mk } from './fixtures';
import { trayState } from './tray';

describe('trayState', () => {
  it('green with nothing to do, amber listing the nodes that need you, red once one errored', () => {
    const idle = mk('a', null, 1), waiting = { ...mk('b', null, 1), title: 'api' }, broken = mk('c', null, 1);
    waiting.status = { ...waiting.status, state: 'waiting' };
    broken.status = { ...broken.status, state: 'done', errored: true };
    expect(trayState([idle])).toEqual({ color: 'green', items: [] });
    expect(trayState([idle, waiting])).toEqual({ color: 'amber', items: [['b', 'api']] });
    expect(trayState([idle, waiting, broken])).toEqual({ color: 'red', items: [['b', 'api']] });
    expect(trayState([{ ...waiting, status: { ...waiting.status, exited: true } }]).color).toBe('green');
  });
});
