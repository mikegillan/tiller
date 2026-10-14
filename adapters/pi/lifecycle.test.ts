import { describe, expect, it } from "vitest";
import {
  measureContext,
  messageText,
  normalizeToolInput,
  sessionEndHook,
  sessionStartHook,
  sumSessionCost,
  toolHook,
  turnCompletePayload,
  turnStartPayload,
  uiPromptHook,
  userPromptHook,
} from "./lifecycle.ts";

describe("hook mappers", () => {
  it("SessionStart carries session_id + transcript_path and drops undefined fields", () => {
    expect(
      sessionStartHook({
        sessionId: "sess-1",
        transcriptPath: "/home/.tiller/nodes/n-1/sessions/sess-1.jsonl",
        model: "claude-sonnet",
      }),
    ).toEqual({
      hook_event_name: "SessionStart",
      session_id: "sess-1",
      transcript_path: "/home/.tiller/nodes/n-1/sessions/sess-1.jsonl",
      model: "claude-sonnet",
    });
    expect(sessionStartHook({ sessionId: "" })).toEqual({
      hook_event_name: "SessionStart",
    });
  });

  it("UserPromptSubmit and SessionEnd map their payloads", () => {
    expect(userPromptHook({ sessionId: "s1", text: "do it" })).toEqual({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "do it",
    });
    expect(sessionEndHook({ sessionId: "s1" })).toEqual({
      hook_event_name: "SessionEnd",
      session_id: "s1",
    });
  });

  it("maps Pi tool names and inputs for PreToolUse / PostToolUse", () => {
    const start = toolHook({
      phase: "start",
      toolName: "edit",
      input: { path: "/tmp/a.ts", oldText: "a", newText: "b" },
      sessionId: "s1",
    });
    expect(start).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      pi_tool_name: "edit",
      tool_input: { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" },
    });

    const end = toolHook({
      phase: "end",
      toolName: "bash",
      input: { command: "npm test" },
      isError: true,
    });
    expect(end).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      is_error: true,
    });
  });

  it("maps ui_prompt_start/end onto the daemon's Notification and working events", () => {
    expect(uiPromptHook({ phase: "start", kind: "select", title: "Pick", sessionId: "s1" })).toEqual({
      hook_event_name: "Notification",
      session_id: "s1",
      notification_type: "elicitation_dialog",
      message: "Pick",
    });
    expect(uiPromptHook({ phase: "start", kind: "confirm", title: "Allow?" })).toEqual({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Allow?",
    });
    expect(uiPromptHook({ phase: "end", kind: "select", sessionId: "s1" })).toEqual({
      hook_event_name: "PostToolUse",
      session_id: "s1",
    });
  });

  it("keeps unknown tool names and tolerates non-object input", () => {
    expect(normalizeToolInput(undefined)).toEqual({});
    expect(normalizeToolInput("nope")).toEqual({});
    const hook = toolHook({ phase: "start", toolName: "custom_thing", input: { a: 1 } });
    expect(hook.tool_name).toBe("custom_thing");
    expect(hook.tool_input).toEqual({ a: 1 });
  });
});

describe("mod-event mappers", () => {
  it("turn.start uses the turn index as the Tiller turn id", () => {
    expect(turnStartPayload("hello", 4)).toEqual({ text: "hello", turnId: "4" });
  });

  it("turn.complete reports the final boundary", () => {
    expect(
      turnCompletePayload({
        turnId: 7,
        aborted: false,
        durationMs: 1234.7,
        answer: "done",
        model: "m",
        provider: "p",
      }),
    ).toEqual({
      answer: "done",
      durationMs: 1235,
      isAborted: false,
      turnId: "7",
      reason: "answer",
      usage: { model: "m", provider: "p" },
    });
    expect(turnCompletePayload({ turnId: 1, aborted: true, durationMs: -5 })).toEqual({
      durationMs: 0,
      isAborted: true,
      turnId: "1",
      reason: "aborted",
    });
  });

  it("turn.complete maps the final stopReason to error and aborted", () => {
    expect(
      turnCompletePayload({ turnId: 2, aborted: false, durationMs: 10, stopReason: "error" }),
    ).toMatchObject({ isAborted: false, reason: "error" });
    expect(
      turnCompletePayload({ turnId: 2, aborted: false, durationMs: 10, stopReason: "aborted" }),
    ).toMatchObject({ isAborted: true, reason: "aborted" });
    // A normal provider stop stays an answer.
    expect(
      turnCompletePayload({ turnId: 2, aborted: false, durationMs: 10, stopReason: "stop" }),
    ).toMatchObject({ isAborted: false, reason: "answer" });
  });

  it("measureContext handles known and unknown token estimates", () => {
    expect(measureContext({ tokens: 500, contextWindow: 1000, percent: null })).toEqual({
      tokens: 500,
      window: 1000,
      percent: 50,
    });
    expect(measureContext({ tokens: null, contextWindow: 1000, percent: null })).toBeUndefined();
    expect(measureContext(undefined)).toBeUndefined();
  });

  it("sumSessionCost mirrors pi's getSessionStats cost accounting", () => {
    const entries = [
      { type: "usage", usage: { cost: { total: 0.1 } } },
      { type: "compaction", usage: { cost: { total: 0.2 } } },
      { type: "branch_summary", usage: { cost: { total: 0.3 } } },
      { type: "message", message: { role: "assistant", usage: { cost: { total: 1.5 } } } },
      { type: "message", message: { role: "toolResult", usage: { cost: { total: 0.4 } } } },
      { type: "message", message: { role: "user" } },
      { type: "custom" },
      null,
    ];
    expect(sumSessionCost(entries)).toBeCloseTo(2.5, 10);
  });
});

describe("messageText", () => {
  it("reads string and text-part assistant messages", () => {
    expect(messageText({ role: "assistant", content: "hi" })).toBe("hi");
    expect(
      messageText({
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "toolCall", id: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(messageText({ role: "assistant", content: [{ type: "toolCall" }] })).toBeUndefined();
  });
});
