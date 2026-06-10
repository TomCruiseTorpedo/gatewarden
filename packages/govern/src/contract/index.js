/**
 * Contract barrel — re-exports all types, interfaces, and schemas.
 *
 * Consumers import from here:
 *   import type { Lease, Signer } from 'leasebroker/contract';
 *   import { LeaseSchema, CapabilitySchema } from 'leasebroker/contract';
 */
export { 
// Zod schemas
CapabilitySchema, LeaseRequestSchema, LeaseSchema, PolicyRuleSchema, } from './schemas.js';
