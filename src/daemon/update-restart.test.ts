import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./autostart.js', () => ({ agentStatus: () => ({ loaded: true }), agentMatches: () => true, kickstart: vi.fn() }));
import { kickstart } from './autostart.js';
import { restartDaemon } from './up.js';

describe('release restart health verification (fake daemon only)', () => {
  let server: http.Server | undefined;
  afterEach(async () => { vi.restoreAllMocks(); vi.mocked(kickstart).mockReset(); await new Promise<void>((done) => server ? server.close(() => done()) : done()); });
  async function serve(sha: string, home = '/test-home') {
    let phase = 'old';
    vi.spyOn(process, 'kill').mockImplementation(() => { phase = 'stopped'; return true; });
    vi.mocked(kickstart).mockImplementation(() => { phase = 'new'; });
    server = http.createServer((_req, res) => {
      if (phase === 'stopped') return void res.writeHead(503).end('{}');
      res.end(JSON.stringify({ ok: true, pid: phase === 'old' ? 123 : 456, home, sha: phase === 'old' ? 'old' : sha, version: '0' }));
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    return (server.address() as { port: number }).port;
  }
  it('accepts only the expected commit after restart', async () => {
    const port = await serve('released');
    await restartDaemon('/test-home', port, 'released');
    expect(process.kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(kickstart).toHaveBeenCalledOnce();
  });
  it('rejects a daemon reporting the wrong commit', async () => {
    const port = await serve('wrong');
    await expect(restartDaemon('/test-home', port, 'released')).rejects.toThrow('expected commit released');
  });
  it('refuses to signal a daemon from another home', async () => {
    const port = await serve('released', '/other-home');
    await expect(restartDaemon('/test-home', port, 'released')).rejects.toThrow('another home');
    expect(process.kill).not.toHaveBeenCalled();
  });
});
