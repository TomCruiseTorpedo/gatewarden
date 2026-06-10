/**
 * Contract barrel — re-exports all types, interfaces, and schemas.
 *
 * Consumers import from here:
 *   import type { Lease, Signer } from 'leasebroker/contract';
 *   import { LeaseSchema, CapabilitySchema } from 'leasebroker/contract';
 */
export type { CapabilityKind, FsReadCapability, FsWriteCapability, HttpCallCapability, SpendCapability, Capability, Scope, LeaseRequest, Lease, Decision, AuditEventType, AuditEvent, VerifyResult, Action, PolicyRule, } from './types.js';
export type { Signer, PolicyEngine, AuditSink, PendingStore, RevocationList, SpendLedger, Enforcer, } from './interfaces.js';
export { CapabilitySchema, LeaseRequestSchema, LeaseSchema, PolicyRuleSchema, } from './schemas.js';
export type { CapabilityInput, LeaseRequestInput, LeaseInput, PolicyRuleInput, } from './schemas.js';
