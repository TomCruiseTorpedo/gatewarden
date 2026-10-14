/**
 * @gatewarden/gateway/proxy — public barrel.
 *
 * Exports the GatewardenProxy class — the fused scoring + enforcement proxy
 * (gateway-004, ADR-C).
 *
 * Usage:
 *   import { GatewardenProxy } from '@gatewarden/gateway/proxy';
 *   const proxy = new GatewardenProxy(bundle);
 *   const snapshot = await proxy.attach(clientTransport, downstreamTransport);
 */

export { GatewardenProxy, carriesUntrustedMarker } from './gateway.js';
export type { ProxyOptions, TaintRecord } from './gateway.js';
