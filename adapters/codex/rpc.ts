import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Packet = { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: { code: number; message: string } };
export class RpcError extends Error {
  constructor(message: string, readonly code = -32000, readonly data?: unknown) { super(message); }
}

/** The app-server's stdio transport is one JSON object per line (no JSON-RPC version field). */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private readonly drained: Promise<void>;
  private readonly exited: Promise<void>;
  private shutdownTask?: Promise<void>;
  onPacket: (packet: Packet) => void = () => {};
  onClose: (error: Error) => void = () => {};

  constructor(env: NodeJS.ProcessEnv, stderr: (text: string) => void) {
    this.child = spawn('codex', ['app-server', '--listen', 'stdio://'], { env, stdio: 'pipe' });
    this.exited = new Promise<void>((resolve) => { this.child.once('exit', () => resolve()); });
    const lines = createInterface({ input: this.child.stdout });
    this.drained = new Promise<void>((resolve) => { lines.once('close', resolve); });
    lines.on('line', (line) => {
      let packet: Packet;
      try { packet = JSON.parse(line); } catch { this.fail(new Error('invalid JSON from Codex app-server')); return; }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
        this.fail(new Error('invalid packet from Codex app-server')); return;
      }
      if (!packet.method && typeof packet.id === 'number') {
        const request = this.pending.get(packet.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(packet.id);
        if (packet.error) request.reject(new RpcError(packet.error.message, packet.error.code, (packet.error as any).data));
        else request.resolve(packet.result);
      } else this.onPacket(packet);
    });
    this.child.stderr.on('data', (data) => stderr(data.toString()));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code) => {
      if (!this.closed) void this.shutdown().then(() => this.onClose(new Error(`Codex app-server exited (${code})`)));
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    this.onClose(error);
  }

  send(packet: Packet): void {
    if (this.closed) throw new Error('Codex app-server is closed');
    this.child.stdin.write(JSON.stringify(packet) + '\n');
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} response timed out; its outcome is unknown`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Let the stdout reader consume final buffered notifications, with a hard cutoff. */
  shutdown(): Promise<void> {
    return this.shutdownTask ??= this.drain();
  }

  private async drain(): Promise<void> {
    this.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.all([this.drained, this.exited]), new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      })]);
    } finally {
      clearTimeout(timer);
      this.child.kill('SIGKILL');
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.stdin.destroy();
    }
  }

  close(error = new Error('Codex connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }
}
