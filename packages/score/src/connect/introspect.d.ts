/**
 * Introspection — enumerate tools, resources, and prompts from a connected
 * MCP client, normalising the SDK response into the project's shared types.
 *
 * Capabilities declared by the server gate which lists are attempted; if a
 * capability is absent, the corresponding slice is returned as an empty array.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerIntrospection } from '../types.js';
import type { TransportKind } from './transports.js';
/**
 * Enumerate tools, resources, and prompts from a connected MCP client.
 *
 * @param client      A successfully connected `Client` instance.
 * @param transportKind  The transport used to connect (for error messages).
 * @returns           A normalised `ServerIntrospection` value.
 * @throws {McpConnectError}  On introspection-time protocol errors.
 */
export declare function introspect(client: Client, transportKind: TransportKind): Promise<ServerIntrospection>;
