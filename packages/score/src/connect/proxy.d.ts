/**
 * Re-presentation proxy — overrides tool and parameter descriptions without
 * altering server behaviour.
 *
 * Design rationale (ADR-D): third-party servers cannot have their source
 * edited, so mcp-fit proxies them with rewritten descriptions. The proxy:
 *   - Applies `DescriptionOverride` records to `listTools()` output.
 *   - Forwards `callTool()` to the underlying client unchanged (behaviour
 *     is transparent; only the description layer is touched).
 *   - Supports runtime override updates (`setOverrides`), enabling the
 *     fix-mode before/after without reconnecting.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DescriptionOverride, ToolDef, ServerIntrospection } from '../types.js';
export interface ProxyOptions {
    /** Initial set of description overrides to apply */
    overrides?: DescriptionOverride[];
}
/**
 * In-process proxy wrapping a connected `Client`.
 *
 * - `listTools()`: returns tool definitions with overrides applied.
 * - `callTool()`: forwards directly to the underlying client (unchanged behaviour).
 * - `setOverrides()`: replaces the active override set at runtime.
 */
export declare class McpProxy {
    private readonly client;
    private overrideMap;
    constructor(client: Client, options?: ProxyOptions);
    /**
     * List tools from the underlying server, with description overrides applied.
     */
    listTools(): Promise<ToolDef[]>;
    /**
     * Invoke a tool on the underlying server.
     *
     * Arguments are forwarded unmodified; the result is returned unmodified.
     * Overrides have no effect on invocation — only descriptions change.
     */
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    /**
     * Replace the active override set.
     *
     * Subsequent `listTools()` calls will use the new overrides.
     */
    setOverrides(overrides: DescriptionOverride[]): void;
    /**
     * Return the current override set (for inspection / diffing).
     */
    getOverrides(): DescriptionOverride[];
    /**
     * Access the underlying `Client` (for introspection of resources/prompts,
     * or direct call patterns that bypass the proxy layer).
     */
    getClient(): Client;
}
/**
 * Apply a set of description overrides to a full `ServerIntrospection` value.
 *
 * Returns a new object; the original is not mutated.
 */
export declare function applyOverridesToIntrospection(introspection: ServerIntrospection, overrides: DescriptionOverride[]): ServerIntrospection;
