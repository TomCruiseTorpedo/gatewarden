/**
 * Hash utilities for the audit module.
 *
 * Provides deterministic SHA-256 hashing for building the audit hash chain.
 * Every audit event carries `prevHash` (the hash of the previous event) and
 * `hash` (the hash of this event including prevHash), forming a tamper-evident chain.
 */
/**
 * Fields that participate in the event hash.
 * The `hash` field itself is intentionally excluded — that's what we're computing.
 */
export interface HashableEventFields {
    type: string;
    at: string;
    leaseId?: string | undefined;
    requestId?: string | undefined;
    detail: Record<string, unknown>;
    prevHash: string;
}
/**
 * Compute the SHA-256 hex digest of a UTF-8 string.
 */
export declare function sha256hex(input: string): string;
/**
 * Produce the canonical JSON string of an event for hashing.
 *
 * Fields are sorted alphabetically to ensure determinism regardless of
 * the order in which properties were set on the input object.
 * Optional fields are omitted when undefined to keep the canonical form stable.
 * The `hash` field is never included — it's the output, not the input.
 */
export declare function eventCanonical(event: HashableEventFields): string;
/**
 * Compute the hash for an event's hashable fields.
 */
export declare function computeEventHash(event: HashableEventFields): string;
