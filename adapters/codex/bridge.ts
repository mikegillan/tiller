import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { codexHeader } from '../../src/daemon/codex-session.js';
import { TillerClient, type InboxMessage } from '../pi/client.js';
import { RpcError, type Packet } from './rpc.js';

export interface BridgeOptions {
  transcriptPath: string;
  sessionId: string;
  resume: boolean;
  instructions: string;
  prompt?: string;
  model?: string;
  effort?: string;
}
export interface Rpc {
  request(method: string, params: Record<string, unknown>): Promise<any>;
  send(packet: Packet): void;
}

/** App-server notifications own turn boundaries; turn/start's response proves prompt acceptance. */
export class CodexBridge {
  private threadId = '';
  initialization: unknown;
  startResult: unknown;
  hasHistory = false;
  get nativeThreadId(): string { return this.threadId; }
  private turnId?: string;
  private busy = false;
  private polling = false;
  private submitting = false;
  private interrupted?: string;
  private answer = '';
  private model?: string;
  private queue = Promise.resolve();
  private receipts = new Set<string>();
  private ambiguous = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private o: BridgeOptions, private rpc: Rpc, private client: TillerClient,
    private print: (text: string) => void, private fatal: (error: Error) => void) {}

  async start(endpoint: string, nodeId: string): Promise<void> {
    this.initialization = await this.rpc.request('initialize', { clientInfo: { name: 'tiller', title: 'Tiller', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    this.rpc.send({ method: 'initialized' });
    const name = `tl_${randomBytes(6).toString('hex')}`;
    const params: Record<string, unknown> = {
      cwd: process.cwd(), developerInstructions: this.o.instructions + `

# Tiller coordination
When the user asks for workers or subagents in this Tiller session, use the ${name} MCP server's spawn tool with kind \"agent\" and harness \"codex\". These are the independent sessions visible in Tiller. Codex's built-in spawn_agent tool creates internal agents that do not appear in Tiller; do not use it for Tiller workers. Use Tiller send/read/report_outcome to coordinate them. The built-in reviewer/researcher presets contain Claude-specific restrictions; for Codex workers use a self-contained read-only review/research prompt instead of those presets.`,
      ...(this.o.model ? { model: this.o.model } : {}),
      config: { [`mcp_servers.${name}`]: {
        url: `${endpoint.replace(/\/+$/, '')}/mcp`, required: true,
        http_headers: { 'X-TL-Node': nodeId }, env_http_headers: { Authorization: 'TL_CODEX_AUTHORIZATION' },
      } },
    };
    let history = '', method = 'thread/start';
    if (this.o.resume) {
      history = readFileSync(this.o.transcriptPath, 'utf8');
      const header = codexHeader(history);
      params.threadId = header.threadId;
      method = header.fork ? 'thread/fork' : 'thread/resume';
    }
    let result;
    try { result = await this.rpc.request(method, params); } catch (error) {
      // Codex does not persist a rollout until the first turn. An untouched session can be
      // recreated, but never silently replace a missing conversation that has recorded messages.
      const tail = history.slice(history.indexOf('\n') + 1).trim();
      if (!this.o.resume || tail || !(error instanceof RpcError) || !error.message.includes('no rollout found for thread id')) throw error;
      const { threadId: _old, ...fresh } = params;
      result = await this.rpc.request('thread/start', fresh);
    }
    if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw new Error('Codex returned no thread id');
    this.threadId = result.thread.id;
    this.startResult = result;
    this.hasHistory = !!history.slice(history.indexOf('\n') + 1).trim();
    this.model = result.model ?? this.o.model;
    mkdirSync(dirname(this.o.transcriptPath), { recursive: true, mode: 0o700 });
    // Persist native identity before accepting any prompt. Never touch the source archive.
    const tmp = `${this.o.transcriptPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ type: 'codex_session', threadId: this.threadId }) + '\n' +
      (history ? history.slice(history.indexOf('\n') + 1) : ''), { mode: 0o600 });
    renameSync(tmp, this.o.transcriptPath);
    await this.client.hook({ hook_event_name: 'SessionStart', session_id: this.o.sessionId,
      transcript_path: this.o.transcriptPath, model: this.model });
  }

  startPolling(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.poll().catch((e) => this.print(`Tiller inbox: ${e.message}\n`)); }, 1000);
  }

  handle(packet: Packet): void {
    this.queue = this.queue.then(() => this.event(packet)).catch((error) => this.fatal(error));
  }

  private append(role: 'user' | 'assistant', content: unknown): void {
    appendFileSync(this.o.transcriptPath, JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { content } }) + '\n', { mode: 0o600 });
  }

  private async event(p: Packet): Promise<void> {
    if (this.stopped) return;
    const v = p.params ?? {};
    if (v.threadId && v.threadId !== this.threadId) return;
    if (p.id !== undefined && p.method) {
      // The real Codex TUI handles every approval/input request. Only mirror its waiting state.
      if (p.method.endsWith('/requestApproval') || p.method.endsWith('/requestUserInput') || p.method === 'mcpServer/elicitation/request') {
        await this.client.hook({ hook_event_name: 'Notification', notification_type:
          p.method.includes('Approval') ? 'permission_prompt' : 'elicitation_dialog', message: v.reason ?? p.method });
      }
    } else if (p.method === 'serverRequest/resolved') {
      if (this.busy) await this.client.hook({ hook_event_name: 'PostToolUse' });
    } else if (p.method === 'thread/settings/updated' && typeof v.threadSettings?.model === 'string') {
      this.model = v.threadSettings.model;
      await this.client.modEvent('session.measure', { model: this.model });
    } else if (p.method === 'turn/started') {
      this.busy = true;
      this.turnId = v.turn?.id;
      this.answer = '';
      this.interrupted = undefined;
      await this.client.modEvent('turn.start', { turnId: this.turnId });

    } else if (p.method === 'item/started' || p.method === 'item/completed') {
      const item = v.item;
      if (!item || typeof item.type !== 'string') return;
      if (item.type === 'userMessage' && p.method === 'item/completed' && Array.isArray(item.content)) {
        this.append('user', item.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string'));
      }
      if (item.type === 'agentMessage' && p.method === 'item/completed' && typeof item.text === 'string') {
        this.answer = item.text;
        this.append('assistant', item.text);
      }
      const tool = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit'
        : item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : undefined;
      if (tool) {
        if (p.method === 'item/completed') this.append('assistant', [{ type: 'tool_use', name: tool }]);
        await this.client.hook({ hook_event_name: p.method === 'item/started' ? 'PreToolUse' : 'PostToolUse',
          tool_name: tool, tool_input: { command: item.command, file_path: item.changes?.[0]?.path } });
      }
    } else if (p.method === 'thread/tokenUsage/updated') {
      const tokens = v.tokenUsage?.last?.totalTokens, window = v.tokenUsage?.modelContextWindow;
      if (Number.isFinite(tokens) && Number.isFinite(window) && window > 0) {
        await this.client.modEvent('session.measure', { context: { tokens, window, percent: tokens / window * 100 }, model: this.model });
      }
    } else if (p.method === 'turn/completed') {
      const turn = v.turn;
      if (!turn || typeof turn.id !== 'string') throw new Error('invalid Codex turn completion');
      this.busy = false;
      this.turnId = undefined;
      await this.client.modEvent('turn.complete', { turnId: turn.id, answer: this.answer,
        isAborted: turn.status === 'interrupted', reason: turn.status === 'failed' ? 'error' : 'answer', usage: { model: this.model } });
    }
  }

  private async submit(text: string, message?: InboxMessage): Promise<void> {
    if (this.busy || this.submitting) throw new Error('Codex is busy; wait for completion or use /interrupt');
    this.busy = true;
    this.submitting = true;
    try {
      const result = await this.rpc.request('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }], ...(this.o.effort ? { effort: this.o.effort } : {}) });
      if (typeof result?.turn?.id !== 'string') throw new Error('Codex turn acceptance is unknown');
      if (this.busy) this.turnId = result.turn.id;
      if (message) this.receipts.add(message.id);
    } catch (error) {
      if (error instanceof RpcError) {
        this.busy = false;
        if (message) await this.client.release(message.id);
      } else {
        // A lost response may still have started the turn. Never replay this submission.
        if (message) this.ambiguous.add(message.id);
        this.fatal(error as Error);
      }
      throw error;
    } finally { this.submitting = false; }
  }

  async interrupt(): Promise<void> {
    if (!this.turnId || this.interrupted === this.turnId) return;
    const id = this.turnId;
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: id });
    this.interrupted = id;
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const id of this.receipts) { await this.client.ack(id); this.receipts.delete(id); }
      for (const id of this.ambiguous) { await this.client.unconfirmed(id); this.ambiguous.delete(id); }
      const inbox = await this.client.inbox();
      // Claims inherited from a crashed adapter have an unknown outcome; never submit them again.
      for (const msg of inbox.filter((m) => m.claimed)) await this.client.unconfirmed(msg.id);
      const next = inbox.find((m) => !m.claimed && m.steer) ?? inbox.find((m) => !m.claimed);
      if (!next) return;
      if (this.busy || this.submitting) { if (next.steer) await this.interrupt(); return; }
      if (!await this.client.claim(next.id)) return;
      if (this.busy || this.submitting) { await this.client.release(next.id); return; }
      await this.submit(next.text, next);
      if (this.receipts.has(next.id)) { await this.client.ack(next.id); this.receipts.delete(next.id); }
    } finally { this.polling = false; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.queue;
    await this.client.hook({ hook_event_name: 'SessionEnd' });
  }
}
