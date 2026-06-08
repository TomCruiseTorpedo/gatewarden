/**
 * @gatewarden/gateway/config — public barrel.
 *
 * Exports the config loader and govern wiring for downstream consumers
 * (proxy layer, CLI, integration barrel).
 *
 * What's in scope:
 *   - loadConfig     — async file-system loader + Zod validation
 *   - ConfigLoadError — typed error class with error codes
 *   - wireGovern     — constructs the full govern runtime from a validated config
 *   - GovernBundle   — the typed bundle returned by wireGovern
 *
 * What's NOT here (by design):
 *   - Contract types and schemas  (gateway-001, ../contract)
 *   - Scoring                     (gateway-003, ../scoring)
 *   - Proxy / enforcement         (gateway-004, ../proxy)
 *   - CLI                         (gateway-005, ../cli)
 */

export { loadConfig, ConfigLoadError } from './loader.js';
export type { ConfigLoadErrorCode } from './loader.js';

export { wireGovern } from './wire.js';
export type { GovernBundle } from './wire.js';
