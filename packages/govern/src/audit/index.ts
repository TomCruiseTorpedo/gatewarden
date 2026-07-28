/**
 * Audit module barrel.
 *
 * Exports the concrete implementations of the audit-lane interfaces.
 * Consumers should depend on the interfaces from src/contract, not on
 * these concrete classes — except where construction requires setCap
 * or other concrete-only methods.
 */

export { InMemoryAuditSink } from './audit-sink.js';
export { InMemoryPendingStore } from './pending-store.js';
export { InMemoryRevocationList } from './revocation-list.js';
export { InMemorySpendLedger } from './spend-ledger.js';

// Stored-chain verification. Vendored from leasebroker as shared security
// engine, not as a leasebroker feature: it is what lets a log be loaded
// WITHOUT re-chaining it, so a tampered audit.jsonl stays detectable instead
// of being laundered into a valid-looking chain on load.
//
// This barrel deliberately does NOT re-export leasebroker's otel-exporter,
// workflow-report or anchor modules — those are product features that gate-
// warden does not vendor, which is why this file is absent from the govern
// drift manifest while stored-chain.ts itself is in it.
export { parseStoredAuditJsonl } from './stored-chain.js';
export type { AuditIntegrity, StoredAuditLog } from './stored-chain.js';
