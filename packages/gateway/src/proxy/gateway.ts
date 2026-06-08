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
 *   - `initialize`: capture `_meta['x-lease-token']` → sessionId binding.
 *   - `tools/list`: delegate to downstream.
 *   - `tools/call`:
 *       - Resolve tool → Action via bundle.resolver.
 *       - Unmapped tool → passthrough (R5).
 *       - No token bound → deny + audit.
 *       - Enforcer denies → deny + audit.
 *       - Enforcer allows → forward + audit use event.
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
import type { AuditEvent } from '@gatewarden/govern';
import type { GovernBundle } from '../config/index.js';
import type { GatewaySnapshot } from '../contract/index.js';
import { attachSnapshot, rescore as rescoreDownstream } from '../scoring/index.js';
import type { ScoringOptions } from '../scoring/index.js';

// ---------------------------------------------------------------------------
// GatewardenProxy
// ---------------------------------------------------------------------------

export class GatewardenProxy {
  /** Enforcing MCP server — what clients connect to. */
  private readonly server: Server;

  /**
   * Single downstream MCP client — shared between scorer (attach) and
   * enforcer (tools/call forwarding).  No second connection is ever opened (R1).
   */
  private readonly downstreamClient: Client;

  /**
   * Session token map: transport-level sessionId → lease token.
   * Populated at the `initialize` handshake.
   */
  private readonly sessionTokens = new Map<string, string>();

  /** Immutable snapshot captured at attach time (R3). */
  private snapshot: GatewaySnapshot | undefined;

  constructor(
    private readonly bundle: GovernBundle,
    private readonly opts: ScoringOptions = {},
  ) {
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

      if (typeof token === 'string' && extra.sessionId !== undefined) {
        this.sessionTokens.set(extra.sessionId, token);
      }

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

      // Resolve tool → Action.  Returns undefined for unmapped tools (R5).
      const action = this.bundle.resolver(toolName, toolArgs);

      // Unmapped tool → forward transparently, no enforcement (R5).
      if (action === undefined) {
        const result = await this.downstreamClient.callTool({
          name: toolName,
          arguments: toolArgs,
        });
        return result as unknown as { content: (typeof result)['content'] };
      }

      // Look up the lease token for this session.
      const sessionId = extra.sessionId;
      const token =
        sessionId !== undefined ? this.sessionTokens.get(sessionId) : undefined;

      if (token === undefined) {
        // No token at all — deny and audit (R4).
        this.appendEvent('denial', { toolName, reason: 'no lease token bound to session' });
        return this.denyResult('no lease token bound to session');
      }

      // Run the enforcer (R4).
      const check = this.bundle.enforcer.check(token, action);

      if (!check.ok) {
        const reason = check.reason ?? 'enforcement denied';
        this.appendEvent('denial', { toolName, reason, action });
        return this.denyResult(reason);
      }

      // Permitted — emit use event and forward (R7).
      this.appendEvent('use', { toolName, action });
      const downstream = await this.downstreamClient.callTool({
        name: toolName,
        arguments: toolArgs,
      });
      return downstream as unknown as { content: (typeof downstream)['content'] };
    });
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

  private appendEvent(
    type: AuditEvent['type'],
    detail: Record<string, unknown>,
  ): void {
    const event: AuditEvent = {
      type,
      at: new Date().toISOString(),
      detail,
      prevHash: '',
      hash: '',
    };
    this.bundle.audit.append(event);
  }
}
