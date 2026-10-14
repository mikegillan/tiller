// CLI-specific policy. Coordination remains the daemon's existing MCP + inbox HTTP protocol.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessFor, type Harness, type NodeRecord } from '../shared/protocol.js';
import { claudeLaunch, nodeEnv, systemPrompt, type LaunchInput, type LaunchSpec } from './launch.js';
import type { Preset } from './presets.js';
import { transcriptFor } from './transcript.js';
import { piTranscript, preparePiTranscript } from './pi-session.js';

export interface HarnessOptions {
  permissionMode?: string;
  preset?: Partial<Preset>;
}

/** New CLIs implement this boundary; tools, permissions/scope and delivery receipts stay in Tiller. */
export interface HarnessAdapter {
  id: Harness;
  /** `inbox`: the mod's inbox is the only delivery path, and a claim is a native submission with no paste to verify. */
  capabilities: { fork: boolean; inbox: boolean };
  /** Fail before allocating a node when requested restrictions cannot be enforced. */
  validate(options: HarnessOptions): void;
  launch(input: LaunchInput): LaunchSpec;
  /** Claude adopts worktrees itself; other CLIs start directly inside them. */
  cwd(node: NodeRecord): string;
  transcript(node: Pick<NodeRecord, 'id' | 'cwd' | 'sessionId' | 'transcriptPath'>, sessionDir: string): string | undefined;
  /** Adopt/repair owned session storage before launch, without changing the conversation identity. */
  prepareTranscript?(node: NodeRecord, sessionDir: string, resume: boolean): string;
}

const piExtension = fileURLToPath(new URL('../../adapters/pi/index.ts', import.meta.url));

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  capabilities: { fork: true, inbox: false },
  validate() {},
  launch: claudeLaunch,
  cwd: (n) => n.worktree?.repo ?? n.cwd,
  transcript: (n) => n.transcriptPath ?? (n.sessionId ? transcriptFor(n.cwd, n.sessionId) : undefined),
};

export const piAdapter: HarnessAdapter = {
  id: 'pi',
  capabilities: { fork: false, inbox: true },
  validate({ permissionMode, preset }) {
    if (permissionMode !== undefined) throw new Error('Pi does not support Claude permissionMode; omit it (Pi keeps its own permission policy)');
    if (preset?.tools !== undefined || preset?.disallowedTools !== undefined || preset?.maxTurns !== undefined) {
      throw new Error('Pi does not support Claude preset tools, disallowedTools or maxTurns; use a prompt-only preset');
    }
  },
  launch(i) {
    this.validate(i);
    if (i.forkSession) throw new Error('Pi session forking is not supported by this adapter');
    if (!i.sessionDir) throw new Error('Pi needs a persistent Tiller session directory');
    // Lives with the tree archive, not nodes/<id>, which close deletes.
    const path = i.transcriptPath ?? piTranscript(i.sessionDir, i.nodeId, i.sessionId);
    mkdirSync(join(i.sessionDir, 'agents', i.nodeId), { recursive: true, mode: 0o700 });
    const args = ['--session', path, '--name', i.title, '--extension', piExtension,
      '--append-system-prompt', systemPrompt(i)];
    if (i.model) args.push('--model', i.model);
    if (i.effort) args.push('--thinking', i.effort);
    if (i.prompt) args.push('--', i.prompt);
    return { file: 'pi', args, env: { ...nodeEnv(i), TL_HARNESS: 'pi', TL_SESSION_ID: i.sessionId, TL_PI_HOOK_TOOLS: '1' } };
  },
  cwd: (n) => n.cwd,
  prepareTranscript: preparePiTranscript,
  transcript: (n, sessionDir) => n.transcriptPath ?? (n.sessionId ? piTranscript(sessionDir, n.id, n.sessionId) : undefined),
};

const adapters: Record<Harness, HarnessAdapter> = { claude: claudeAdapter, pi: piAdapter };
export function adapterFor(node: { kind: NodeRecord['kind']; harness?: Harness }): HarnessAdapter {
  const id = harnessFor(node), adapter = adapters[id];
  if (!adapter) throw new Error(`unsupported harness: ${id}`);
  return adapter;
}
