/**
 * @gatewarden/gateway/a2a — governed A2A downstream lane (ADR-H).
 *
 * The ONLY modules importing @a2a-js/sdk live in this directory; the SDK is
 * a 1.0.0-beta pin behind this seam (single re-pin point at GA).
 */

export { attachA2aSnapshot, fetchAgentCardRaw, resolveCardUrl } from './attach.js';
export type { FetchLike } from './attach.js';

export {
  GovernedA2aDownstream,
  createA2aWireClient,
  deriveSendActions,
  isTerminalTaskState,
  LEASE_SERVICE_PARAMETERS,
} from './downstream.js';
export type {
  A2aSendInput,
  A2aSendResult,
  A2aWireClient,
  A2aWireRequestOptions,
  GovernedA2aDownstreamOptions,
} from './downstream.js';

export { generateAgentCard } from './card-generator.js';
export type { CardGeneratorOptions } from './card-generator.js';
