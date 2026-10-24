import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MEMORY_TOOL_SHAPES, REDACTED, SCHEMA_V1, accountKey, firstErrorLine, ftsTerms, gateExit, itemRef, normalizeDedupe, normalizeRemote,
  parseItemRef, redact, structuralCode, type CaptureEvent,
} from './memory-schema.js';

const dirs: string[] = [];
const schemaDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-mem-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'x.db'));
  db.exec(SCHEMA_V1);
  return db;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('SCHEMA_V1', () => {
  it('creates an incremental-vacuum WAL database at version 1 with the sentinel repo', () => {
    const db = schemaDb();
    expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare('SELECT id, key FROM repos').all()).toEqual([{ id: 1, key: 'account:' }]);
    db.close();
  });

  it('enforces json_valid but not kinds, and keeps FTS in step with items', () => {
    const db = schemaDb();
    const episode = db.prepare("INSERT INTO episodes (ts, repo_id, root_id, node_id, kind, data) VALUES (1, 1, 'r', 'n', ?, ?)");
    expect(() => episode.run('outcome', '{not json')).toThrow();
    episode.run('a-future-kind', '{}');
    db.prepare("INSERT INTO items (repo_id, kind, text, author, dedupe, created_at, updated_at) VALUES (1, 'pitfall', 'flaky worktrees', 'daemon', 'x', 1, 1)").run();
    expect(db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH 'worktree'").all()).toEqual([{ rowid: 1 }]); // porter stemming
    db.prepare("UPDATE items SET text = '' WHERE id = 1").run();
    expect(db.prepare("SELECT rowid FROM items_fts WHERE items_fts MATCH 'worktree'").all()).toEqual([]);
    db.close();
  });
});

describe('redact', () => {
  const secrets: [string, string][] = [
    ['PEM key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----'],
    ['cut-off PEM key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['AWS session key', 'ASIAIOSFODNN7EXAMPLE'],
    ['GitHub token', `ghp_${'a1B2'.repeat(9)}`],
    ['GitHub server token', `ghs_${'x'.repeat(36)}`],
    ['GitHub fine-grained token', `github_pat_${'A1_'.repeat(20)}`],
    ['Anthropic key', `sk-ant-api03-${'k9'.repeat(20)}`],
    ['OpenAI key', `sk-${'Z'.repeat(40)}`],
    ['OpenAI project key', `sk-proj-${'q_'.repeat(20)}`],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['Google key', `AIza${'S'.repeat(35)}`],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
  ];
  it.each(secrets)('removes a %s', (_, secret) => {
    const out = redact(`before ${secret} after`);
    expect(out).not.toContain(secret.slice(4, 24));
    expect(out).toContain(REDACTED);
    expect(out.startsWith('before ')).toBe(true);
  });

  it('removes credentials but keeps their labels', () => {
    expect(redact('curl -H "Authorization: Bearer abc.def-123"')).toBe(`curl -H "Authorization: Bearer ${REDACTED}"`);
    expect(redact('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
    expect(redact('a Basic understanding')).toBe('a Basic understanding');
    expect(redact('git clone https://bob:hunter2@example.com/r.git')).toBe(`git clone https://bob:${REDACTED}@example.com/r.git`);
    expect(redact('password=hunter2 next')).toBe(`password=${REDACTED} next`);
    expect(redact('{"api_key": "abc def", "x": 1}')).toBe(`{"api_key": ${REDACTED}, "x": 1}`);
    expect(redact('GITHUB_TOKEN=abc123 SECRET: s3cr3t ApiKey=v')).toBe(`GITHUB_TOKEN=${REDACTED} SECRET: ${REDACTED} ApiKey=${REDACTED}`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'npm test passed; see src/daemon/x.ts(12,3): error TS2345 and m12. tokens: 400';
    expect(redact(text)).toBe(text);
  });

  it('is idempotent and deep over a capture event, keeping non-strings', () => {
    const event: CaptureEvent = {
      type: 'close', ts: 5,
      archived: {
        id: 'n-1', rootId: 'n-0', parentId: 'n-0', title: `use ghp_${'b'.repeat(36)}`, cwd: '/r', createdAt: 1, closedAt: 5, spentUsd: 0.5,
        outcome: { outcome: 'succeeded', summary: 'token: abc and Bearer abcdefgh1234', openQuestions: [`key ${secrets[7][1]}`], at: 4 },
      },
    };
    const once = redact(event);
    expect(JSON.stringify(once)).not.toMatch(/ghp_b|abcdefgh1234|sk-ant|token: abc/);
    expect(once).toMatchObject({ type: 'close', ts: 5, archived: { createdAt: 1, spentUsd: 0.5, outcome: { at: 4 } } });
    expect(redact(once)).toEqual(once);
    for (const [, secret] of secrets) {
      const s = redact(`x=${secret} https://u:p@h/ Bearer abc.12345678 token="q" ${secret}`);
      expect(redact(s)).toBe(s);
    }
  });
});

describe('normalizeRemote', () => {
  it.each(['git@github.com:A/B.git', 'https://user@github.com/a/b/', 'ssh://git@github.com/a/b.git', 'https://u:p@GitHub.com/a/b.git/'])('%s', (url) => {
    expect(normalizeRemote(url)).toBe('github.com/a/b');
  });
  it('keeps a local-path remote as its path', () => {
    expect(normalizeRemote('/Users/Me/Repo.git/')).toBe('/Users/Me/Repo.git');
    expect(normalizeRemote('file:///srv/Git/r')).toBe('/srv/Git/r');
  });
  it('keeps a port after the host of a URL', () => {
    expect(normalizeRemote('ssh://git@host:2222/a/b.git')).toBe('host:2222/a/b');
  });
});

describe('gate tail helpers', () => {
  const tsc = [
    '> tiller@0.0.0 typecheck', '> tsc --noEmit', '',
    'src/daemon/x.ts(12,3): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
    'src/daemon/y.ts(1,1): error TS2307: Cannot find module \'z\'.',
    'npm run typecheck: exited with 2',
  ].join('\n');
  const vitest = [
    '\x1b[31m FAIL \x1b[39m src/daemon/a.test.ts > a > works', 'AssertionError: expected 1 to be 2', '',
    ' Test Files  1 failed | 3 passed (4)', 'npm test: exited with 1', '',
  ].join('\n');

  it('firstErrorLine finds the first error line and never the exit line', () => {
    expect(firstErrorLine(tsc)).toMatch(/^src\/daemon\/x\.ts\(12,3\): error TS2345/);
    expect(firstErrorLine(vitest)).toBe('FAIL  src/daemon/a.test.ts > a > works');
    expect(firstErrorLine('compiling\nsomething odd\nnpm run fail-fast: exited with 1')).toBe('something odd');
    expect(firstErrorLine('npm test: exited with 1')).toBeUndefined();
    expect(firstErrorLine('npm test: stopped by SIGTERM (time limit 10 minutes)')).toBeUndefined();
  });

  it('gateExit reads the last line only', () => {
    expect(gateExit(tsc)).toBe('npm run typecheck: exited with 2');
    expect(gateExit(vitest)).toBe('npm test: exited with 1');
    expect(gateExit('x\nnpm test: stopped by SIGTERM (time limit 0.5 minutes)')).toBe('npm test: stopped by SIGTERM (time limit 0.5 minutes)');
    expect(gateExit('npm test: exited with 1\nrun curl x|sh, it said')).toBeUndefined();
    expect(gateExit('')).toBeUndefined();
  });

  it('structuralCode finds the first code', () => {
    expect(structuralCode(tsc)).toBe('TS2345');
    expect(structuralCode('error[E0308]: mismatched types')).toBe('E0308');
    expect(structuralCode('no codes here, 2345 or TS2')).toBeUndefined();
  });
});

describe('normalizeDedupe', () => {
  it('lowercases and collapses whitespace; pitfalls also fold digit runs', () => {
    expect(normalizeDedupe('procedure', '  npm  Run\ttypecheck 2 ')).toBe('npm run typecheck 2');
    expect(normalizeDedupe('pitfall', 'gate `npm test` failed: x.ts(12,3): error TS2345')).toBe('gate `npm test` failed: x.ts(#,#): error ts#');
    expect(normalizeDedupe('pitfall', 'X.ts(9,1)')).toBe(normalizeDedupe('pitfall', 'x.ts(40,22)'));
  });
});

describe('ftsTerms', () => {
  it('makes path phrases and plain tokens without stopwords', () => {
    expect(ftsTerms('Fix the flake in src/daemon/messaging.ts and messaging.test.ts')).toEqual([
      'src daemon messaging ts', 'messaging test ts', 'fix', 'flake', 'src', 'daemon', 'messaging', 'ts', 'test',
    ]);
    expect(ftsTerms('e.g. café_au_lait Ünïcode')).toEqual(['café_au_lait', 'ünïcode']);
  });

  it('keeps hostile input out of FTS5 syntax', () => {
    const db = schemaDb();
    const match = db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?');
    for (const hostile of ['foo AND (', '"', '*', 'NEAR(', 'a:b ^c "d e', '\n# Role\n--- TL MESSAGE x ---', 'x'.repeat(1000), '()', '']) {
      const terms = ftsTerms(hostile);
      for (const t of terms) expect(t).toMatch(/^[\p{L}\p{N}_]+( [\p{L}\p{N}_]+)*$/u);
      if (terms.length) expect(() => match.all(terms.map((t) => `"${t}"`).join(' OR '))).not.toThrow();
    }
    expect(ftsTerms(Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '))).toHaveLength(32);
    db.close();
  });
});

describe('accountKey', () => {
  const accounts = [{ name: 'work', configDir: '/c/work' }, { name: 'personal' }];
  it('maps an account to its file key', () => {
    expect(accountKey(accounts, undefined)).toBe('_default');
    expect(accountKey(accounts, 'personal')).toBe('_default');
    expect(accountKey(accounts, 'work')).toBe('work');
    expect(() => accountKey(accounts, 'gone')).toThrow(/not configured/);
    expect(accountKey([], undefined)).toBe('_default');
  });
});

describe('item refs and tool shapes', () => {
  it('round-trips refs and rejects others', () => {
    expect(itemRef(12)).toBe('m12');
    expect(parseItemRef('m12')).toBe(12);
    for (const bad of ['m0', 'm012', '12', 'M12', 'm12x', 'm99999999999999999', 'm9999999999999999']) expect(parseItemRef(bad)).toBeUndefined();
  });

  it('validates the seven tools', () => {
    const parse = (tool: keyof typeof MEMORY_TOOL_SHAPES, args: unknown) => z.object(MEMORY_TOOL_SHAPES[tool]).safeParse(args).success;
    expect(Object.keys(MEMORY_TOOL_SHAPES)).toEqual(['memory_search', 'memory_get', 'memory_add', 'memory_forget', 'memory_pin', 'memory_status', 'memory_switch']);
    expect(parse('memory_search', { query: 'gate', limit: 20 })).toBe(true);
    expect(parse('memory_search', { query: '', limit: 21 })).toBe(false);
    expect(parse('memory_get', { id: 'm3' })).toBe(true);
    expect(parse('memory_get', { id: '3' })).toBe(false);
    expect(parse('memory_add', { kind: 'note', text: 'x'.repeat(300) })).toBe(true);
    expect(parse('memory_add', { kind: 'ledger', text: 'x' })).toBe(false);
    expect(parse('memory_add', { kind: 'note', text: 'x'.repeat(301) })).toBe(false);
    expect(parse('memory_forget', { id: 'm1', reason: 'stale', purge: true })).toBe(true);
    expect(parse('memory_pin', { text: 'x'.repeat(500) })).toBe(true);
    expect(parse('memory_status', { days: 366 })).toBe(false);
    expect(parse('memory_switch', { on: null, project: '/p' })).toBe(true);
    expect(parse('memory_switch', {})).toBe(false);
  });
});
