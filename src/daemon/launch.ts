import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnv } from './pty.js';

const HOOK_SCRIPT = fileURLToPath(new URL('./hook.sh', import.meta.url));
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'];

/** Writes settings.json and mcp.json (0600, it carries the token) into the node's directory. */
export function writeNodeFiles(nodeDir: string, o: { nodeId: string; endpoint: string; token: string }): void {
  const hook = [{ hooks: [{ type: 'command', command: `sh '${HOOK_SCRIPT}'` }] }];
  writeFileSync(join(nodeDir, 'settings.json'), JSON.stringify({
    hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, hook])),
    permissions: { allow: ['mcp__orchestr8'] },
  }, null, 2));
  const mcp = { mcpServers: { orchestr8: { type: 'http', url: `${o.endpoint}/mcp`, headers: { Authorization: `Bearer ${o.token}`, 'X-O8-Node': o.nodeId } } } };
  writeFileSync(join(nodeDir, 'mcp.json'), JSON.stringify(mcp), { mode: 0o600 });
}

export function systemPrompt(o: { nodeId: string; title: string; parentId: string | null }): string {
  const parent = o.parentId ? ` Your parent node is ${o.parentId}.` : '';
  return `You are orchestr8 node ${o.nodeId} ("${o.title}").${parent}`;
}

export interface LaunchInput {
  nodeId: string;
  nodeDir: string;
  endpoint: string;
  /** PATH for the child, from loginShellPath(). */
  path: string;
  title: string;
  parentId: string | null;
  sessionId: string;
  /** Relaunch with `--resume <sessionId>` instead of minting `--session-id`. */
  resume?: boolean;
  prompt?: string;
  model?: string;
  permissionMode?: string;
}

export interface LaunchSpec { file: string; args: string[]; env: Record<string, string> }

/** Command line and environment for a Claude node. Run directly as the PTY program, not through a shell. */
export function claudeLaunch(i: LaunchInput): LaunchSpec {
  const args = i.resume ? ['--resume', i.sessionId] : ['--session-id', i.sessionId];
  args.push('--name', i.title);
  if (i.model) args.push('--model', i.model);
  if (i.permissionMode) args.push('--permission-mode', i.permissionMode);
  args.push(
    '--settings', join(i.nodeDir, 'settings.json'),
    '--mcp-config', join(i.nodeDir, 'mcp.json'), '--strict-mcp-config',
    '--append-system-prompt', systemPrompt(i),
  );
  if (i.prompt && !i.resume) args.push(i.prompt);
  return { file: 'claude', args, env: nodeEnv(i) };
}

export function terminalLaunch(i: LaunchInput, shell: string): LaunchSpec {
  return { file: shell, args: ['-l'], env: nodeEnv(i) };
}

function nodeEnv(i: LaunchInput): Record<string, string> {
  return buildChildEnv({
    PATH: i.path,
    O8_NODE_ID: i.nodeId,
    O8_ENDPOINT: i.endpoint,
    O8_TOKEN_FILE: join(i.nodeDir, 'token'),
  });
}
