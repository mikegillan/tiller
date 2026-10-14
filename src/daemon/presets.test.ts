import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchArgs, systemPrompt } from './launch.js';
import { NodeManager } from './manager.js';
import { DEFAULT_PRESETS, ensurePresets, listPresets, loadPreset } from './presets.js';

const dirs: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'tl-presets-'))); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const put = (dir: string, name: string, text: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${name}.md`), text); };

const GREETER = `---
name: greeter
model: haiku
effort: low
permissionMode: plan
tools: [Read, "Grep"]
disallowedTools:
  - Edit
  - Write
maxTurns: 5
unknownKey: ignored
---
# Greeter

Say marmalade.
`;

describe('presets', () => {
  it('parses agent-definition frontmatter, and the repo file wins over the home file', () => {
    const home = tmp(), repo = tmp();
    put(join(home, 'agents'), 'greeter', '---\nmodel: opus\n---\nhome body');
    expect(loadPreset('greeter', repo, home)).toMatchObject({ model: 'opus', body: 'home body', source: join(home, 'agents', 'greeter.md') });
    put(join(repo, '.tiller', 'agents'), 'greeter', GREETER);
    expect(loadPreset('greeter', repo, home)).toEqual({
      name: 'greeter', model: 'haiku', effort: 'low', permissionMode: 'plan', tools: ['Read', 'Grep'], disallowedTools: ['Edit', 'Write'], maxTurns: 5,
      body: '# Greeter\n\nSay marmalade.', source: join(repo, '.tiller', 'agents', 'greeter.md'),
    });
    expect(() => loadPreset('nope', repo, home)).toThrow(/no preset "nope"/);
    expect(() => loadPreset('../x', repo, home)).toThrow(/invalid preset name/);
    put(join(home, 'agents'), 'bad', '---\neffort: extreme\n---\n');
    expect(() => loadPreset('bad', repo, home)).toThrow(/effort/);
  });

  it('writes the built-in presets and records what it wrote', () => {
    const home = tmp();
    ensurePresets(home);
    expect(readFileSync(join(home, 'agents', 'reviewer.md'), 'utf8')).toBe(DEFAULT_PRESETS.reviewer);
    expect(JSON.parse(readFileSync(join(home, 'agents', '.builtin.json'), 'utf8'))).toEqual({ reviewer: sha256(DEFAULT_PRESETS.reviewer), researcher: sha256(DEFAULT_PRESETS.researcher) });
    expect(loadPreset('reviewer', home, home)).toMatchObject({ disallowedTools: ['Edit', 'Write', 'NotebookEdit'], isolation: 'none', effort: 'medium' });
    expect(loadPreset('reviewer', home, home)!.permissionMode).toBeUndefined();
    expect(loadPreset('researcher', home, home).tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
  });

  it('refreshes an unedited built-in file, and keeps an edited file or one with no record', () => {
    const home = tmp(), reviewer = join(home, 'agents', 'reviewer.md'), record = join(home, 'agents', '.builtin.json');
    const old = '---\npermissionMode: default\n---\nold reviewer';
    put(join(home, 'agents'), 'reviewer', old);
    writeFileSync(record, JSON.stringify({ reviewer: sha256(old) }));
    ensurePresets(home);
    expect(readFileSync(reviewer, 'utf8')).toBe(DEFAULT_PRESETS.reviewer);
    expect(JSON.parse(readFileSync(record, 'utf8')).reviewer).toBe(sha256(DEFAULT_PRESETS.reviewer));

    writeFileSync(reviewer, 'mine');
    ensurePresets(home);
    expect(readFileSync(reviewer, 'utf8')).toBe('mine');
    expect(JSON.parse(readFileSync(record, 'utf8')).reviewer).toBe(sha256(DEFAULT_PRESETS.reviewer));

    const fresh = tmp();
    put(join(fresh, 'agents'), 'reviewer', old);
    ensurePresets(fresh);
    expect(readFileSync(join(fresh, 'agents', 'reviewer.md'), 'utf8')).toBe(old);
  });

  it('passes the tool lists as a session agent, keeps the tiller tools, and appends the body as the role', () => {
    const home = tmp();
    put(join(home, 'agents'), 'greeter', GREETER);
    const preset = loadPreset('greeter', home, home);
    const base = { nodeId: 'n', nodeDir: '/tmp/n', endpoint: 'http://x', path: '', title: 't', parentId: 'p', home, cwd: home, sessionId: 's' };
    const args = launchArgs({ ...base, preset });
    expect(args[args.indexOf('--agent') + 1]).toBe('greeter');
    expect(JSON.parse(args[args.indexOf('--agents') + 1])).toEqual({
      greeter: { description: 'tiller preset greeter', prompt: '', tools: ['Read', 'Grep', 'mcp__tiller'], disallowedTools: ['Edit', 'Write'], maxTurns: 5 },
    });
    expect(systemPrompt({ ...base, preset })).toMatch(/# Role\n# Greeter\n\nSay marmalade\.$/);
    expect(launchArgs({ ...base, preset: { name: 'plain', body: '', source: '' } })).not.toContain('--agent');
  });

  it('tl presets lists the presets in effect with their source file', () => {
    const home = tmp(), repo = tmp();
    ensurePresets(home);
    put(join(repo, '.tiller', 'agents'), 'reviewer', GREETER);
    put(join(home, 'agents'), 'broken', '---\nisolation: sideways\n---\n');
    const r = spawnSync(join(import.meta.dirname, '../../bin/tl'), ['presets', '--cwd', repo], { env: { ...process.env, TL_HOME: home }, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    const lines = r.stdout.trim().split('\n').map((l) => l.split('\t'));
    expect(lines.map((l) => l[0])).toEqual(['broken', 'researcher', 'reviewer']);
    expect(lines[0][2]).toMatch(/^error: invalid preset .*isolation/);
    expect(lines[2]).toEqual(['reviewer', join(repo, '.tiller', 'agents', 'reviewer.md'), 'model=haiku effort=low permissionMode=plan tools=Read,Grep disallowedTools=Edit,Write maxTurns=5']);
    expect(listPresets(repo, home).map((p) => p.name)).toEqual(['broken', 'researcher', 'reviewer']);
  });
});

describe('spawn with a preset', () => {
  let m: NodeManager | undefined;
  afterEach(async () => { await m?.shutdown(); m = undefined; });

  it('records the preset fields and passes them to claude; explicit arguments win over the preset, which wins over config roles', async () => {
    const home = tmp(), proj = tmp(), bin = join(home, 'bin');
    mkdirSync(bin);
    // Fake claude: writes its argv, one per line, next to the node's settings.json, then idles.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do case "$prev" in --settings) out="$(dirname "$a")/argv";; esac; prev="$a"; done\nprintf "%s\\n" "$@" > "$out"\nsleep 5\n');
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ roles: { worker: { model: 'sonnet', effort: 'high' } } }));
    put(join(proj, '.tiller', 'agents'), 'greeter', GREETER);
    m = new NodeManager({ home, shell: '/bin/sh', path: `${bin}:/usr/bin:/bin` });
    const spawn = async (req: { model?: string; permissionMode?: string; preset?: string }) => m!.registry.get((await m!.spawn({ kind: 'claude', title: 'c', cwd: proj, parentId: 'p', ...req })).id)!;

    const g = await spawn({ preset: 'greeter' });
    expect(g).toMatchObject({ preset: 'greeter', model: 'haiku', effort: 'low', permissionMode: 'plan' });
    const argv = () => { try { return readFileSync(join(home, 'nodes', g.id, 'argv'), 'utf8').split('\n'); } catch { return []; } };
    await expect.poll(argv).toContain('--agent');
    const a = argv();
    const flag = (f: string) => a[a.indexOf(f) + 1];
    expect([flag('--model'), flag('--effort'), flag('--permission-mode'), flag('--agent')]).toEqual(['haiku', 'low', 'plan', 'greeter']);
    expect(a.join('\n')).toContain('# Role\n# Greeter\n\nSay marmalade.');

    expect(await spawn({ preset: 'greeter', model: 'opus', permissionMode: 'acceptEdits' })).toMatchObject({ model: 'opus', effort: 'low', permissionMode: 'acceptEdits' });
    expect(await spawn({})).toMatchObject({ model: 'sonnet', effort: 'high' });
    await expect(spawn({ preset: 'nope' })).rejects.toThrow(/no preset "nope"/);
  });
});
