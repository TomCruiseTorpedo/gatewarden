/**
 * Transport factory — creates typed MCP client transports.
 *
 * Supports stdio (spawn-a-process) and SSE (legacy remote). The
 * StreamableHTTP transport (recommended for new remote servers) can be
 * added in a future bead; SSE covers all currently public MCP servers.
 */
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create an MCP transport from configuration options.
 *
 * Returns an unstarted transport; caller connects it via `Client.connect()`.
 */
export function createTransport(opts) {
    switch (opts.kind) {
        case 'stdio':
            return new StdioClientTransport({
                command: opts.command,
                args: opts.args ?? [],
                env: opts.env,
            });
        case 'sse':
            return new SSEClientTransport(new URL(opts.url), {
                requestInit: opts.headers
                    ? { headers: opts.headers }
                    : undefined,
            });
    }
}
