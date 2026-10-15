import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(import.meta.dirname));
const SETUP = join(ROOT, 'bin/setup');

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A temp dir of stub executables, each printing `out`; stubs named in `log` append their arguments to dir/log. */
function stubs(bins: Record<string, string>, log: string[] = []) {
  dir = mkdtempSync(join(tmpdir(), 'tl-setup-'));
  const all: Record<string, string> = {
    uname: 'Darwin', 'xcode-select': '/Library/Developer/CommandLineTools', cargo: 'cargo 1.90.0', 'terminal-notifier': '',
    brew: `case "$2" in rustup) echo ${dir}/rustup;; *) echo ${dir}/brew;; esac`,
    ...bins,
  };
  for (const [name, out] of Object.entries(all)) {
    const body = name === 'brew' ? out : `echo "${out}"`;
    const logLine = log.includes(name) ? `echo "${name} $*" >> ${dir}/log\n` : '';
    writeFileSync(join(dir, name), `#!/bin/sh\n${logLine}${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  symlinkSync(join(ROOT, 'bin/tl'), join(dir, 'tl'));
  return dir;
}

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(SETUP, args, { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env } });

describe('bin/setup --check', () => {
  it('exits 0 when everything required is present and current', () => {
    stubs({ node: 'v24.1.0', claude: '2.1.0 (Claude Code)', pi: '1.2.3' });
    const r = run(['--check']);
    expect(r.stdout).toContain('ok             Node v24.1.0');
    expect(r.stdout).toContain(`ok             tl (${dir}/tl)`);
    expect(r.status).toBe(0);
  });

  it('exits 1 and names an old Node and the missing agent CLI', () => {
    stubs({ node: 'v22.0.0' });
    const r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/wrong version\s+Node v22\.0\.0 .*need 24 or newer\s+fix: brew install node/);
    expect(r.stdout).toMatch(/missing\s+Claude Code \(claude\)\s+fix: curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  });

  it('reports a Pi outside 1.2.x as the wrong version', () => {
    stubs({ node: 'v24.1.0', pi: '0.87.1' });
    const r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/wrong version\s+Pi 0\.87\.1, the adapter needs 1\.2\.x\s+fix: npm install -g @earendil-works\/pi-coding-agent@~1\.2\.0/);
  });
});

describe('bin/setup install', () => {
  it('runs the plan in order after one yes', () => {
    stubs({ node: 'v24.1.0', npm: '' }, ['brew', 'npm']);
    rmSync(join(dir, 'terminal-notifier'));
    writeFileSync(join(dir, 'answer'), 'y\n');
    const r = run(['--harness', 'pi', '--no-app'], { TL_SETUP_TTY: join(dir, 'answer') });
    expect(r.stdout).toContain('Plan:\n  1. npm install -g @earendil-works/pi-coding-agent@~1.2.0\n  2. brew install terminal-notifier\n  3. npm install\n  4. npm link\n');
    const log = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter((l) => !l.startsWith('brew --prefix'));
    expect(log).toEqual(['npm install -g @earendil-works/pi-coding-agent@~1.2.0', 'brew install terminal-notifier', 'npm install', 'npm link', '']);
    expect(r.stdout).toContain('Checking again:');
  });
});
