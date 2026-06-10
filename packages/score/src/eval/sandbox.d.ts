/**
 * Eval sandbox — restricts the agent harness to only target-server tools
 * plus an in-memory scratch space.
 *
 * Security contract (spec §Dynamic Eval, ADR-B):
 *   - The eval agent is granted only the target server's tools plus a
 *     sandboxed scratch space.
 *   - Host capabilities (filesystem, shell, broader network) are explicitly
 *     denied even if they somehow appear in the toolset.
 *
 * This is an in-process sandbox (v1). OS-level isolation is out of scope.
 */
import type { ToolDef } from '../types.js';
/**
 * A toolset: something that can list tools and call them.
 * McpProxy satisfies this interface structurally.
 */
export interface Toolset {
    listTools(): Promise<ToolDef[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
/** Returns true when `name` matches a host-capability denial pattern. */
export declare function isDeniedHostCapability(name: string): boolean;
/** Thrown when the sandbox blocks a tool call. */
export declare class SandboxError extends Error {
    constructor(message: string);
}
/**
 * In-process sandbox wrapping a `Toolset`.
 *
 * - `listTools()`: returns only tools in `allowedToolNames` that are not host-capability denials.
 * - `callTool()`: forwards to the underlying toolset after enforcement checks.
 * - Scratch space: ephemeral key-value store for the agent session.
 */
export declare class Sandbox implements Toolset {
    private readonly toolset;
    private readonly allowedToolNames;
    private readonly scratch;
    constructor(toolset: Toolset, allowedToolNames: ReadonlySet<string>);
    /** List tools, filtered to allowed set and minus host-capability denials. */
    listTools(): Promise<ToolDef[]>;
    /**
     * Call a tool through the sandbox enforcement layer.
     *
     * @throws {SandboxError} if the tool matches a host-capability denial pattern.
     * @throws {SandboxError} if the tool is not in the allowed set.
     */
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
    /** Store a value in the ephemeral scratch space. */
    scratchSet(key: string, value: unknown): void;
    /** Retrieve a value from the ephemeral scratch space. Returns undefined if absent. */
    scratchGet(key: string): unknown;
    /** Delete a value from the ephemeral scratch space. */
    scratchDelete(key: string): void;
    /** Check whether a key exists in the scratch space. */
    scratchHas(key: string): boolean;
}
/**
 * Create a sandbox from a toolset.
 *
 * Pass `null` for `allowedToolNames` to allow all tools from the toolset
 * (minus host-capability denials). Pass an explicit set to further restrict.
 *
 * @example
 * ```ts
 * const tools = await proxy.listTools();
 * const allowed = new Set(tools.map(t => t.name));
 * const sandbox = createSandbox(proxy, allowed);
 * ```
 */
export declare function createSandbox(toolset: Toolset, allowedToolNames: Set<string>): Sandbox;
