import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeRegistry } from './nodes.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-nodes-'));
  file = join(dir, 'state.json');
});

const mk = (r: NodeRegistry, title: string, parentId: string | null = null) =>
  r.create({ parentId, kind: 'terminal', title, cwd: '/tmp' });

describe('NodeRegistry', () => {
  it('round-trips create/update/remove through the file, leaving no .tmp', async () => {
    const r = new NodeRegistry(file);
    const a = mk(r, 'a');
    const b = mk(r, 'b', a.id);
    const c = mk(r, 'c', b.id);
    expect(a.id).toMatch(/^n-[0-9a-f]{8}$/);
    r.update(b.id, { title: 'B2', sessionId: 's1' });
    r.remove(c.id);
    await new Promise((res) => setTimeout(res, 120));
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

  it('debounces: several changes produce one write', async () => {
    const r = new NodeRegistry(file);
    mk(r, 'a');
    mk(r, 'b');
    expect(readdirSync(dir)).toEqual([]);
    await new Promise((res) => setTimeout(res, 120));
    expect(JSON.parse(readFileSync(file, 'utf8')).nodes).toHaveLength(2);
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
