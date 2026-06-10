/**
 * In-memory, append-only, hash-chained audit log.
 *
 * Implements the AuditSink interface from src/contract.
 *
 * Design:
 * - Every appended event has its `prevHash` and `hash` computed and stored.
 * - `read()` re-verifies the full hash chain before returning events.
 *   Any insertion, deletion, or mutation of stored events causes read() to throw.
 * - The caller-provided `prevHash` / `hash` values are always overwritten by
 *   the implementation to ensure chain integrity.
 */
import type { AuditEvent, AuditSink } from '../contract/index.js';
export declare class InMemoryAuditSink implements AuditSink {
    private readonly events;
    /**
     * Append a new event to the log.
     *
     * The implementation always computes `prevHash` and `hash`:
     * - `prevHash` = hash of the last stored event, or "" for the first event.
     * - `hash` = SHA-256 of the canonical event representation (excluding `hash`).
     *
     * Any caller-supplied `prevHash` / `hash` values are overwritten.
     */
    append(event: AuditEvent): void;
    /**
     * Read all events in append order.
     *
     * Verifies the full hash chain before returning. Throws if any event has
     * been inserted, removed, or its content modified since it was appended.
     *
     * @throws {Error} if tamper evidence is detected.
     */
    read(): AuditEvent[];
}
