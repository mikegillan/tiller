import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./autostart.js', () => ({ agentStatus: () => ({ loaded: true }), agentMatches: () => true, kickstart: vi.fn() }));
import { kickstart } from './autostart.js';
import { restartDaemon } from './up.js';

// A home with the admin token the drain call before the restart reads.
const HOME = mkdtempSync(join(tmpdir(), 'tl-update-restart-'));
writeFileSync(join(HOME, 'admin-token'), 'admin');
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe('release restart health verification (fake daemon only)', () => {
  let server: http.Server | undefined;
  afterEach(async () => { vi.restoreAllMocks(); vi.mocked(kickstart).mockReset(); await new Promise<void>((done) => server ? server.close(() => done()) : done()); });
  async function serve(sha: string, home = HOME) {
    let phase = 'old';
    vi.spyOn(process, 'kill').mockImplementation(() => { phase = 'stopped'; return true; });
    vi.mocked(kickstart).mockImplementation(() => { phase = 'new'; });
    server = http.createServer((req, res) => {
      if (req.url === '/api/drain') return void res.end(JSON.stringify({ data: { reason: 'r', waiting: [] } }));
      if (phase === 'stopped') return void res.writeHead(503).end('{}');
      res.end(JSON.stringify({ ok: true, pid: phase === 'old' ? 123 : 456, home, sha: phase === 'old' ? 'old' : sha, version: '0' }));
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    return (server.address() as { port: number }).port;
  }
  it('accepts only the expected commit after restart', async () => {
    const port = await serve('released');
    await restartDaemon(HOME, port, 'released');
    expect(process.kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(kickstart).toHaveBeenCalledOnce();
  });
  it('rejects a daemon reporting the wrong commit', async () => {
    const port = await serve('wrong');
    await expect(restartDaemon(HOME, port, 'released')).rejects.toThrow('expected commit released');
  });
  it('refuses to signal a daemon from another home', async () => {
    const port = await serve('released', '/other-home');
    await expect(restartDaemon(HOME, port, 'released')).rejects.toThrow('another home');
    expect(process.kill).not.toHaveBeenCalled();
  });
});
