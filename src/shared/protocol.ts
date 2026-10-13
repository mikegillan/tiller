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
  /** prompt_id of the turn in progress or last finished, from UserPromptSubmit. */
  promptId?: string;
  /** Short activity string while working, e.g. "Bash: npm test"; "needs approval: ..." when blocked. */
  activity?: string;
  /** From the mod's session.measure, when available. */
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** Model id (e.g. claude-opus-5-5): SessionStart or the mod's turn.complete; view() falls back to the spawn --model. */
  model?: string;
  /** Latest effort level seen in a hook payload (low, medium, high, xhigh, max). */
  effort?: string;
  costUsd?: number;
  /** Wall-clock ms of the last event that changed state. */
  changedAt: number;
}

/** Which role prompt a Claude node gets; 'none' means no role section. Default: root = orchestrator, child = worker. */
export type Role = 'orchestrator' | 'worker' | 'none';

export interface NodeRecord {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  /** Explicit role override; absent means derive from parentId at each launch. */
  role?: Role;
  createdAt: number;
  /** Persisted so a restarted daemon can offer Resume. */
  sessionId?: string;
  /** Claude's transcript file, from SessionStart. Persisted so Resume can find it. */
  transcriptPath?: string;
  /** Session ids from before each restart, oldest first (at most 10), for a later history feature. */
  previousSessions?: string[];
}

export interface NodeView extends NodeRecord {
  status: NodeStatus;
  unread: boolean;
}

// Daemon -> UI (WebSocket, JSON). One message per line.
export type ServerMessage =
  | { t: 'snapshot'; nodes: NodeView[]; appConnected: boolean }
  | { t: 'clients'; app: boolean }           // the native app connected or disconnected; terminal clients then stop ringing the bell
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
  | { t: 'auth'; token: string; client?: 'app' | 'browser' | 'mux' } // must be the first message; token comes from the ?k= query param of the served UI URL
  | { t: 'visibility'; focused: boolean }       // whether this client's window is in front; the daemon skips OS notifications for a node a focused client has selected
  | { t: 'attach'; id: string; cols: number; rows: number } // start receiving data; replies with a data message holding the serialized screen
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'select'; id: string }                // clears unread
  | { t: 'spawn'; kind: NodeKind; title: string; cwd: string; prompt?: string; model?: string; role?: Role; parentId?: string | null }
  | { t: 'close'; id: string; force?: boolean }  // a root (orchestrator) is refused without force
  | { t: 'restart'; id: string }               // relaunch with a fresh session: clears context, keeps the node and its children
  | { t: 'resume'; id: string }
  | { t: 'prune' }                             // remove every exited node that has no live descendant
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
  | { event: 'session.measure'; payload: { context?: { tokens: number; window: number; percent: number }; cost?: { usd: number }; rateLimits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }> } };
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
