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

  it('reports a rustup proxy without a toolchain as missing, without letting it download one', () => {
    stubs({ node: 'v24.1.0', claude: '2.1.0 (Claude Code)' });
    writeFileSync(join(dir, 'cargo'), '#!/bin/sh\n[ "$RUSTUP_AUTO_INSTALL" = 0 ] && exit 1\necho cargo 1.90.0\n');
    const r = run(['--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/missing\s+Rust .*fix: brew install rustup && "\$\(brew --prefix rustup\)\/bin\/rustup" default stable/);
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

describe('Codex setup checks', () => {
  function codex(remote = true, listen = true) {
    stubs({ node: 'v24.1.0' });
    writeFileSync(join(dir, 'codex'), `#!/bin/sh
 echo "codex $*" >> ${dir}/log
 case "$*" in
   --version) echo 'codex-cli test' ;;
   --help) echo '${remote ? '--remote <ADDR>' : 'old CLI'}' ;;
   'app-server --help') echo '${listen ? '--listen <URL> stdio://' : 'old app-server'}' ;;
   *) exit 1 ;;
 esac
`);
    chmodSync(join(dir, 'codex'), 0o755);
  }

  it.each([{ args: [] }, { args: ['--harness', 'codex'] }, { args: ['--harness=codex'] }])('accepts Codex-only PATH with %j', ({ args }) => {
    codex();
    const result = run(['--check', '--no-app', ...args]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ok\s+Codex CLI codex-cli test/);
    expect(readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')).toEqual([
      'codex --version', 'codex --help', 'codex app-server --help',
    ]);
  });

  it('passes Codex through tl doctor to the read-only setup checks', () => {
    codex();
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/daemon/cli.ts'),
      'doctor', '--no-app', '--harness', 'codex'], {
      encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Everything required is in place.');
    expect(readFileSync(join(dir, 'log'), 'utf8')).toContain('codex app-server --help');
  });

  it('rejects failing help probes even when their output advertises the flags', () => {
    codex();
    writeFileSync(join(dir, 'codex'), '#!/bin/sh\necho "--remote --listen stdio://"\n[ "$1" = --version ]\n');
    expect(run(['--check', '--no-app', '--harness', 'codex']).status).toBe(1);
  });

  it.each([[false, true], [true, false]])('reports incompatible capabilities (remote=%s, listen=%s)', (remote, listen) => {
    codex(remote, listen);
    const result = run(['--check', '--no-app', '--harness', 'codex']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/incompatible\s+Codex CLI/);
    expect(result.stdout).toContain('--remote');
    expect(result.stdout).toContain('--listen');
  });

  it('reports missing Codex without executing installation or auth commands', () => {
    stubs({ node: 'v24.1.0', claude: '2.1.0 (Claude Code)' });
    const result = run(['--check', '--no-app', '--harness', 'codex']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/missing\s+Codex CLI/);
    expect(result.stderr).not.toContain('--harness takes');
  });

  it('lists all supported harnesses in setup and doctor help', () => {
    stubs({});
    expect(run(['--help']).stdout).toContain('--harness claude|pi|codex');
    expect(readFileSync(join(ROOT, 'src/daemon/cli.ts'), 'utf8')).toContain('tl doctor [--no-app] [--harness claude|pi|codex]');
  });
});
