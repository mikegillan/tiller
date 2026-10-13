import { describe, expect, it } from 'vitest';
import { PtySession, buildChildEnv, classify, composerTextOf, loginShellPath } from './pty.js';

const base = { cwd: '/tmp', cols: 80, rows: 24 };
const env = () => buildChildEnv({});

async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function collect(s: PtySession) {
  const box = { out: '' };
  s.onData((d) => { box.out += d; });
  return box;
}

describe('PtySession', () => {
  it('delivers data, buffers it, and reports exit', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/sh', args: ['-c', 'printf "a\\nb\\n"; cat'], env: env(), rows: 10 });
    const box = collect(s);
    await until(() => box.out.includes('b'));
    await s.flush();
    const tail = s.screenTail(10);
    expect(tail).toContain('a');
    expect(tail).toContain('b');
    await s.write('hi\n');
    await until(() => box.out.includes('hi'));
    s.kill();
    await until(() => s.exited);
  });

  it('rejects a missing cwd with a clear error', () => {
    expect(() => PtySession.spawn({ ...base, cwd: '/no/such/dir', file: '/bin/sh', args: [], env: env() }))
      .toThrow(/working directory does not exist/);
  });

  it('paste strips ESC and writes concurrent writes in call order', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/cat', args: [], env: env() });
    const box = collect(s);
    const p = s.paste('x\x1b[201~y');
    const w1 = s.write('AAA');
    const w2 = s.write('BBB');
    await Promise.all([p, w1, w2]);
    await until(() => box.out.includes('BBB'));
    // The tty echoes ESC as ^[ ; the only ones are the frame markers, never from the body.
    expect(box.out).toContain('^[[200~x[201~y^[[201~');
    expect(box.out.indexOf('AAA')).toBeGreaterThan(box.out.indexOf('201~y'));
    expect(box.out.indexOf('BBB')).toBeGreaterThan(box.out.indexOf('AAA'));
    s.kill();
  });

  it('classifies a live screen through the headless buffer', async () => {
    const s = PtySession.spawn({ ...base, file: '/bin/sh', args: ['-c', 'printf "──────\\n❯ draft"; cat'], env: env(), rows: 10 });
    await until(() => { void s.flush(); return s.classifyScreen() === 'prompt'; });
    expect(s.composerText()).toBe('draft');
    s.kill();
  });
});

describe('classify', () => {
  const rule = '─'.repeat(40);
  it('prompt between rules', () => {
    expect(classify(['hello', rule, '❯', rule])).toBe('prompt');
    expect(classify(['hello', rule, '❯ half typed'])).toBe('prompt');
  });
  it('dialog footers and numbered options', () => {
    expect(classify(['Quick safety check', '❯ 1. Yes, I trust this folder', '  2. No, exit'])).toBe('dialog');
    expect(classify([rule, '❯', rule, 'Esc to cancel'])).toBe('dialog');
    expect(classify(['Enter to confirm'])).toBe('dialog');
  });
  it('unknown otherwise', () => {
    expect(classify(['$ ls', 'file'])).toBe('unknown');
    expect(classify([])).toBe('unknown');
  });
  it('composerText', () => {
    expect(composerTextOf([rule, '❯', rule])).toBe('');
    expect(composerTextOf([rule, '❯ fix the bug  '])).toBe('fix the bug');
  });
});

describe('env helpers', () => {
  it('buildChildEnv drops Claude/TERM vars and sets defaults', () => {
    const saved = { ...process.env };
    process.env.CLAUDECODE = '1';
    process.env.TERM_PROGRAM = 'x';
    const e = buildChildEnv({ O8_NODE_ID: 'n-1' });
    process.env = saved;
    expect(e.CLAUDECODE).toBeUndefined();
    expect(e.TERM_PROGRAM).toBeUndefined();
    expect(e.TERM).toBe('xterm-256color');
    expect(e.COLORTERM).toBe('truecolor');
    expect(e.LANG).toBeTruthy();
    expect(e.O8_NODE_ID).toBe('n-1');
  });
  it('loginShellPath returns a cached PATH', async () => {
    const p = await loginShellPath('/bin/sh'); // never the user's own login shell
    expect(p).toContain('/');
    expect(await loginShellPath('/bin/sh')).toBe(p);
  }, 15_000);
});
