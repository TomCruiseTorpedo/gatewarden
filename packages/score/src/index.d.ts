/**
 * @gatewarden/score — public API barrel.
 *
 * Added during the P3 re-home (ADR-0) so the gateway package can import the
 * scorer as a workspace dependency. mcp-fit was CLI-first and had no barrel;
 * this re-exports the surface the gateway composition needs and nothing else
 * changes (source + 348 tests untouched).
 */
export * from './types.js';
export { score, scoreLintOnly } from './score/scorer.js';
export type { ScorerInput, ScorerResult } from './score/scorer.js';
export { AXIS_LINEAGE, AXIS_WEIGHTS, weightedAggregate } from './score/axes.js';
export { lint } from './lint/engine.js';
export type { LintResult } from './lint/engine.js';
export { connectClient, McpConnectError } from './connect/client.js';
export type { ConnectOptions } from './connect/client.js';
export { introspect } from './connect/introspect.js';
export { createTransport } from './connect/transports.js';
export type { TransportOptions, StdioTransportOptions, SseTransportOptions, } from './connect/transports.js';
export { McpProxy, applyOverridesToIntrospection } from './connect/proxy.js';
export type { ProxyOptions } from './connect/proxy.js';
