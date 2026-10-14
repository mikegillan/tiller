/**
 * Environment and configuration parsing for the Tiller Pi extension.
 *
 * The daemon launches Pi with the same node-scoped environment it uses for Claude nodes:
 * `TL_NODE_ID`, `TL_ENDPOINT`, `TL_TOKEN_FILE`, and optionally `TL_PARENT_ID` / `TL_SESSION_DIR`.
 *
 * The adapter intentionally supports no way to weaken or strengthen Pi's permission handling.
 * Configuration keys that request restrictions the adapter cannot enforce are treated as
 * unsupported and must be rejected by the daemon before launch. `findUnsupportedRestrictions()`
 * is exported so daemon code can share the allow/deny list, and the extension itself refuses to
 * activate the bridge if it sees any of them.
 */

export const TILLER_MCP_NAME = "tiller";
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const MIN_POLL_INTERVAL_MS = 100;

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/**
 * Environment keys that would ask the adapter to restrict, broaden, or otherwise alter Pi's
 * permission/tool safety. The adapter cannot honor these (it must not change permission safety),
 * so their presence is an error rather than a silent no-op.
 */
export const UNSUPPORTED_RESTRICTION_KEYS = [
  "TL_PERMISSION_MODE",
  "TL_APPROVAL_MODE",
  "TL_ALLOWED_TOOLS",
  "TL_TOOLS",
  "TL_DISALLOWED_TOOLS",
  "TL_EXCLUDE_TOOLS",
  "TL_MAX_TURNS",
  "TL_SANDBOX",
  "TL_BYPASS_PERMISSIONS",
] as const;

export interface BridgeConfig {
  nodeId: string;
  endpoint: string;
  tokenFile: string;
  parentId?: string;
  sessionDir?: string;
  /**
   * The daemon-minted Tiller session id (`TL_SESSION_ID`). The node record, transcript path and
   * resume all key off this value, so the bridge must never replace it with Pi's own header UUID.
   * Absent only on an unmanaged (non-daemon) launch.
   */
  sessionId?: string;
  pollIntervalMs: number;
  /** Forward Pi tool activity to Tiller's `/hook` (PreToolUse / PostToolUse). Default false. */
  hookTools: boolean;
  /** Exposure for the registered `tiller` MCP server. Default "direct". */
  exposure: McpExposure;
  mcpName: string;
}

export type ParseBridgeConfigResult =
  | { ok: true; config: BridgeConfig }
  | { ok: false; error: string };

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Env keys present with a non-empty value that the adapter refuses to run with. */
export function findUnsupportedRestrictions(
  env: Record<string, string | undefined>,
): string[] {
  return UNSUPPORTED_RESTRICTION_KEYS.filter((key) => nonEmpty(env[key]) !== undefined);
}

/**
 * Parse the Tiller environment. Returns a result object rather than throwing so the caller can
 * surface a single human-readable error and stay inert.
 */
export function parseBridgeConfig(
  env: Record<string, string | undefined>,
  options: { defaultPollIntervalMs?: number } = {},
): ParseBridgeConfigResult {
  const nodeId = nonEmpty(env.TL_NODE_ID);
  if (!nodeId) return { ok: false, error: "TL_NODE_ID is required" };

  const endpoint = nonEmpty(env.TL_ENDPOINT);
  if (!endpoint) return { ok: false, error: "TL_ENDPOINT is required" };
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return { ok: false, error: `TL_ENDPOINT is not a valid URL: ${endpoint}` };
  }
  if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
    return { ok: false, error: `TL_ENDPOINT must use http or https: ${endpoint}` };
  }

  const tokenFile = nonEmpty(env.TL_TOKEN_FILE);
  if (!tokenFile) return { ok: false, error: "TL_TOKEN_FILE is required" };

  let pollIntervalMs = options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const rawPoll = nonEmpty(env.TL_PI_POLL_MS);
  if (rawPoll !== undefined) {
    const parsed = Number(rawPoll);
    if (!Number.isFinite(parsed) || parsed < MIN_POLL_INTERVAL_MS) {
      return {
        ok: false,
        error: `TL_PI_POLL_MS must be a number >= ${MIN_POLL_INTERVAL_MS}: ${rawPoll}`,
      };
    }
    pollIntervalMs = Math.floor(parsed);
  }

  const exposure = (nonEmpty(env.TL_PI_MCP_EXPOSURE) ?? "direct").toLowerCase();
  if (!(MCP_EXPOSURES as readonly string[]).includes(exposure)) {
    return {
      ok: false,
      error: `unsupported TL_PI_MCP_EXPOSURE: ${exposure} (expected ${MCP_EXPOSURES.join(", ")})`,
    };
  }

  return {
    ok: true,
    config: {
      nodeId,
      endpoint: endpoint.replace(/\/+$/, ""),
      tokenFile,
      parentId: nonEmpty(env.TL_PARENT_ID),
      sessionDir: nonEmpty(env.TL_SESSION_DIR),
      sessionId: nonEmpty(env.TL_SESSION_ID),
      pollIntervalMs,
      hookTools: ["1", "true", "yes", "on"].includes(
        (nonEmpty(env.TL_PI_HOOK_TOOLS) ?? "").toLowerCase(),
      ),
      exposure: exposure as McpExposure,
      mcpName: TILLER_MCP_NAME,
    },
  };
}

/** The subset of the Pi API the capability gate inspects before any resource is registered. */
export interface PiCapabilityApi {
  on?: unknown;
  sendUserMessage?: unknown;
  registerMcpServer?: unknown;
}

/**
 * Members Pi must provide for the bridge to work at all. A build without `registerMcpServer`
 * cannot receive Tiller's tools, and one without `sendUserMessage` cannot receive messages, so
 * the extension fails closed (and asks Pi to shut down) instead of running a half node.
 */
export function missingCapabilities(api: PiCapabilityApi): string[] {
  const missing: string[] = [];
  if (typeof api.on !== "function") missing.push("pi.on");
  if (typeof api.sendUserMessage !== "function") missing.push("pi.sendUserMessage");
  if (typeof api.registerMcpServer !== "function") missing.push("pi.registerMcpServer");
  return missing;
}
