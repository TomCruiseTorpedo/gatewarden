/**
 * Gateway composition contract types.
 *
 * Re-exports core types from @gatewarden/score and @gatewarden/govern — never
 * redefines them. Adds the four gateway-specific shapes:
 *   - DownstreamSpec    — how to connect to the single downstream MCP server
 *   - ToolActionMapping — declarative tool → Action binding (drives buildToolActionResolver)
 *   - GatewayConfig     — top-level validated gateway configuration
 *   - GatewaySnapshot   — immutable snapshot of server + scorecard at attach time
 *
 * No runtime logic. Types only.
 */

// ---------------------------------------------------------------------------
// Imports + re-exports from @gatewarden/score
// ---------------------------------------------------------------------------

import type { Scorecard, ServerMeta } from '@gatewarden/score';
export type { Scorecard, ServerMeta };

// ---------------------------------------------------------------------------
// Imports + re-exports from @gatewarden/govern
// ---------------------------------------------------------------------------

import type {
  Action,
  Lease,
  PolicyRule,
  Enforcer,
  AuditSink,
  ToolActionResolver,
} from '@gatewarden/govern';
export type { Action, Lease, PolicyRule, Enforcer, AuditSink, ToolActionResolver };

// ---------------------------------------------------------------------------
// DownstreamSpec — how to connect to the single downstream MCP server (v1)
// ---------------------------------------------------------------------------

/** stdio transport — launches a subprocess. */
export type StdioDownstreamSpec = {
  transport: 'stdio';
  /** Executable to spawn (e.g. 'node', 'python', '@modelcontextprotocol/server-filesystem'). */
  command: string;
  /** Arguments passed to the subprocess. */
  args?: string[];
  /** Optional environment variables for the subprocess. */
  env?: Record<string, string>;
};

/** HTTP (Streamable-HTTP / SSE) transport — connects to an existing URL. */
export type SseDownstreamSpec = {
  transport: 'sse';
  /** Full URL of the SSE endpoint. */
  url: string;
};

/** Streamable HTTP transport. */
export type HttpDownstreamSpec = {
  transport: 'http';
  /** Full URL of the HTTP MCP endpoint. */
  url: string;
};

/**
 * Specification for the single downstream MCP server the gateway fronts.
 * v1 supports stdio (demo) and HTTP/SSE; exactly one downstream per config (R9).
 */
export type DownstreamSpec =
  | StdioDownstreamSpec
  | SseDownstreamSpec
  | HttpDownstreamSpec;

// ---------------------------------------------------------------------------
// ToolActionMapping — declarative tool → Action binding
// ---------------------------------------------------------------------------

/**
 * Maps a downstream tool call to a concrete `Action` kind by naming the
 * argument that carries the sensitive value (path / endpoint / amount).
 *
 * Discriminated on `kind` to keep each variant self-contained and the zod
 * schema straightforward.
 *
 * Resolver behaviour (R5, R6):
 *   - Unmapped tool → resolver returns `undefined`  → passthrough (R5).
 *   - Mapped tool, arg missing at call time → resolver returns an Action
 *     with a sentinel value that the Enforcer will deny (deny-by-default, R6).
 */
export type ToolActionMapping =
  | {
      /** Downstream tool name exactly as exposed by MCP tools/list. */
      toolName: string;
      kind: 'fs.read';
      /** Name of the tool argument that carries the filesystem path. */
      pathArg: string;
    }
  | {
      toolName: string;
      kind: 'fs.write';
      /** Name of the tool argument that carries the filesystem path. */
      pathArg: string;
    }
  | {
      toolName: string;
      kind: 'http.call';
      /** Name of the tool argument that carries the endpoint URL. */
      endpointArg: string;
    }
  | {
      toolName: string;
      kind: 'spend';
      /** Name of the argument carrying the ISO 4217 currency code. */
      currencyArg: string;
      /** Name of the argument carrying the integer minor-unit amount. */
      amountArg: string;
    };

// ---------------------------------------------------------------------------
// GatewayConfig — top-level validated gateway configuration
// ---------------------------------------------------------------------------

/**
 * Top-level configuration for a Gatewarden gateway instance.
 *
 * Validated at load time by the zod schema in schemas.ts.
 * Invariants enforced:
 *   - Exactly one downstream (R9).
 *   - toolActions contains only valid ToolActionMapping entries.
 */
export interface GatewayConfig {
  /** The single downstream MCP server this gateway fronts (R9). */
  downstream: DownstreamSpec;
  /** Declarative allow-rules for the policy engine (deny-by-default if empty). */
  policy: PolicyRule[];
  /** Declarative tool → Action mappings (unmapped tools pass through, R5). */
  toolActions: ToolActionMapping[];
  /** Optional scoring configuration (eval scoring is off by default, R2). */
  scoring?: {
    /** Enable LLM-based eval scoring (off by default, R2). */
    eval?: boolean;
  };
}

// ---------------------------------------------------------------------------
// GatewaySnapshot — immutable snapshot of server + scorecard at attach time
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot produced when the gateway attaches to a downstream.
 *
 * Captures the server identity, deterministic scorecard (R2), and timestamp.
 * Never mutated after creation (R3); rescore produces a NEW snapshot.
 */
export interface GatewaySnapshot {
  /** Identity and transport metadata of the downstream server. */
  readonly server: ServerMeta;
  /** Deterministic (keyless) scorecard captured at attach time (R2). */
  readonly scorecard: Scorecard;
  /** ISO 8601 timestamp of when this snapshot was taken. */
  readonly attachedAt: string;
}
