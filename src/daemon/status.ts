import { basename } from 'node:path';
import type { NodeStatus } from '../shared/protocol.js';

/** Raw JSON Claude Code posts to a hook. Payloads vary, so only the name is typed. */
export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  [key: string]: unknown;
}

export const DONE_HOLDOFF_MS = 3000;
export const STALE_MS = 20 * 60 * 1000;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Same node, new state. Every call here is a real change, so changedAt moves. */
function next(prev: NodeStatus, patch: Partial<NodeStatus>, now: number): NodeStatus {
  return { ...prev, ...patch, changedAt: now };
}

function toolActivity(event: HookEvent): string | undefined {
  const tool = str(event.tool_name);
  if (!tool) return undefined;
  const input = (event.tool_input ?? {}) as Record<string, unknown>;
  let detail: string | undefined;
  if (tool === 'Bash') detail = str(input.command)?.slice(0, 60);
  else if (tool === 'Edit' || tool === 'Write' || tool === 'Read') {
    const p = str(input.file_path);
    detail = p && basename(p);
  }
  return detail ? `${tool}: ${detail}` : tool;
}

/** Turn ends: leave working/waiting/blocked for done, dropping the activity line. */
function done(prev: NodeStatus, now: number, patch: Partial<NodeStatus> = {}): NodeStatus {
  return next(prev, { state: 'done', activity: undefined, ...patch }, now);
}

export function reduce(prev: NodeStatus, event: HookEvent, now: number): NodeStatus {
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
      return next(prev, {
        state: 'working', errored: undefined, interrupted: undefined, stale: undefined, doneSource: undefined,
        lastAssistantMessage: undefined, activity: undefined,
      }, now);

    case 'PreToolUse':
    case 'PostToolUse': {
      // Hooks run in parallel, so a late tool event can land just after Stop.
      if (prev.state === 'done' && now - prev.changedAt < DONE_HOLDOFF_MS) return prev;
      if (event.hook_event_name === 'PreToolUse') {
        if (event.tool_name === 'AskUserQuestion') return next(prev, { state: 'waiting', activity: undefined }, now);
        return next(prev, { state: 'working', activity: toolActivity(event) }, now);
      }
      return next(prev, { state: 'working' }, now);
    }

    case 'PermissionRequest':
      return next(prev, { state: 'blocked' }, now);

    case 'Notification':
      switch (event.notification_type) {
        case 'permission_prompt':
          return next(prev, { state: 'blocked' }, now);
        case 'elicitation_dialog':
        case 'agent_needs_input':
          return next(prev, { state: 'waiting' }, now);
        case 'idle_prompt':
          return prev.state === 'working' ? done(prev, now, { doneSource: 'idle_prompt' }) : prev;
        default:
          return prev; // closed allowlist: unknown types never move state
      }

    case 'Stop':
      return done(prev, now, {
        doneSource: 'stop',
        interrupted: event.is_interrupt ? true : undefined,
        lastAssistantMessage: str(event.last_assistant_message),
      });

    case 'StopFailure':
      return done(prev, now, { doneSource: 'stop', errored: true, lastAssistantMessage: str(event.last_assistant_message) ?? prev.lastAssistantMessage });

    case 'SessionStart':
      return next(prev, {
        state: 'unknown', activity: undefined,
        sessionId: str(event.session_id) ?? prev.sessionId,
        transcriptPath: str(event.transcript_path) ?? prev.transcriptPath,
      }, now);

    case 'SessionEnd':
      return next(prev, { state: 'unknown', activity: undefined }, now);

    default:
      return prev;
  }
}

/** Working with no state change for 20 minutes is presumed finished. */
export function sweep(prev: NodeStatus, now: number): NodeStatus {
  return prev.state === 'working' && now - prev.changedAt > STALE_MS ? done(prev, now, { stale: true, doneSource: 'sweep' }) : prev;
}

export function ptyExited(prev: NodeStatus, now: number): NodeStatus {
  if (prev.exited && prev.state !== 'working' && prev.state !== 'waiting' && prev.state !== 'blocked') return prev;
  const active = prev.state === 'working' || prev.state === 'waiting' || prev.state === 'blocked';
  return next(prev, active ? { exited: true, state: 'done', doneSource: 'exit', activity: undefined } : { exited: true }, now);
}

/** True when `data` typed into the node is a lone Esc or Ctrl-C and the node is working. */
export function interruptKeyPressed(prev: NodeStatus, data: string): boolean {
  return prev.state === 'working' && (data === '\x1b' || data === '\x03');
}

/** Call 1.5 s after interruptKeyPressed if no hook event arrived since (caller's timer). */
export function interruptTimeout(prev: NodeStatus, now: number): NodeStatus {
  return prev.state === 'working' ? done(prev, now, { interrupted: true, doneSource: 'interrupt' }) : prev;
}
