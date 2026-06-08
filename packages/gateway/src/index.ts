/**
 * @gatewarden/gateway — public API barrel.
 *
 * Wave-0: contract types, schemas, and buildToolActionResolver.
 * Subsequent waves (config, scoring, proxy, cli) will expand this barrel.
 *
 * Replaces the scaffold placeholder (`__rehomeSmoke`) — the contract is
 * the first real export surface.
 */

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
