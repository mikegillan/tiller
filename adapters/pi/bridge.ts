/**
 * The Tiller inbox bridge: poll `/inbox`, claim, submit, confirm acceptance, ack, and steer.
 *
 * Design notes:
 * - Never overlaps polls: `pollOnce()` returns immediately while another run is in flight.
 * - Only the *immediate next* message is ever claimed. Everything behind it stays in the daemon
 *   (unclaimed), so its sender can still withdraw it.
 * - A steer message is claimed while Pi is busy, Pi's running turn is aborted once, and the
 *   message is delivered once Pi reports idle. At most one steer is held at a time.
 * - `sendUserMessage` is fire-and-forget in Pi: a void return is not evidence that Pi accepted
 *   the prompt. It can still reject the input asynchronously, or consume it without ever starting
 *   a run. The bridge therefore tracks two distinct states:
 *     * `submitted` — `sendUserMessage` was called (the message is ambiguous; it must never be
 *       submitted again), and
 *     * `accepted`  — Pi actually started a run with this exact prompt, reported through
 *       `before_agent_start`. Only acceptance can ack the message and release the queue.
 *   A claimed message whose submit failed before acceptance is reset to unsubmitted and retried;
 *   one that was accepted (even if the send call then threw) is never un-accepted.
 * - The state is marked `submitted` *before* `sendUserMessage` is invoked, because Pi can
 *   dispatch `before_agent_start` synchronously from inside that call. Acceptance is an explicit
 *   flag, so the reentrant `confirmAccepted` cannot be undone by the enclosing submit.
 * - `confirmAccepted(text)` is invoked from `before_agent_start` only after the matching
 *   `UserPromptSubmit` hook has been forwarded, so a receipt can never precede submission.
 * - A submitted-but-unaccepted message that the daemon no longer lists (TTL expiry, daemon
 *   restart, node close) is cleared and reported as expired so it cannot wedge the queue forever.
 *   Two consecutive misses are required so the daemon-side `UserPromptSubmit` ack of an
 *   in-flight acceptance is never mistaken for expiry.
 * - `sendUserMessage`/`isIdle`/`abort` are injected, so the bridge is tested with a fake Pi.
 */

import type { InboxMessage } from "./client.ts";
import type { PiSendUserMessageOptions } from "./types.ts";

/** The subset of `TillerClient` the bridge uses; tests inject a fake. */
export interface TillerClientLike {
  inbox(): Promise<InboxMessage[]>;
  claim(id: string): Promise<boolean>;
  ack(id: string): Promise<void>;
}

export interface TillerBridgeDeps {
  client: TillerClientLike;
  /** Live idle check, e.g. `() => ctx.isIdle()`. */
  isIdle: () => boolean;
  /** Abort the running turn, e.g. `() => ctx.abort()`. */
  abort: () => void;
  /** Submit a user message, e.g. `(text, o) => pi.sendUserMessage(text, o)`. May be async. */
  sendUserMessage: (text: string, options?: PiSendUserMessageOptions) => unknown;
  /** Called just before submitting. Bookkeeping only: no receipt/ack may happen here. */
  onSubmit?: (message: InboxMessage) => unknown;
  /** Called after a message is accepted by Pi and acked. */
  onDelivered?: (message: InboxMessage) => void;
  /** Called when a submitted-but-unaccepted message disappears from the daemon inbox. */
  onExpired?: (message: InboxMessage) => void;
  /** Called with the count of held/being-delivered messages. */
  onPending?: (count: number) => void;
  /** Called for poll/claim/send/ack failures. */
  onError?: (error: unknown, phase: string) => void;
  /** Default 1000 ms. */
  pollIntervalMs?: number;
  /** Max submit attempts before a claimed message is dropped (it cannot be un-claimed). Default 5. */
  maxSendAttempts?: number;
  /** Timer injection for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

interface HeldMessage extends InboxMessage {
  attempts: number;
  /** `sendUserMessage` was invoked; only acceptance (or a pre-acceptance throw) may clear it. */
  submitted: boolean;
  /** A matching `before_agent_start` confirmed Pi accepted this prompt. */
  accepted: boolean;
  /** The running turn was aborted once for this steer; never abort again on later polls. */
  steerAborted: boolean;
  /** Consecutive inbox polls where a submitted-unaccepted message was absent. */
  inboxMisses: number;
}

const defaultSetInterval = (handler: () => void, ms: number): unknown =>
  setInterval(handler, ms);
const defaultClearInterval = (handle: unknown): void =>
  clearInterval(handle as ReturnType<typeof setInterval>);

/** Two consecutive inbox misses before a submitted-unaccepted message is treated as expired. */
const EXPIRY_MISSES = 2;

export class TillerBridge {
  private readonly deps: TillerBridgeDeps;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly maxSendAttempts: number;
  private readonly held: HeldMessage[] = [];
  private timer: unknown;
  private polling = false;
  private delivering = false;
  private stopped = false;

  constructor(deps: TillerBridgeDeps) {
    this.deps = deps;
    this.setIntervalFn = deps.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? defaultClearInterval;
    this.maxSendAttempts = deps.maxSendAttempts ?? 5;
  }

  /** Messages claimed but not yet accepted and acked. */
  get pendingCount(): number {
    return this.held.length;
  }

  /** Start the poll loop. Idempotent; the first poll runs immediately. */
  startPolling(): void {
    if (this.stopped || this.timer !== undefined) return;
    const ms = this.deps.pollIntervalMs ?? 1000;
    this.timer = this.setIntervalFn(() => {
      void this.pollOnce();
    }, ms);
    void this.pollOnce();
  }

  /** Stop the poll loop and drop any pending timer. Safe to call more than once. */
  stopPolling(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One poll cycle. Reentrant calls are ignored, so a slow HTTP round-trip cannot stack polls.
   */
  async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      // Finish anything already claimed (submit, or retry an outstanding ack) before looking
      // at the inbox, so a claimed message is never bypassed.
      await this.flush();
      if (this.stopped) return;
      await this.pollInbox();
      if (this.stopped) return;
      // A message claimed while idle is submitted in this same cycle; a steer claimed while busy
      // waits for the next cycle, when Pi reports idle.
      await this.flush();
    } catch (error) {
      this.deps.onError?.(error, "poll");
    } finally {
      this.polling = false;
      this.deps.onPending?.(this.pendingCount);
    }
  }

  /**
   * Pi accepted a prompt. Called from `before_agent_start` with the exact prompt, after the
   * matching `UserPromptSubmit` hook has been forwarded. Marks the held message accepted and
   * acks it; a failed ack is retried on later polls and never re-submits.
   */
  async confirmAccepted(text: string): Promise<void> {
    if (this.stopped) return;
    const message = this.held[0];
    if (!message) return;
    if (!message.submitted || message.accepted) return;
    // Only the injected message that Pi actually ran is confirmed; an unrelated human prompt
    // (or a stale prompt from a prior run) must not clear the claim.
    if (message.text !== text) return;
    message.accepted = true;
    await this.retryAck(message);
  }

  private isKnown(id: string): boolean {
    return this.held.some((message) => message.id === id);
  }

  private hasSteerHeld(): boolean {
    return this.held.some((message) => message.steer);
  }

  private async claim(message: InboxMessage): Promise<boolean> {
    try {
      return await this.deps.client.claim(message.id);
    } catch (error) {
      this.deps.onError?.(error, "claim");
      return false;
    }
  }

  /** Abort the running turn for a steer, but only once: later polls must not re-abort. */
  private abortForSteer(message: HeldMessage): void {
    if (message.steerAborted) return;
    message.steerAborted = true;
    try {
      this.deps.abort();
    } catch (error) {
      this.deps.onError?.(error, "abort");
    }
  }

  /**
   * Claim at most one message: while idle the immediate next one, while busy a single steer.
   * Messages left behind stay in the daemon and remain withdrawable.
   */
  private async pollInbox(): Promise<void> {
    const messages = await this.deps.client.inbox();
    if (this.stopped) return;

    // At most one claimed message is held at a time, so a submitted-but-unaccepted message is
    // never bypassed and the message behind it stays withdrawable in the daemon. Still check
    // whether the daemon dropped it (TTL/restart/close) so it cannot wedge the queue forever.
    if (this.held.length > 0) {
      const held = this.held[0];
      if (held.submitted && !held.accepted) {
        if (messages.some((message) => message.id === held.id)) {
          held.inboxMisses = 0;
        } else {
          held.inboxMisses += 1;
          if (held.inboxMisses >= EXPIRY_MISSES) {
            const at = this.held.indexOf(held);
            if (at >= 0) this.held.splice(at, 1);
            this.deps.onExpired?.(held);
          }
        }
      }
      return;
    }

    if (this.deps.isIdle()) {
      for (const message of messages) {
        if (this.isKnown(message.id)) continue;
        if (!(await this.claim(message))) {
          if (this.stopped) return;
          continue; // withdrawn/expired: the next message is now the immediate one
        }
        if (this.stopped) return;
        const held = this.newHeld(message);
        this.held.push(held);
        // Pi can become busy during the claim round-trip. A steer claimed from the idle branch
        // must still abort exactly once; a non-steer simply waits for idle.
        if (message.steer && !this.deps.isIdle()) this.abortForSteer(held);
        return;
      }
      return;
    }

    // Busy: a non-steer waits in the daemon. A steer jumps the queue, but only one at a time.
    if (this.hasSteerHeld()) return;
    const steer = messages.find((message) => message.steer && !this.isKnown(message.id));
    if (!steer) return;
    if (!(await this.claim(steer))) return;
    if (this.stopped) return;
    const held = this.newHeld(steer);
    this.held.push(held);
    // Recheck after the claim round-trip: if Pi went idle, the flush below submits it; if it is
    // still busy, abort once. `steerAborted` stops later polls from aborting again.
    if (!this.deps.isIdle()) this.abortForSteer(held);
  }

  private newHeld(message: InboxMessage): HeldMessage {
    return {
      ...message,
      attempts: 0,
      submitted: false,
      accepted: false,
      steerAborted: false,
      inboxMisses: 0,
    };
  }

  /** Submit or ack the held message. Never runs two submissions at once. */
  private async flush(): Promise<void> {
    if (this.delivering || this.stopped) return;
    const message = this.held[0];
    if (!message) return;
    this.delivering = true;
    try {
      if (message.accepted) {
        // Pi accepted it: retry the ack only, never the submit.
        await this.retryAck(message);
        return;
      }
      if (message.submitted) return; // awaiting acceptance: ambiguous, so never resubmit
      if (!this.deps.isIdle()) return;
      await this.submit(message);
    } finally {
      this.delivering = false;
      this.deps.onPending?.(this.pendingCount);
    }
  }

  private async submit(message: HeldMessage): Promise<void> {
    try {
      if (this.deps.onSubmit) await this.deps.onSubmit(message);
      if (this.stopped) return;
      // Mark submitted before the call: Pi may dispatch `before_agent_start` synchronously from
      // inside `sendUserMessage`, and `confirmAccepted` must see a submitted message.
      message.submitted = true;
      // `followUp` is ignored while idle; it is a safety net for the race where Pi becomes busy
      // between the idle check and the submit, so the message is queued instead of rejected.
      await this.deps.sendUserMessage(message.text, { deliverAs: "followUp" });
      message.attempts = 0;
    } catch (error) {
      // A confirmation set synchronously during the call wins: Pi already ran the prompt, so the
      // throw must not un-submit it or count against the send-retry/drop cap.
      if (message.accepted) {
        this.deps.onError?.(error, "send-after-accept");
        return;
      }
      message.submitted = false;
      message.attempts += 1;
      this.deps.onError?.(error, "send");
      if (message.attempts >= this.maxSendAttempts) {
        const at = this.held.indexOf(message);
        if (at >= 0) {
          this.held.splice(at, 1);
          this.deps.onError?.(
            new Error(
              `dropping claimed message ${message.id} after ${message.attempts} failed submits`,
            ),
            "drop",
          );
        }
      }
      return;
    }
    // A void return is not acceptance. The message stays submitted until a matching
    // `before_agent_start` (via `confirmAccepted`) or the daemon drops it.
  }

  /** Ack a submitted, accepted message. A failure keeps it for a later retry; success releases it. */
  private async retryAck(message: HeldMessage): Promise<void> {
    if (!message.accepted || this.stopped) return;
    try {
      await this.deps.client.ack(message.id);
    } catch (error) {
      this.deps.onError?.(error, "ack");
      return;
    }
    const at = this.held.indexOf(message);
    if (at >= 0) this.held.splice(at, 1);
    this.deps.onDelivered?.(message);
  }
}
