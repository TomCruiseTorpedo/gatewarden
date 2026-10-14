/**
 * GatewardenProxy — fuses scoring (gateway-003) and enforcement (govern) into
 * a single in-path MCP proxy (ADR-C).
 *
 * Design:
 *   - Construct from a `GovernBundle` (wireGovern, gateway-002) and optional
 *     `ScoringOptions` (gateway-003).
 *   - Call `attach(clientTransport, downstreamTransport)` to:
 *       1. Connect the single downstream `Client`.
 *       2. Score it immediately via `attachSnapshot` → store immutable snapshot (R3).
 *       3. Start the enforcing MCP `Server` on `clientTransport`.
 *   - The same downstream `Client` is shared between scorer and enforcer (R1).
 *   - Expose `getSnapshot()` and `rescore()`.
 *
 * Enforcement model (mirrors LeasebrokerProxy from govern):
 *   - `initialize`: capture `_meta['x-lease-token']` → per-connection binding.
 *   - `tools/list`: delegate to downstream.
 *   - `tools/call`:
 *       - Resolve tool → Action via bundle.resolver.
 *       - Unmapped tool → forward ungoverned + audit `passthrough` (R5).
 *       - No token bound → deny + audit.
 *       - Enforcer denies → deny + audit.
 *       - Enforcer allows → forward + audit use event.
 *
 * Unmapped tools:
 *   A tool with no mapped Action is forwarded transparently — no enforcement is
 *   applied — and recorded as a `passthrough` audit event so the ungoverned call
 *   is counted rather than invisible. A log that shows only governed traffic
 *   invites the reader to infer there was no other kind.
 *
 * Audit attribution:
 *   Every event raised after a successful token verification carries the lease
 *   id from the VERIFIED lease. See `appendEvent` for why it is never sourced
 *   from an unverified peek at the token.
 *
 * References: gateway-004, ADR-C, R1 R3 R4 R5 R7.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuditEvent, AuditEventInput, Lease } from '@gatewarden/govern';
import type { GovernBundle } from '../config/index.js';
import type { GatewaySnapshot, TaintRule } from '../contract/index.js';
import { attachSnapshot, rescore as rescoreDownstream } from '../scoring/index.js';
import type { ScoringOptions } from '../scoring/index.js';

// ---------------------------------------------------------------------------
// Session taint (ADR-K)
// ---------------------------------------------------------------------------

/** Proxy behaviour beyond scoring. */
export interface ProxyOptions {
  /** Session taint rule (ADR-K). Absent means no taint tracking at all. */
  taint?: TaintRule;
}

/** What tainted a connection: the first tool, and how it was recognised. */
export interface TaintRecord {
  /** The tool whose call or result tainted the connection. */
  tool: string;
  /** `marker`: its result carried the untrusted-content marker. `source-list`: it is in `taint.sources`. */
  via: 'marker' | 'source-list';
}

/**
 * True when a tool result carries `_meta.provenance.untrusted_content: true`.
 *
 * This is a convention, not part of the MCP specification: it comes from
 * `morluto/rea`, which marks every result (and error) whose content came from
 * an analysis target. Most servers never set it, which is why `taint.sources`
 * exists alongside it.
 */
export function carriesUntrustedMarker(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const meta = (result as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object') return false;
  const provenance = (meta as { provenance?: unknown }).provenance;
  return (
    provenance !== null &&
    typeof provenance === 'object' &&
    (provenance as { untrusted_content?: unknown }).untrusted_content === true
  );
}

/** Outcome of the taint gate for one call. */
type TaintGateResult =
  | { denied: false; detail: Record<string, unknown> }
  | { denied: true; result: { content: Array<{ type: 'text'; text: string }>; isError: true } };

// ---------------------------------------------------------------------------
// GatewardenProxy
// ---------------------------------------------------------------------------

/**
 * Binding key for a connection whose transport carries no session identity.
 *
 * `extra.sessionId` comes from `transport.sessionId`, and only some transports
 * set one: streamable HTTP does in stateful mode, but STDIO never does, nor
 * does streamable HTTP in stateless mode (`sessionIdGenerator: undefined`).
 * Keying the lease binding on `sessionId` alone therefore denied every mapped
 * tool call over stdio — the token was filed under `undefined` at the handshake
 * and never found again.
 *
 * Binding those connections under a shared key is sound because an SDK `Server`
 * accepts exactly one transport at a time ("use a separate Protocol instance
 * per connection" — Protocol.connect), so one proxy instance is always exactly
 * one client session. The NUL cannot collide with a real transport sessionId.
 */
const SINGLE_CONNECTION_KEY = '\u0000single-connection';

export class GatewardenProxy {
  /** Enforcing MCP server — what clients connect to. */
  private readonly server: Server;

  /**
   * Single downstream MCP client — shared between scorer (attach) and
   * enforcer (tools/call forwarding).  No second connection is ever opened (R1).
   */
  private readonly downstreamClient: Client;

  /**
   * Session token map: binding key → lease token, set at the `initialize`
   * handshake. The key is the transport-level sessionId when the transport
   * supplies one, and SINGLE_CONNECTION_KEY when it does not — see that
   * constant for why a shared key is safe here.
   */
  private readonly sessionTokens = new Map<string, string>();

  /** Immutable snapshot captured at attach time (R3). */
  private snapshot: GatewaySnapshot | undefined;

  /**
   * Taint per binding key (ADR-K): the FIRST thing that tainted the
   * connection. Cleared at that connection's next `initialize`, for the same
   * reason the lease binding is: the handshake starts a new connection.
   */
  private readonly taintByBinding = new Map<string, TaintRecord>();

  /** Session taint rule, or undefined when the operator configured none. */
  private readonly taint: TaintRule | undefined;

  constructor(
    private readonly bundle: GovernBundle,
    private readonly opts: ScoringOptions = {},
    proxyOptions: ProxyOptions = {},
  ) {
    this.taint = proxyOptions.taint;
    this.downstreamClient = new Client(
      { name: 'gatewarden-proxy-downstream', version: '1.0.0' },
      { capabilities: {} },
    );

    this.server = new Server(
      { name: 'gatewarden-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    this.installHandlers();
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  private installHandlers(): void {
    // initialize — capture lease token from _meta (R4).
    //
    // The SDK's Server pre-installs an _oninitialize handler; setRequestHandler
    // replaces it (documented behaviour — last set wins).
    this.server.setRequestHandler(InitializeRequestSchema, (request, extra) => {
      const rawMeta = request.params._meta as Record<string, unknown> | undefined;
      const token = rawMeta?.['x-lease-token'];

      // The handshake is authoritative for this connection's binding. A client
      // that presents no token must not inherit one left behind by an earlier
      // connection on a reused proxy instance, so the absent case CLEARS.
      const bindingKey = extra.sessionId ?? SINGLE_CONNECTION_KEY;
      if (typeof token === 'string') {
        this.sessionTokens.set(bindingKey, token);
      } else {
        this.sessionTokens.delete(bindingKey);
      }
      // A new handshake is a new connection: it starts untainted (ADR-K).
      this.taintByBinding.delete(bindingKey);

      // Protocol version negotiation (mirrors SDK's own logic).
      const requested = request.params.protocolVersion;
      const agreed = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

      return {
        protocolVersion: agreed,
        capabilities: { tools: {} },
        serverInfo: { name: 'gatewarden-proxy', version: '1.0.0' },
      };
    });

    // tools/list — delegate to downstream transparently.
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const result = await this.downstreamClient.listTools();
      return result as unknown as { tools: (typeof result)['tools'] };
    });

    // tools/call — enforce, then delegate or deny.
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const toolArgs = request.params.arguments ?? {};
      const bindingKey = extra.sessionId ?? SINGLE_CONNECTION_KEY;

      // Resolve tool → Action.  Returns undefined for unmapped tools (R5).
      const action = this.bundle.resolver(toolName, toolArgs);

      // Unmapped tool → forward transparently, no enforcement (R5).
      //
      // The call is NOT governed, but it IS counted. A `passthrough` event is
      // deliberately not folded into `use`: a `use` event asserts that a lease
      // was verified and the call fell within its scope, and neither happened
      // here. Conflating them would make the log claim governance it did not
      // perform. No leaseId — nothing was verified to attribute this to.
      if (action === undefined) {
        // The taint gate (ADR-K) runs BEFORE the passthrough: an unmapped sink
        // is exactly the ungoverned call the rule exists to catch.
        const gate = this.taintGate(bindingKey, toolName, undefined);
        if (gate.denied) return gate.result;

        this.appendEvent({
          type: 'passthrough',
          detail: {
            toolName,
            reason: 'no capability mapped to this tool name — forwarded without a lease check',
            ...gate.detail,
          },
        });
        return this.forward(bindingKey, toolName, toolArgs);
      }

      // Look up the lease token for this session.
      const token = this.sessionTokens.get(bindingKey);

      if (token === undefined) {
        // No token at all — deny and audit (R4).
        this.appendEvent({
          type: 'denial',
          detail: { toolName, reason: 'no lease token bound to session', ...this.taintDetail(bindingKey) },
        });
        return this.denyResult('no lease token bound to session');
      }

      // Run the enforcer (R4). It returns the VERIFIED lease with its verdict.
      const check = this.bundle.enforcer.check(token, action);

      // Attribution for the audit trail, taken from that verified lease — never
      // from an unverified peek at the token, which would attribute an action to
      // a lease id no signature backs. A record like that is worse than one with
      // no attribution at all, because it reads as authoritative.
      //
      // Denials from expiry, revocation or scope still carry it: those tokens
      // verified, they simply did not authorize the call. Only a signature
      // failure goes unattributed.
      if (!check.ok) {
        const reason = check.reason ?? 'enforcement denied';
        this.appendEvent({
          type: 'denial',
          ...(check.lease !== undefined ? { leaseId: check.lease.id } : {}),
          detail: {
            toolName,
            reason,
            action,
            ...(check.lease !== undefined ? { taskId: check.lease.taskId } : {}),
            ...this.taintDetail(bindingKey),
          },
        });
        return this.denyResult(reason);
      }

      // The lease permits the call, but a tainted connection may still not
      // reach a sink (ADR-K). Checked after verification so the denial can
      // name the lease that tried.
      const gate = this.taintGate(bindingKey, toolName, check.lease);
      if (gate.denied) return gate.result;

      // Permitted — emit use event and forward (R7).
      //
      // `check.ok` narrows `lease` to present, so the attribution a `use` event
      // requires is guaranteed by the types rather than by a runtime guard.
      this.appendEvent({
        type: 'use',
        leaseId: check.lease.id,
        detail: { toolName, action, taskId: check.lease.taskId, ...gate.detail },
      });
      return this.forward(bindingKey, toolName, toolArgs);
    });
  }

  // ---------------------------------------------------------------------------
  // Forwarding and session taint (ADR-K)
  // ---------------------------------------------------------------------------

  /**
   * Forward one call downstream and update the connection's taint.
   *
   * A `taint.sources` tool taints the connection BEFORE it is forwarded: the
   * operator has declared its output untrusted, and a call that fails midway
   * may still have delivered some of it. The marker can only be read once the
   * result is back. It counts on error results too, because a failure can
   * carry target-derived text. A call that throws at the protocol level has no
   * result to read.
   */
  private async forward(
    bindingKey: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<{ content: unknown }> {
    if (this.taint !== undefined && this.taint.sources.includes(toolName)) {
      this.markTainted(bindingKey, { tool: toolName, via: 'source-list' });
    }
    const result = await this.downstreamClient.callTool({ name: toolName, arguments: toolArgs });
    if (this.taint !== undefined && carriesUntrustedMarker(result)) {
      this.markTainted(bindingKey, { tool: toolName, via: 'marker' });
    }
    return result as unknown as { content: (typeof result)['content'] };
  }

  /** Record the FIRST taint for a connection; later ones do not overwrite it. */
  private markTainted(bindingKey: string, record: TaintRecord): void {
    if (!this.taintByBinding.has(bindingKey)) {
      this.taintByBinding.set(bindingKey, record);
    }
  }

  /**
   * `{ taintedBy }` for audit details once the connection is tainted, else
   * nothing. Every event after the onset carries it, so the first such event
   * locates the onset in the log. govern's audit event kinds are vendored
   * verbatim, so the onset has no event kind of its own.
   */
  private taintDetail(bindingKey: string): Record<string, unknown> {
    const taint = this.taintByBinding.get(bindingKey);
    return taint !== undefined ? { taintedBy: { ...taint } } : {};
  }

  /**
   * Decide whether a call to `toolName` may proceed on a tainted connection.
   *
   * Passes when no rule is configured, the connection is untainted, or the
   * tool is not a sink. In `audit` mode a sink passes with `taintSink: true`
   * in its detail. In `deny` mode a sink is refused with a denial event that
   * names the tool that tainted the connection, attributed to the verified
   * lease when there is one.
   */
  private taintGate(bindingKey: string, toolName: string, lease: Lease | undefined): TaintGateResult {
    const detail = this.taintDetail(bindingKey);
    const taint = this.taintByBinding.get(bindingKey);
    if (this.taint === undefined || taint === undefined || !this.taint.sinks.includes(toolName)) {
      return { denied: false, detail };
    }
    if (this.taint.mode === 'audit') {
      return { denied: false, detail: { ...detail, taintSink: true } };
    }

    const how = taint.via === 'marker' ? 'returned content marked untrusted' : 'is a configured taint source';
    const reason =
      `session tainted: '${taint.tool}' ${how}, so sink '${toolName}' is blocked ` +
      'until the client starts a new connection';
    this.appendEvent({
      type: 'denial',
      ...(lease !== undefined ? { leaseId: lease.id } : {}),
      detail: {
        toolName,
        reason,
        ...(lease !== undefined ? { taskId: lease.taskId } : {}),
        ...detail,
      },
    });
    return { denied: true, result: this.denyResult(reason) };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Attach to a downstream MCP server.
   *
   * Steps (in order):
   *   1. Connect the downstream client over `downstreamTransport`.
   *   2. Score the downstream immediately via `attachSnapshot` → immutable snapshot.
   *   3. Start the enforcing proxy server on `clientTransport`.
   *
   * Returns the snapshot so callers can inspect it immediately.
   *
   * @param clientTransport     Transport clients connect to (proxy server side).
   * @param downstreamTransport Transport to the real downstream MCP server.
   */
  async attach(
    clientTransport: Transport,
    downstreamTransport: Transport,
  ): Promise<GatewaySnapshot> {
    // 1. Connect downstream first — must be ready before clients arrive.
    await this.downstreamClient.connect(downstreamTransport);

    // 2. Score at attach time using the SAME client (R1 — no second connection).
    this.snapshot = await attachSnapshot(this.downstreamClient, this.opts);

    // 3. Start the enforcing proxy server.
    await this.server.connect(clientTransport);

    return this.snapshot;
  }

  /**
   * Return the immutable snapshot captured at attach time (R3).
   *
   * @throws if `attach()` has not been called yet.
   */
  getSnapshot(): GatewaySnapshot {
    if (this.snapshot === undefined) {
      throw new Error('GatewardenProxy: no snapshot — call attach() first');
    }
    return this.snapshot;
  }

  /**
   * Re-score the downstream server, producing a **new** `GatewaySnapshot` (R3).
   *
   * Uses the same downstream client (R1). The stored snapshot is NOT mutated —
   * this always returns a fresh object. Call `getSnapshot()` to read the
   * original attach-time snapshot.
   */
  async rescore(): Promise<GatewaySnapshot> {
    return rescoreDownstream(this.downstreamClient, this.opts);
  }

  /** Close both the enforcing server and the downstream client. */
  async close(): Promise<void> {
    await this.server.close();
    await this.downstreamClient.close();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private denyResult(
    reason: string,
  ): { content: Array<{ type: 'text'; text: string }>; isError: true } {
    return {
      content: [{ type: 'text', text: `denied: ${reason}` }],
      isError: true,
    };
  }

  /**
   * Append one audit event.
   *
   * Takes the whole event as one object rather than `(type, detail, leaseId?)`
   * so the discriminant narrows on the literal `type`, which is what lets the
   * contract require `leaseId` on the kinds that cannot be stated without it.
   * A widened `type` parameter would silently accept an unattributed `use`.
   *
   * `leaseId` is omitted entirely when absent rather than written as
   * `undefined`, so an unattributable record is visibly missing the field
   * instead of carrying an empty one.
   *
   * Callers must source `leaseId` from a VERIFIED lease. An audit record naming
   * a lease id lifted from an unverified token looks authoritative while
   * asserting something no signature backs — and the hash chain will seal it
   * just as faithfully as a true one.
   */
  private appendEvent(input: AuditEventInput): void {
    const event: AuditEvent = {
      ...input,
      at: new Date().toISOString(),
      prevHash: '',
      hash: '',
    };
    this.bundle.audit.append(event);
  }
}
