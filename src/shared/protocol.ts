// Shared contracts between daemon, UI and the agent-facing API. Keep this file small and stable.

export type NodeKind = 'claude' | 'terminal';

/** Agent status derived from hook events. 'none' is for plain terminals. */
export type AgentState = 'working' | 'waiting' | 'blocked' | 'done' | 'unknown' | 'none';

export interface NodeStatus {
  state: AgentState;
  /** Set on 'done' when the turn ended via StopFailure. */
  errored?: boolean;
  /** Set on 'done' when the turn was interrupted (Esc / Ctrl-C). */
  interrupted?: boolean;
  /** How 'done' was reached. Only 'stop' (Stop / StopFailure) counts as verified idle for message delivery. */
  doneSource?: 'stop' | 'idle_prompt' | 'sweep' | 'interrupt' | 'exit';
  /** Set when 'done' was reached only by the 20-minute stale sweep. */
  stale?: boolean;
  /** True once the PTY process has exited. */
  exited?: boolean;
  /** Claude session id (minted at launch, updated from SessionStart). */
  sessionId?: string;
  transcriptPath?: string;
  /** Last assistant message text, from Stop / Notification payloads. */
  lastAssistantMessage?: string;
  /** Latest permission_mode seen in a hook payload (default, acceptEdits, plan, auto, bypassPermissions). */
  permissionMode?: string;
  /** Short activity string while working, e.g. "Bash: npm test"; "needs approval: ..." when blocked. */
  activity?: string;
  /** From the mod's session.measure, when available. */
  contextPct?: number;
  costUsd?: number;
  /** Wall-clock ms of the last event that changed state. */
  changedAt: number;
}

export interface NodeRecord {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  createdAt: number;
  /** Persisted so a restarted daemon can offer Resume. */
  sessionId?: string;
  /** Claude's transcript file, from SessionStart. Persisted so Resume can find it. */
  transcriptPath?: string;
}

export interface NodeView extends NodeRecord {
  status: NodeStatus;
  unread: boolean;
}

// Daemon -> UI (WebSocket, JSON). One message per line.
export type ServerMessage =
  | { t: 'snapshot'; nodes: NodeView[] }
  | { t: 'node'; node: NodeView }            // created or updated (full record)
  | { t: 'removed'; id: string }
  | { t: 'data'; id: string; data: string }  // raw PTY output
  | { t: 'notify'; id: string; kind: 'done' | 'needsYou' | 'errored' | 'exited'; title: string; body?: string }
  | { t: 'confirm'; confirmId: string; text: string } // ask the human to approve an agent action
  | { t: 'confirmDone'; confirmId: string }  // that confirm was answered or timed out; close the modal
  | { t: 'error'; message: string; id?: string }
  | { t: 'focus'; from: string; id: string }   // a node's mod asked to view node `id`; an attach client showing `from` switches
  ;

// UI -> Daemon.
export type ClientMessage =
  | { t: 'auth'; token: string }                // must be the first message; token comes from the ?k= query param of the served UI URL
  | { t: 'attach'; id: string; cols: number; rows: number } // start receiving data; replies with buffered scrollback
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'select'; id: string }                // clears unread
  | { t: 'spawn'; kind: NodeKind; title: string; cwd: string; prompt?: string; model?: string; parentId?: string | null }
  | { t: 'close'; id: string }
  | { t: 'resume'; id: string }
  | { t: 'rename'; id: string; title: string }
  | { t: 'confirm'; confirmId: string; ok: boolean }
  ;

// Outcome of delivering a message into an agent node (PLAN.md §6).
export type SendOutcome = 'delivered' | 'queued' | 'stalled' | 'expired' | 'queueFull' | 'gone' | 'refused';
export interface SendResult { outcome: SendOutcome; retryable: boolean; detail?: string; messageId?: string }

// Mod-facing HTTP API (PLAN §14). All routes authenticate like /hook: Authorization bearer + X-O8-Node.
// The per-node mod (mod/) polls these; the daemon treats a node as "mod-live" while polls keep arriving.

/** GET /inbox → InboxMessage[] (unacked messages for the calling node, oldest first). */
export interface InboxMessage { id: string; from: string; text: string; enqueuedAt: number }
/** POST /ack { id } → 204. Sent when $.prompt.submit resolved (the turn started). */
/** POST /mod-event { event, payload } → 204. */
export type ModEvent =
  | { event: 'turn.start'; payload: { text: string; turnId: string } }
  | { event: 'turn.complete'; payload: { answer?: string; durationMs: number; isAborted: boolean; turnId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; usage?: Record<string, unknown> } }
  | { event: 'session.measure'; payload: { context?: { tokens: number; window: number; percent: number }; cost?: { usd: number }; rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }> } }
  /** The mod showed a toast (and, when `os`, ran the macOS notification). Only logged under O8_DEBUG. */
  | { event: 'notified'; payload: { text: string; os: boolean } };
/** POST /focus { id } → 204; the daemon broadcasts `focus` to ws clients (PLAN §14). */
/** GET /children → ChildView[]: the calling node itself first (self: true), then its descendants depth-first. */
export interface ChildView {
  id: string; title: string; depth: number; state: AgentState;
  /** True on the calling node's own row (first row of /children; anywhere in /tree). */
  self?: boolean;
  parentId?: string | null;
  errored?: boolean; interrupted?: boolean; exited?: boolean;
  activity?: string; ageSec: number; lastMessage?: string; unread: boolean; contextPct?: number;
}
