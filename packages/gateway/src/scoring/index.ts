/**
 * @gatewarden/gateway/scoring — public barrel.
 *
 * Exports the keyless attach+rescore surface used by:
 *   - `GatewardenProxy` (gateway-004): attaches on connect, rescores on demand
 *   - CLI `score` command (gateway-005): prints a snapshot without serving
 *
 * What's here:
 *   - `attachSnapshot` — introspect + lint + score → immutable GatewaySnapshot
 *   - `rescore`        — same pipeline, always returns a NEW snapshot (R3)
 *   - `ScoringOptions` — transport kind override for error messages
 *
 * What's NOT here (by design):
 *   - LLM eval scoring (`@gatewarden/score`'s `score()` handles that)
 *   - Connection management (caller owns the Client lifecycle)
 *   - Config loading (gateway-002)
 */

export { attachSnapshot, rescore } from './attach.js';
export type { ScoringOptions } from './attach.js';
