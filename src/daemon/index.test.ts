import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const freePort = () => new Promise<number>((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => res(port)); });
});

// The daemon's stdout goes to daemon.log, so its startup output must not carry the admin token.
it('starts without printing the admin token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tl-index-'));
  const port = await freePort();
  const child = spawn(join(import.meta.dirname, '../../bin/tld'), [], { env: { ...process.env, TL_HOME: home, TL_PORT: String(port) } });
  let out = '';
  try {
    await new Promise<void>((res, rej) => {
      child.stdout.on('data', (d) => { out += d; if (out.includes('home:')) res(); });
      child.stderr.on('data', (d) => { out += d; });
      child.once('exit', (code) => rej(new Error(`tld exited ${code}: ${out}`)));
    });
    const token = readFileSync(join(home, 'admin-token'), 'utf8').trim();
    expect(token).not.toBe('');
    expect(out).not.toContain(token);
    expect(out).toContain(`listening on http://127.0.0.1:${port}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((res) => (child.exitCode !== null ? res(null) : child.once('exit', res)));
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
