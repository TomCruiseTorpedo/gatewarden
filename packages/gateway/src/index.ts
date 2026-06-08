/**
 * @gatewarden/gateway — public API barrel.
 *
 * One import surface for the full gateway public API:
 *   - Contract types, schemas, and buildToolActionResolver  (gateway-001)
 *   - Config loader and govern wiring                       (gateway-002)
 *   - Scoring surface (attachSnapshot, rescore)             (gateway-003)
 *   - GatewardenProxy (score-at-attach + in-path enforce)  (gateway-004)
 *
 * CLI (gateway-005) is intentionally NOT re-exported here — it is a binary
 * entry point, not a library surface.
 *
 * Usage:
 *   import { GatewardenProxy, loadConfig, attachSnapshot } from '@gatewarden/gateway';
 */

// ── Contract (gateway-001) ────────────────────────────────────────────────

export type {
  // Re-exported core types
  Scorecard,
  ServerMeta,
  Action,
  Lease,
  PolicyRule,
  Enforcer,
  AuditSink,
  ToolActionResolver,
  // Gateway-specific types
  DownstreamSpec,
  StdioDownstreamSpec,
  SseDownstreamSpec,
  HttpDownstreamSpec,
  ToolActionMapping,
  GatewayConfig,
  GatewaySnapshot,
  // Schema inferred types
  GatewayConfigInput,
  GatewayConfigOutput,
} from './contract/index.js';

export {
  DownstreamSpecSchema,
  ToolActionMappingSchema,
  GatewayConfigSchema,
  buildToolActionResolver,
} from './contract/index.js';

// ── Config (gateway-002) ──────────────────────────────────────────────────

export { loadConfig, ConfigLoadError } from './config/index.js';
export type { ConfigLoadErrorCode, GovernBundle } from './config/index.js';

export { wireGovern } from './config/index.js';

// ── Scoring (gateway-003) ─────────────────────────────────────────────────

export { attachSnapshot, rescore } from './scoring/index.js';
export type { ScoringOptions } from './scoring/index.js';

// ── Proxy (gateway-004) ───────────────────────────────────────────────────

export { GatewardenProxy } from './proxy/index.js';
