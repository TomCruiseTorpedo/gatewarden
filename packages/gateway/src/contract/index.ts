/**
 * @gatewarden/gateway/contract — public barrel.
 *
 * Single import surface for all contract types, schemas, and the pure
 * buildToolActionResolver factory. Downstream beads (config, scoring, proxy)
 * import from this barrel via relative paths (`./contract/index.js`).
 *
 * What's in scope here:
 *   - Re-exported core types from @gatewarden/score and @gatewarden/govern
 *   - Gateway-specific types (DownstreamSpec, ToolActionMapping, GatewayConfig, GatewaySnapshot)
 *   - Zod schemas (GatewayConfigSchema, ToolActionMappingSchema, DownstreamSpecSchema)
 *   - buildToolActionResolver (pure, no I/O)
 *
 * What's NOT here (by design):
 *   - Config loading (gateway-002)
 *   - Scoring (gateway-003)
 *   - Proxy / enforcement (gateway-004)
 *   - CLI (gateway-005)
 */

// Types
export type {
  // Re-exported core types (not redefined)
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
} from './types.js';

// Schemas
export {
  DownstreamSpecSchema,
  ToolActionMappingSchema,
  GatewayConfigSchema,
} from './schemas.js';

export type { GatewayConfigInput, GatewayConfigOutput } from './schemas.js';

// Pure factory
export { buildToolActionResolver } from './resolver.js';
