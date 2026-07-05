/**
 * @gatewarden/score — public API barrel.
 *
 * Added during the P3 re-home (ADR-0) so the gateway package can import the
 * scorer as a workspace dependency. mcp-fit was CLI-first and had no barrel;
 * this re-exports the surface the gateway composition needs and nothing else
 * changes (source + 348 tests untouched).
 */

// Shared contract types (Scorecard, ServerMeta, ServerIntrospection, McpTool,
// AxisName, AxisScore, Finding, ToolDef, DescriptionOverride, …).
export * from './types.js';

// Scoring pipeline.
export { score, scoreLintOnly } from './score/scorer.js';
export type { ScorerInput, ScorerResult } from './score/scorer.js';
export { AXIS_LINEAGE, AXIS_WEIGHTS, weightedAggregate } from './score/axes.js';

// Static lint engine.
export { lint } from './lint/engine.js';
export type { LintResult } from './lint/engine.js';

// MCP connection + introspection.
export { connectClient, McpConnectError } from './connect/client.js';
export type { ConnectOptions } from './connect/client.js';
export { introspect } from './connect/introspect.js';
export { createTransport } from './connect/transports.js';
export type {
  TransportOptions,
  StdioTransportOptions,
  SseTransportOptions,
} from './connect/transports.js';

// Re-presentation proxy (description overrides).
export { McpProxy, applyOverridesToIntrospection } from './connect/proxy.js';
export type { ProxyOptions } from './connect/proxy.js';

// A2A Agent Card scoring (ADR-F, vendored verbatim from mcp-fit src/a2a).
export {
  CARD_SCHEMA_VERSION,
  A2A_SPEC_VERSION,
  CARD_AXIS_NAMES,
} from './a2a/card-types.js';
export type {
  AgentCardJson,
  AgentSkillJson,
  AgentInterfaceJson,
  AgentExtensionJson,
  AgentCardSignatureJson,
  CardAxisName,
  CardAxisScore,
  CardFinding,
  CardMeta,
  CardScorecard,
  SignatureReport,
  SignatureTier,
  SkillReport,
} from './a2a/card-types.js';
export { lintCard } from './a2a/card-engine.js';
export type { CardLintResult } from './a2a/card-engine.js';
export { scoreCardLintOnly } from './a2a/card-scorer.js';
export { analyseSignatures } from './a2a/signature.js';
export { CARD_AXIS_WEIGHTS, weightedCardAggregate } from './a2a/card-axes.js';
export { validateCardScorecardSchema, emitCardCompat } from './a2a/emit.js';
