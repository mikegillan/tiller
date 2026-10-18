import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSidebarWidth, saveSidebarWidth, sidebarBounds, sidebarWidth } from './SidebarResize';

afterEach(() => vi.unstubAllGlobals());

describe('sidebar width boundaries and preference', () => {
  it('keeps desktop bounds and reserves terminal space as the window narrows', () => {
    expect(sidebarBounds(1400)).toEqual({ min: 240, max: 640 });
    expect(sidebarWidth(900, 1400)).toBe(640);
    expect(sidebarWidth(100, 1400)).toBe(240);
    expect(sidebarBounds(900)).toEqual({ min: 240, max: 540 });
    expect(sidebarWidth(640, 900)).toBe(540);
    expect(sidebarBounds(500)).toEqual({ min: 200, max: 200 });
    expect(sidebarWidth(640, 500)).toBe(200);
    expect(sidebarWidth(640, 0)).toBe(0);
    expect(sidebarWidth(640, 900, true)).toBe(232);
    expect(900 - 320 - sidebarWidth(640, 900, true)).toBe(348);
    expect(sidebarWidth(640, 0, true)).toBe(0);
  });

  it('clamps only the displayed width and keeps the saved desktop preference', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => '600', setItem });
    const preferred = readSidebarWidth();
    expect(sidebarWidth(preferred, 900)).toBe(540);
    expect(sidebarWidth(preferred, 500)).toBe(200);
    expect(sidebarWidth(preferred, 1400)).toBe(600);
    expect(setItem).not.toHaveBeenCalled();
    saveSidebarWidth(480);
    expect(setItem).toHaveBeenCalledWith('tl.sidebarWidth', '480');
  });

  it('normalizes explicit narrow minimum/drag widths before save so reload restores the same preference', () => {
    let stored = '600';
    vi.stubGlobal('localStorage', { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
    for (const explicitWidth of [sidebarBounds(500).min, sidebarWidth(100, 500), sidebarBounds(900, true).min]) {
      saveSidebarWidth(explicitWidth);
      expect(stored).toBe('240');
      const reloaded = readSidebarWidth();
      expect(reloaded).toBe(240);
      expect(sidebarWidth(reloaded, 500)).toBe(200);
      expect(sidebarWidth(reloaded, 1400)).toBe(240);
    }
  });

  it.each([null, '', 'NaN', 'Infinity', 'nonsense', '239', '641'])('rejects invalid stored width %s', (raw) => {
    vi.stubGlobal('localStorage', { getItem: () => raw });
    expect(readSidebarWidth()).toBe(320);
  });

  it('continues without browser storage', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } });
    expect(readSidebarWidth()).toBe(320);
    expect(() => saveSidebarWidth(480)).not.toThrow();
  });
});
