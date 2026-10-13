// Shared contracts between daemon, UI and the agent-facing API. Keep this file small and stable.

export const NODE_KINDS = ['claude', 'terminal'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Agent status derived from hook events. 'none' is for plain terminals. */
export type AgentState = 'working' | 'waiting' | 'blocked' | 'done' | 'unknown' | 'none';

/** States in which an agent is waiting on the human: a permission prompt or a question. */
export const NEEDS_YOU_STATES: readonly AgentState[] = ['blocked', 'waiting'];
/** A live node waiting on the human. mod/hooks/notify.ts keeps its own copy (the mod cannot import src/shared). */
export const needsYou = (s: NodeStatus) => !s.exited && NEEDS_YOU_STATES.includes(s.state);

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
  /** Set while working with no hook event for limits.stallMinutes; cleared by the next event. changedAt is when activity stopped. */
  stalled?: boolean;
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
  /** Spend of the current session only; NodeRecord.spentUsd is the node's total. */
  costUsd?: number;
  /** Live git state of the node's worktree; absent when it owns none. Not persisted: recomputed on daemon start. */
  git?: GitState;
  /** Wall-clock ms of the last event that changed state. */
  changedAt: number;
}

/** Which role prompt a Claude node gets; 'none' means no role section. Default: root = orchestrator, child = worker. */
export const ROLES = ['orchestrator', 'worker', 'none'] as const;
export type Role = (typeof ROLES)[number];

/** Values for claude's `--effort`. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const ISOLATIONS = ['none', 'worktree'] as const;
export type Isolation = (typeof ISOLATIONS)[number];

/** A worker's own git worktree: <repo>/.claude/worktrees/<nodeId> on branch o8/<nodeId>, branched from base at baseSha. */
export interface Worktree {
  /** The main checkout root; the PTY starts here with `claude --worktree <nodeId>`. */
  repo: string;
  path: string;
  branch: string;
  /** Symbolic base ref at spawn time (for example main), or the sha when HEAD was detached. */
  base: string;
  baseSha: string;
  /** True when the directory is gone from disk or from `git worktree list`; resume is refused until it is recreated. */
  missing?: boolean;
}

/** A worktree node's branch against its base, refreshed when its turn ends, after edits, on exit, merge and close. */
export interface GitState {
  branch: string;
  base: string;
  /** Commits on the branch that are not in base, and in base that are not on the branch. */
  ahead: number;
  behind: number;
  /** Uncommitted files in the worktree (modified, staged or untracked). */
  dirty: number;
  /** Lines added and removed by the node's work so far: the same numbers as the diff view (see Diff). */
  additions: number;
  deletions: number;
  /** The worktree directory is gone. */
  missing?: boolean;
  /** When orchestr8 last merged the branch into base; cleared once the branch moves past what was merged. */
  mergedAt?: number;
}

/** One file of a worktree node's diff. Binary files have no patch; neither do files past the 2 MB patch cap (Diff.truncated). */
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Unified diff of this file, from its `diff --git` header line. */
  patch?: string;
}

/** Everything a worktree node changed since it branched: its commits and its uncommitted and untracked files, as one diff. */
export interface Diff { base: string; branch: string; files: DiffFile[]; truncated?: boolean }

export interface NodeRecord {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  cwd: string;
  model?: string;
  effort?: Effort;
  permissionMode?: string;
  /** Explicit role override; absent means derive from parentId at each launch. */
  role?: Role;
  /** Set on a node that owns a git worktree (spawned with isolation "worktree"); its cwd is the worktree path. */
  worktree?: Worktree;
  createdAt: number;
  /** When the node last launched or changed state on a hook; resume on start skips nodes idle longer than resumeMaxAgeDays. */
  lastActiveAt?: number;
  /** Persisted so a restarted daemon can offer Resume. */
  sessionId?: string;
  /** Claude's transcript file, from SessionStart. Persisted so Resume can find it. */
  transcriptPath?: string;
  /** Session ids from before each restart, oldest first (at most 10), for a later history feature. */
  previousSessions?: string[];
  /** Total spend in USD across all of the node's sessions, summed from the mod's session.measure. */
  spentUsd?: number;
  /** Spend on one local day (YYYY-MM-DD); a later day starts over. */
  spentToday?: { day: string; usd: number };
}

export interface NodeView extends NodeRecord {
  status: NodeStatus;
  unread: boolean;
}

/** One rate-limit window as Claude Code's `session.measure` reports it; `kind` is five_hour, seven_day or a gateway's spend_limit. */
export interface RateLimit { kind: string; percentUsed: number; resetsAt?: string }
/** Account-level Claude usage: the newest non-empty rateLimits any node's mod reported. Limits are per account, so there is one. */
export interface Usage { rateLimits: RateLimit[]; nodeId: string; at: number }

// Daemon -> UI (WebSocket, JSON). One message per line.
export type ServerMessage =
  | { t: 'snapshot'; nodes: NodeView[]; appConnected: boolean; usage?: Usage }
  | { t: 'usage'; usage: Usage }             // a node reported new account-level rate limits
  | { t: 'clients'; app: boolean }           // the native app connected or disconnected; terminal clients then stop ringing the bell
  | { t: 'node'; node: NodeView }            // created or updated (full record)
  | { t: 'removed'; id: string }
  | { t: 'data'; id: string; data: string }  // raw PTY output
  | { t: 'notify'; id: string; kind: 'done' | 'needsYou' | 'errored' | 'exited'; title: string; body?: string }
  | { t: 'confirm'; confirmId: string; text: string } // ask the human to approve an agent action
  | { t: 'confirmDone'; confirmId: string }  // that confirm was answered or timed out; close the modal
  | { t: 'error'; message: string; id?: string }
  | { t: 'focus'; from: string; id: string }   // a node's mod asked to view node `id`; an attach client showing `from` switches
  | { t: 'digest'; since: number; items: DigestItem[] } // what happened while no client was focused; sent to the client that regained focus
  | ({ t: 'diff'; id: string } & Diff)         // reply to a diff request
  | { t: 'sent'; id: string; result: SendResult } // reply to a send request
  ;

/** One node's line in the away digest: still needs you, errored or failed, or finished (with its outcome note). */
export interface DigestItem { id: string; title: string; kind: 'needsYou' | 'errored' | 'finished'; text?: string; at: number }

// UI -> Daemon.
export type ClientMessage =
  | { t: 'auth'; token: string; client?: 'app' | 'browser' | 'mux' } // must be the first message; token comes from the ?k= query param of the served UI URL
  | { t: 'visibility'; focused: boolean }       // whether this client's window is in front; the daemon skips OS notifications for a node a focused client has selected
  | { t: 'attach'; id: string; cols: number; rows: number } // start receiving data; replies with a data message holding the serialized screen
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'select'; id: string }                // clears unread
  | { t: 'spawn'; kind: NodeKind; title: string; cwd: string; prompt?: string; model?: string; effort?: Effort; role?: Role; parentId?: string | null; isolation?: Isolation }
  | { t: 'close'; id: string; force?: boolean; worktree?: 'keep' | 'discard' }  // a root (orchestrator) is refused without force; worktree picks what happens to a dirty or unmerged worktree (default: refuse)
  | { t: 'merge'; id: string }                 // merge a worktree node's branch into its base, in the worktrees.merge style
  | { t: 'restart'; id: string; prompt?: string } // relaunch with a fresh session: clears context, keeps the node and its children; prompt is its first prompt
  | { t: 'resume'; id: string }
  | { t: 'prune' }                             // remove every exited node that has no live descendant
  | { t: 'rename'; id: string; title: string }
  | { t: 'confirm'; confirmId: string; ok: boolean }
  | { t: 'diff'; id: string }                  // a worktree node's diff; replies diff, or error for a node without a worktree
  | { t: 'send'; id: string; text: string }    // a message from the human, as `o8 send` delivers it; replies sent
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
  | { event: 'session.measure'; payload: { context?: { tokens: number; window: number; percent: number }; cost?: { usd: number }; rateLimits?: RateLimit[] } };
/** POST /focus { id } → 204; the daemon broadcasts `focus` to ws clients (PLAN §14). */
/** GET /tree → ChildView[]: the calling node's whole tree from its root, depth-first. */
export interface ChildView {
  id: string; title: string; depth: number; state: AgentState;
  /** True on the calling node's own row. */
  self?: boolean;
  parentId?: string | null;
  errored?: boolean; interrupted?: boolean; exited?: boolean;
  activity?: string; ageSec: number; lastMessage?: string; unread: boolean; contextPct?: number;
  /** For a node with its own worktree: its branch, commits ahead of base and uncommitted files. */
  branch?: string; ahead?: number; dirty?: number;
}
