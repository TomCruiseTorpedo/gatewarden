/**
 * LeasebrokerProxy — MCP proxy server with lease enforcement (ADR-B).
 *
 * Architecture:
 *   Client → [proxy server side] → Enforcer → [proxy client side] → Downstream MCP server
 *
 * Session binding:
 *   The client presents a lease token at the MCP initialize handshake by including
 *   it in `params._meta['x-lease-token']`.  The proxy records `sessionId → token`
 *   and uses it to enforce every subsequent tools/call in that session.
 *
 *   `extra.sessionId` is populated by the SDK from `transport.sessionId`
 *   (available in SDK v1.x low-level setRequestHandler).
 *
 * Unknown tools:
 *   If the `toolActionResolver` returns `undefined` for a tool (i.e. the tool
 *   has no mapped Action), it is forwarded to the downstream transparently —
 *   no enforcement is applied.
 *
 * Usage:
 *   const proxy = new LeasebrokerProxy({ enforcer, audit, toolActionResolver });
 *   await proxy.connect(clientSideTransport, downstreamTransport);
 *   // ...
 *   await proxy.close();
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Action, AuditSink, Enforcer } from '../contract/index.js';
/**
 * Maps a tool name + arguments to an Action for enforcement.
 * Return `undefined` to pass the call through without enforcement.
 */
export type ToolActionResolver = (toolName: string, toolArgs: Record<string, unknown>) => Action | undefined;
export interface ProxyServerOptions {
    /** Enforcer that gates every mapped tool call. */
    enforcer: Enforcer;
    /** Audit sink for use and denial events. */
    audit: AuditSink;
    /**
     * Maps tool calls to Actions for enforcement.
     * If omitted, or when it returns `undefined`, calls are forwarded transparently.
     */
    toolActionResolver?: ToolActionResolver;
}
export declare class LeasebrokerProxy {
    private readonly opts;
    /** Low-level MCP server that clients connect to. */
    private readonly server;
    /** MCP client that connects to the downstream MCP server. */
    private readonly downstreamClient;
    /**
     * Session token map: transport-level sessionId → lease token.
     * Populated at initialize handshake.
     */
    private readonly sessionTokens;
    constructor(opts: ProxyServerOptions);
    private installHandlers;
    /**
     * Connect the proxy.  The downstream is connected first so it is ready before
     * any client requests arrive.
     *
     * @param clientTransport   Transport that clients connect to (proxy server side).
     * @param downstreamTransport Transport to the real downstream MCP server (proxy client side).
     */
    connect(clientTransport: Transport, downstreamTransport: Transport): Promise<void>;
    close(): Promise<void>;
    private denyResult;
    private appendEvent;
}
