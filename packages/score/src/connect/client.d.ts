/**
 * MCP client factory with actionable error handling.
 *
 * Wraps the SDK's Client.connect() so that handshake failures emit a
 * human-readable message naming the transport and the failed step — no
 * raw stack dumps exposed to end-users.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportKind } from './transports.js';
/**
 * Emitted when the MCP client cannot establish or complete a connection.
 *
 * The message is intentionally user-facing: "transport kind + failed step +
 * cause message". No stack trace of the underlying SDK error is included.
 */
export declare class McpConnectError extends Error {
    readonly transport: TransportKind;
    readonly step: string;
    constructor(transport: TransportKind, step: string, cause: unknown);
}
export interface ConnectOptions {
    /** Client name advertised to the server (default: "mcp-fit") */
    name?: string;
    /** Client version advertised to the server (default: "0.1.0") */
    version?: string;
}
/**
 * Create and connect an MCP client via the supplied transport.
 *
 * @throws {McpConnectError} on any connection or handshake failure.
 */
export declare function connectClient(transport: Transport, transportKind: TransportKind, options?: ConnectOptions): Promise<Client>;
