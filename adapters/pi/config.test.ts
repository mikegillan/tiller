import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  missingCapabilities,
  parseBridgeConfig,
  supportsNativeEvents,
} from "./config.ts";

const base = {
  TL_NODE_ID: "n-abc123",
  TL_ENDPOINT: "http://127.0.0.1:7654",
  TL_TOKEN_FILE: "/tmp/token",
};

describe("parseBridgeConfig", () => {
  it("parses the required node-scoped environment", () => {
    const result = parseBridgeConfig(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      nodeId: "n-abc123",
      endpoint: "http://127.0.0.1:7654",
      tokenFile: "/tmp/token",
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      hookTools: false,
      exposure: "direct",
      mcpName: "tl_abc123",
    });
  });

  it("trims values and strips a trailing slash from the endpoint", () => {
    const result = parseBridgeConfig({ ...base, TL_NODE_ID: " n-1 ", TL_ENDPOINT: "http://127.0.0.1:1/" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.nodeId).toBe("n-1");
      expect(result.config.endpoint).toBe("http://127.0.0.1:1");
    }
  });

  it("requires each core key", () => {
    for (const key of ["TL_NODE_ID", "TL_ENDPOINT", "TL_TOKEN_FILE"] as const) {
      const env = { ...base, [key]: "" };
      const result = parseBridgeConfig(env);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(key);
    }
  });

  it("rejects a non-http endpoint", () => {
    const result = parseBridgeConfig({ ...base, TL_ENDPOINT: "file:///tmp/sock" });
    expect(result.ok).toBe(false);
  });

  it("validates the poll interval", () => {
    expect(parseBridgeConfig({ ...base, TL_PI_POLL_MS: "50" }).ok).toBe(false);
    expect(parseBridgeConfig({ ...base, TL_PI_POLL_MS: "nope" }).ok).toBe(false);
    const ok = parseBridgeConfig({ ...base, TL_PI_POLL_MS: "2500" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.pollIntervalMs).toBe(2500);
  });

  it("validates the MCP exposure and optional flags", () => {
    expect(parseBridgeConfig({ ...base, TL_PI_MCP_EXPOSURE: "turbo" }).ok).toBe(false);
    const ok = parseBridgeConfig({
      ...base,
      TL_PI_MCP_EXPOSURE: "codemode",
      TL_PI_HOOK_TOOLS: "true",
      TL_PARENT_ID: "n-parent",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.exposure).toBe("codemode");
      expect(ok.config.hookTools).toBe(true);
      expect(ok.config.parentId).toBe("n-parent");
    }
  });

  it("keeps the daemon's TL_SESSION_ID as the managed session id", () => {
    const ok = parseBridgeConfig({ ...base, TL_SESSION_ID: " tiller-sess-1 " });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.sessionId).toBe("tiller-sess-1");
    const none = parseBridgeConfig(base);
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.config.sessionId).toBeUndefined();
  });
});

describe("missingCapabilities", () => {
  it("is empty for a complete API and lists what an incompatible build lacks", () => {
    const on = () => {};
    const sendUserMessage = () => {};
    const registerMcpServer = () => {};
    const unregisterMcpServer = () => {};
    expect(missingCapabilities({ on, sendUserMessage, registerMcpServer, unregisterMcpServer })).toEqual([]);
    expect(missingCapabilities({ on, sendUserMessage, unregisterMcpServer })).toEqual(["pi.registerMcpServer"]);
    expect(missingCapabilities({})).toEqual([
      "pi.on",
      "pi.sendUserMessage",
      "pi.registerMcpServer",
      "pi.unregisterMcpServer",
    ]);
  });
});

describe("native event contract", () => {
  it("only accepts stable native Pi 1.2.x versions; pi.on alone cannot prove event support", () => {
    expect(supportsNativeEvents("1.2.0")).toBe(true);
    expect(supportsNativeEvents("1.2.17")).toBe(true);
    for (const version of [undefined, "1.1.9", "1.3.0", "1.2.0-fork", "bad"]) {
      expect(supportsNativeEvents(version)).toBe(false);
    }
  });
});
