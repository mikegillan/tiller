// Give the real Codex TUI a local WebSocket transport to the bridge's existing app-server.
// All native tool/approval requests keep their original ids; client requests get fresh upstream ids.
import { createServer } from 'node:http';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { RpcError, type Packet } from './rpc.js';
import type { Rpc } from './bridge.js';

export class CodexTerminal {
  private dir = mkdtempSync(join(tmpdir(), 'tl-codex-'));
  readonly socketPath = join(this.dir, 'ui.sock');
  private server = createServer();
  private ws = new WebSocketServer({ server: this.server });
  private peer?: WebSocket;
  private initialized = false;
  private pending: Packet[] = [];
  private started = false;

  constructor(private rpc: Rpc, private initialization: unknown, private threadId: string,
    private attached: () => void, fatal: (error: Error) => void, private emptyThread?: unknown) {
    chmodSync(this.dir, 0o700);
    this.ws.on('connection', (peer) => {
      if (this.peer) { peer.close(1008, 'This node already has a terminal'); return; }
      this.peer = peer;
      peer.on('message', (raw) => {
        try { void this.receive(JSON.parse(raw.toString()) as Packet).catch(fatal); }
        catch (error) { fatal(error as Error); }
      });
      peer.on('error', fatal);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => { this.server.off('error', reject); resolve(); });
    });
  }

  forward(packet: Packet): void {
    if (packet.method && packet.id !== undefined && !this.initialized) this.pending.push(packet);
    else if (this.initialized) this.peer?.send(JSON.stringify(packet));
  }

  private reply(packet: Packet): void { this.peer?.send(JSON.stringify(packet)); }

  private async receive(packet: Packet): Promise<void> {
    if (!packet.method) { this.rpc.send(packet); return; } // Native approval/input response.
    if (packet.method === 'initialize') { this.reply({ id: packet.id, result: this.initialization }); return; }
    if (packet.method === 'initialized') {
      this.initialized = true;
      for (const pending of this.pending) this.reply(pending);
      this.pending = [];
      return;
    }
    if (packet.method === 'thread/start' && this.emptyThread && !this.started) {
      // The bridge created this fresh thread before launching the TUI. Let the TUI take
      // its normal new-session path; trying to resume it would require a saved rollout.
      this.started = true;
      this.reply({ id: packet.id, result: this.emptyThread });
      this.attached();
      return;
    }
    // The node's persistent session must not silently switch underneath Tiller's registry.
    if (['thread/start', 'thread/fork'].includes(packet.method) ||
      (packet.method === 'thread/resume' && packet.params?.threadId !== this.threadId)) {
      this.reply({ id: packet.id, error: { code: -32600, message: 'Use Tiller restart/followup to change this managed session' } });
      return;
    }
    try {
      const result = await this.rpc.request(packet.method, packet.params ?? {});
      this.reply({ id: packet.id, result });
      if (packet.method === 'thread/resume') this.attached();
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      this.reply({ id: packet.id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } });
    }
  }

  close(): void {
    this.peer?.terminate();
    this.ws.close();
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
