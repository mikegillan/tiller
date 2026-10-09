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
  /** Short activity string while working, e.g. "Bash: npm test". */
  activity?: string;
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
