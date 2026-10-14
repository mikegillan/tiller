import { describe, expect, it, vi } from "vitest";
import { TillerBridge } from "./bridge.ts";
import type { TillerClientLike } from "./bridge.ts";
import type { InboxMessage } from "./client.ts";

class FakeClient implements TillerClientLike {
  inboxBatches: InboxMessage[][] = [];
  inboxCalls = 0;
  claims: string[] = [];
  acks: string[] = [];
  unconfirmedIds: string[] = [];
  claimResult: (id: string) => boolean = () => true;

  async inbox(): Promise<InboxMessage[]> {
    this.inboxCalls += 1;
    return this.inboxBatches.shift() ?? [];
  }

  async claim(id: string): Promise<boolean> {
    this.claims.push(id);
    return this.claimResult(id);
  }

  async unconfirmed(id: string): Promise<void> {
    this.unconfirmedIds.push(id);
  }

  async ack(id: string): Promise<void> {
    this.acks.push(id);
  }
}

interface Harness {
  client: FakeClient;
  events: string[];
  errors: Array<{ error: unknown; phase: string }>;
  expired: InboxMessage[];
  bridge: TillerBridge;
  setBusy(value: boolean): void;
}

function harness(overrides: Partial<ConstructorParameters<typeof TillerBridge>[0]> = {}): Harness {
  const client = new FakeClient();
  const events: string[] = [];
  const errors: Array<{ error: unknown; phase: string }> = [];
  const expired: InboxMessage[] = [];
  let busy = false;
  const bridge = new TillerBridge({
    client,
    isIdle: () => !busy,
    abort: () => events.push("abort"),
    sendUserMessage: (text) => {
      events.push(`send:${text}`);
    },
    onSubmit: (message) => {
      events.push(`submit:${message.id}`);
    },
    onDelivered: (message) => {
      events.push(`delivered:${message.id}`);
    },
    onExpired: (message) => {
      expired.push(message);
    },
    onError: (error, phase) => {
      errors.push({ error, phase });
    },
    ...overrides,
  });
  return {
    client,
    events,
    errors,
    expired,
    bridge,
    setBusy: (value) => {
      busy = value;
    },
  };
}

const msg = (id: string, text = id, steer = false): InboxMessage => ({ id, text, steer });

describe("TillerBridge inbox", () => {
  it("claims while idle, submits, then acks only after Pi accepts the prompt", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("a")]);

    await h.bridge.pollOnce();

    // A void `sendUserMessage` return is not acceptance: no ack yet.
    expect(h.client.claims).toEqual(["a"]);
    expect(h.events).toEqual(["submit:a", "send:a"]);
    expect(h.client.acks).toEqual([]);
    expect(h.bridge.pendingCount).toBe(1);

    // The matching `before_agent_start` prompt is what confirms acceptance and acks.
    await h.bridge.confirmAccepted("a");
    expect(h.events).toEqual(["submit:a", "send:a", "delivered:a"]);
    expect(h.client.acks).toEqual(["a"]);
    expect(h.bridge.pendingCount).toBe(0);
  });

  it("claims only the immediate next message, keeping it until Pi accepts", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("a"), msg("b")]);

    // b is never claimed, so its sender can still withdraw it.
    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["a"]);
    expect(h.events).toEqual(["submit:a", "send:a"]);

    // While a is submitted but unaccepted, b must not jump the queue.
    h.client.inboxBatches.push([msg("a"), msg("b")]);
    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["a"]);

    await h.bridge.confirmAccepted("a");
    expect(h.bridge.pendingCount).toBe(0);

    // The next idle poll claims the next message.
    h.client.inboxBatches.push([msg("b")]);
    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["a", "b"]);
    await h.bridge.confirmAccepted("b");
    expect(h.events).toEqual([
      "submit:a",
      "send:a",
      "delivered:a",
      "submit:b",
      "send:b",
      "delivered:b",
    ]);
    expect(h.client.acks).toEqual(["a", "b"]);
  });

  it("leaves non-steer messages in the daemon while busy so the sender can withdraw them", async () => {
    const h = harness();
    h.setBusy(true);
    // The fake returns fresh batches; the daemon would keep returning the same unacked message.
    h.client.inboxBatches.push([msg("a")], [msg("a")]);

    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual([]);
    expect(h.events).toEqual([]);

    h.setBusy(false);
    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["a"]);
    await h.bridge.confirmAccepted("a");
    expect(h.events).toEqual(["submit:a", "send:a", "delivered:a"]);
  });

  it("aborts the running turn for a steer, then delivers once idle", async () => {
    const h = harness();
    h.setBusy(true);
    h.client.inboxBatches.push([msg("s", "stop", true)]);

    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["s"]);
    expect(h.events).toEqual(["abort"]);
    expect(h.bridge.pendingCount).toBe(1);

    h.setBusy(false);
    h.client.inboxBatches.push([msg("s", "stop", true)]);
    await h.bridge.pollOnce();
    expect(h.events).toEqual(["abort", "submit:s", "send:stop"]);
    await h.bridge.confirmAccepted("stop");
    expect(h.events).toEqual(["abort", "submit:s", "send:stop", "delivered:s"]);
    expect(h.client.acks).toEqual(["s"]);
  });

  it("aborts a steer exactly once even when Pi stays busy across polls", async () => {
    const h = harness();
    h.setBusy(true);
    h.client.inboxBatches.push(
      [msg("s", "one", true)],
      [msg("s", "one", true)],
      [msg("s", "one", true)],
    );

    await h.bridge.pollOnce();
    await h.bridge.pollOnce();
    await h.bridge.pollOnce();

    expect(h.events.filter((event) => event === "abort")).toEqual(["abort"]);
    expect(h.client.claims).toEqual(["s"]);
    expect(h.bridge.pendingCount).toBe(1);
  });

  it("rechecks busy after the claim round-trip and aborts a steer claimed from the idle branch", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("s", "now", true)]);
    // Pi becomes busy during the claim request: the post-claim check must still abort once.
    h.client.claimResult = () => {
      h.setBusy(true);
      return true;
    };

    await h.bridge.pollOnce();
    expect(h.events).toEqual(["abort"]);
    expect(h.bridge.pendingCount).toBe(1);

    h.setBusy(false);
    h.client.inboxBatches.push([msg("s", "now", true)]);
    await h.bridge.pollOnce();
    expect(h.events).toEqual(["abort", "submit:s", "send:now"]);
  });

  it("claims at most one steer at a time", async () => {
    const h = harness();
    h.setBusy(true);
    h.client.inboxBatches.push([msg("s1", "one", true), msg("s2", "two", true)]);

    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["s1"]);
  });

  it("ignores a message the claim endpoint reports as withdrawn", async () => {
    const h = harness();
    h.client.claimResult = () => false;
    h.client.inboxBatches.push([msg("gone")]);

    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["gone"]);
    expect(h.events).toEqual([]);
  });
});

describe("TillerBridge acceptance", () => {
  it("retires a real-like void send without acceptance; B progresses even if A stays past inbox TTL", async () => {
    let now = 0;
    const send = vi.fn(); // native Pi logs rejected prompt internally, returns void
    const h = harness({ now: () => now, sendUserMessage: send });
    h.client.inboxBatches.push([msg("a"), msg("b")]);
    await h.bridge.pollOnce();
    now = 6 * 60_000; // daemon might keep A indefinitely while polling; do not rely on absence
    h.client.inboxBatches.push([msg("a"), msg("b")]);
    await h.bridge.pollOnce();
    expect(h.client.unconfirmedIds).toEqual(["a"]);
    expect(send.mock.calls).toEqual([["a"], ["b"]]); // no followUp fallback
    await h.bridge.confirmAccepted("a"); // late A must not ack A or B
    expect(h.client.acks).toEqual([]);
    await h.bridge.confirmAccepted("b");
    expect(h.client.acks).toEqual(["b"]);
    expect(h.bridge.pendingCount).toBe(0);
  });

  it("retries only retirement when its response is lost; ignores acceptance racing retirement", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    h.client.inboxBatches.push([msg("a")], [msg("a")], [msg("a"), msg("b")]);
    await h.bridge.pollOnce();
    let attempts = 0;
    h.client.unconfirmed = async () => {
      await h.bridge.confirmAccepted("a");
      if (++attempts < 3) throw new Error("response lost");
    };
    now = 60_000;
    await h.bridge.pollOnce();
    expect(h.client.acks).toEqual([]);
    expect(h.bridge.pendingCount).toBe(1);
    await h.bridge.pollOnce();
    expect(h.client.claims).toEqual(["a", "b"]);
    expect(h.events.filter((s) => s === "send:a")).toHaveLength(1);
  });

  it("acceptance already observed wins over deadline retirement; an in-flight ack is not duplicated", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    h.client.inboxBatches.push([msg("a")], [msg("a")]);
    await h.bridge.pollOnce();
    let finishAck!: () => void;
    h.client.ack = async (id) => {
      h.client.acks.push(id);
      await new Promise<void>((resolve) => { finishAck = resolve; });
    };
    const accepted = h.bridge.confirmAccepted("a");
    now = 60_001;
    await h.bridge.pollOnce();
    expect(h.client.unconfirmedIds).toEqual([]);
    expect(h.client.acks).toEqual(["a"]);
    finishAck();
    await accepted;
    expect(h.bridge.pendingCount).toBe(0);
    expect(h.events.filter((event) => event === "delivered:a")).toHaveLength(1);
  });

  it("never replays a claim inherited from a reloaded bridge", async () => {
    const h = harness();
    h.client.inboxBatches.push([{ ...msg("a"), claimed: true }, msg("b")]);
    await h.bridge.pollOnce();
    expect(h.client.unconfirmedIds).toEqual(["a"]);
    expect(h.client.claims).toEqual(["b"]);
    expect(h.events).toEqual(["submit:b", "send:b"]);
  });

  it("does not ack or resubmit when Pi consumes the prompt without a before_agent_start", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("a")], [msg("a")], [msg("a")]);

    await h.bridge.pollOnce();
    await h.bridge.pollOnce();
    await h.bridge.pollOnce();

    // Ambiguous, so retained: exactly one submit and no ack.
    expect(h.events).toEqual(["submit:a", "send:a"]);
    expect(h.client.acks).toEqual([]);
    expect(h.bridge.pendingCount).toBe(1);

    // A later actual event accepts and acks once.
    await h.bridge.confirmAccepted("a");
    expect(h.events).toEqual(["submit:a", "send:a", "delivered:a"]);
    expect(h.client.acks).toEqual(["a"]);
    expect(h.bridge.pendingCount).toBe(0);

    // No later poll resubmits or re-acks.
    h.client.inboxBatches.push([], []);
    await h.bridge.pollOnce();
    expect(h.events).toEqual(["submit:a", "send:a", "delivered:a"]);
    expect(h.client.acks).toEqual(["a"]);
  });

  it("ignores a confirmation that does not match the held prompt", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("a", "expected")]);
    await h.bridge.pollOnce();

    await h.bridge.confirmAccepted("a different human prompt");
    expect(h.bridge.pendingCount).toBe(1);
    expect(h.client.acks).toEqual([]);
    // The message is still submitted, so a later poll must not resubmit it.
    h.client.inboxBatches.push([msg("a", "expected")]);
    await h.bridge.pollOnce();
    expect(h.events).toEqual(["submit:a", "send:expected"]);
    expect(h.client.acks).toEqual([]);
  });

  it("handles Pi accepting synchronously during sendUserMessage", async () => {
    let bridge: TillerBridge;
    const h = harness({
      sendUserMessage: (text) => {
        // Pi dispatches before_agent_start from inside the send call in this race.
        void bridge.confirmAccepted(text);
      },
    });
    bridge = h.bridge;
    h.client.inboxBatches.push([msg("a")]);
    await h.bridge.pollOnce();
    await Promise.resolve();

    expect(h.client.acks).toEqual(["a"]);
    expect(h.bridge.pendingCount).toBe(0);
  });

  it("keeps acceptance when sendUserMessage throws after Pi already accepted", async () => {
    let bridge: TillerBridge;
    const h = harness({
      sendUserMessage: (text) => {
        void bridge.confirmAccepted(text);
        throw new Error("late failure");
      },
    });
    bridge = h.bridge;
    h.client.inboxBatches.push([msg("a")]);
    await h.bridge.pollOnce();
    await Promise.resolve();

    expect(h.client.acks).toEqual(["a"]);
    expect(h.bridge.pendingCount).toBe(0);
    // The throw is surfaced as a post-acceptance anomaly, never as a failed submit or a drop.
    expect(h.errors.map((entry) => entry.phase)).toEqual(["send-after-accept"]);
  });

  it("clears and reports a submitted message the daemon drops before acceptance", async () => {
    const h = harness();
    // The daemon stops listing the claimed message (TTL/restart/close) after submission.
    h.client.inboxBatches.push([msg("a")], [], []);
    await h.bridge.pollOnce();
    expect(h.bridge.pendingCount).toBe(1);

    await h.bridge.pollOnce(); // first miss: not expired yet
    expect(h.bridge.pendingCount).toBe(1);

    await h.bridge.pollOnce(); // second miss: cleared and reported
    expect(h.bridge.pendingCount).toBe(0);
    expect(h.expired.map((message) => message.id)).toEqual(["a"]);
    expect(h.events).toEqual(["submit:a", "send:a"]);
    expect(h.client.acks).toEqual([]);
  });
});

describe("TillerBridge scheduling", () => {
  it("never runs two polls at once", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("a")]);

    const first = h.bridge.pollOnce();
    const second = h.bridge.pollOnce();
    await Promise.all([first, second]);

    expect(h.client.inboxCalls).toBe(1);
  });

  it("drops a claim that resolves after stopPolling instead of submitting it", async () => {
    const h = harness();
    h.client.inboxBatches.push([msg("a")]);
    const claim = h.client.claim.bind(h.client);
    h.client.claim = async (id) => {
      h.bridge.stopPolling();
      return claim(id);
    };

    await h.bridge.pollOnce();

    expect(h.bridge.pendingCount).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.client.acks).toEqual([]);
  });

  it("stops the timer and ignores further ticks after stopPolling", async () => {
    let tick: (() => void) | undefined;
    const clearIntervalFn = vi.fn();
    const h = harness({
      pollIntervalMs: 5,
      setIntervalFn: (handler) => {
        tick = handler;
        return 42;
      },
      clearIntervalFn,
    });
    h.client.inboxBatches.push([], [], []);
    h.bridge.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = h.client.inboxCalls;

    h.bridge.stopPolling();
    expect(clearIntervalFn).toHaveBeenCalledWith(42);
    tick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.client.inboxCalls).toBe(before);

    // startPolling is idempotent after stop: it stays stopped.
    h.bridge.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.client.inboxCalls).toBe(before);
  });
});

describe("TillerBridge failures", () => {
  it("never retries even a throwing wrapper: native Pi catches/logs errors and returns void", async () => {
    const sends: string[] = [];
    let now = 0;
    const h = harness({
      now: () => now,
      sendUserMessage: (text) => {
        sends.push(text);
        throw new Error("wrapper threw after possible dispatch");
      },
    });
    h.client.inboxBatches.push([msg("a")], [msg("a")], [msg("a")]);
    await h.bridge.pollOnce();
    await h.bridge.pollOnce();
    expect(sends).toEqual(["a"]);
    now = 60_001;
    await h.bridge.pollOnce();
    expect(sends).toEqual(["a"]);
    expect(h.bridge.pendingCount).toBe(0);
    expect(h.client.unconfirmedIds).toEqual(["a"]);
    expect(h.client.acks).toEqual([]);
    expect(h.errors.map((entry) => entry.phase)).toEqual(["send"]);
  });

  it("retains an accepted message and retries the ack without re-submitting", async () => {
    const client = new FakeClient();
    let failAck = true;
    const acked: string[] = [];
    client.ack = async (id) => {
      acked.push(id);
      if (failAck) throw new Error("ack down");
    };
    client.inboxBatches.push([msg("a")], [], []);
    const sends: string[] = [];
    const errors: Array<{ error: unknown; phase: string }> = [];
    const bridge = new TillerBridge({
      client,
      isIdle: () => true,
      abort: () => {},
      sendUserMessage: (text) => {
        sends.push(text);
      },
      onError: (error, phase) => errors.push({ error, phase }),
    });

    await bridge.pollOnce();
    // Submitted but unaccepted: no ack yet, and later polls never resubmit.
    expect(bridge.pendingCount).toBe(1);
    expect(sends).toEqual(["a"]);
    expect(acked).toEqual([]);

    await bridge.pollOnce();
    expect(sends).toEqual(["a"]);
    expect(acked).toEqual([]);

    // Acceptance triggers the ack; a failure keeps the message as a receipt.
    await bridge.confirmAccepted("a");
    expect(acked).toEqual(["a"]);
    expect(errors.map((entry) => entry.phase)).toEqual(["ack"]);
    expect(bridge.pendingCount).toBe(1);

    failAck = false;
    await bridge.pollOnce();
    expect(bridge.pendingCount).toBe(0);
    expect(sends).toEqual(["a"]);
    expect(acked).toEqual(["a", "a"]);
  });
});
