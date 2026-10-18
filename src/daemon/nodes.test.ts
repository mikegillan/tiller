import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeRegistry } from './nodes.js';

let dir: string;
let file: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  dir = mkdtempSync(join(tmpdir(), 'tl-nodes-'));
  file = join(dir, 'state.json');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const mk = (r: NodeRegistry, title: string, parentId: string | null = null) =>
  r.create({ parentId, kind: 'terminal', title, cwd: '/tmp' });

describe('NodeRegistry', () => {
  it('round-trips create/update/remove through the file, leaving no .tmp', () => {
    const r = new NodeRegistry(file);
    const a = mk(r, 'a');
    const b = mk(r, 'b', a.id);
    const c = mk(r, 'c', b.id);
    expect(a.id).toMatch(/^n-[0-9a-f]{8}$/);
    r.update(b.id, { title: 'B2', sessionId: 's1' });
    r.remove(c.id);
    vi.advanceTimersByTime(50);
    expect(readdirSync(dir)).toEqual(['state.json']);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);

    const r2 = new NodeRegistry(file);
    r2.load();
    expect(r2.list().map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(r2.get(b.id)).toMatchObject({ title: 'B2', sessionId: 's1' });
    expect(r2.lineage(b.id).map((n) => n.id)).toEqual([a.id]);
  });

  it('lineage lists ancestors nearest first', () => {
    const r = new NodeRegistry(file);
    const a = mk(r, 'a');
    const b = mk(r, 'b', a.id);
    const c = mk(r, 'c', b.id);
    expect(r.lineage(c.id).map((n) => n.id)).toEqual([b.id, a.id]);
    r.flush();
  });

  it('debounces: several changes produce one write', () => {
    const r = new NodeRegistry(file);
    const flush = vi.spyOn(r, 'flush');
    const a = mk(r, 'a');
    mk(r, 'b');
    r.update(a.id, { title: 'A2' });
    expect(readdirSync(dir)).toEqual([]);
    vi.advanceTimersByTime(49);
    expect(readdirSync(dir)).toEqual([]);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes).toHaveLength(2);
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes.map((n: { title: string }) => n.title)).toEqual(['A2', 'b']);
    expect(readdirSync(dir)).toEqual(['state.json']);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renames a corrupt file aside and starts empty', () => {
    writeFileSync(file, '{ not json');
    const r = new NodeRegistry(file);
    expect(() => r.load()).not.toThrow();
    expect(r.list()).toEqual([]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^state\.json\.corrupt-\d+$/);
  });

  it('load with no file is empty', () => {
    const r = new NodeRegistry(file);
    r.load();
    expect(r.list()).toEqual([]);
  });
});
