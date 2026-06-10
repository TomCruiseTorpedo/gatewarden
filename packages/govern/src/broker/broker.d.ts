/**
 * Broker — issuance orchestration (policy + sign + audit + veto).
 *
 * Orchestrates the lease issuance lifecycle:
 *   1. Validate incoming LeaseRequest via zod (trust-boundary enforcement)
 *   2. Audit the incoming request
 *   3. Evaluate policy (PolicyEngine.evaluate)
 *   4. Audit the decision
 *   5a. grant   → issue lease via Signer.issue, audit issuance, return token
 *   5b. veto-required → PendingStore.put (NO lease issued), return pending reqId
 *   5c. deny    → audit denial, return denial reason
 *
 * approve(reqId) retrieves the pending request and issues under normal grant rules.
 * deny(reqId) removes from pending and audits the denial; no lease is issued.
 *
 * Design constraints (from the attached args and plan):
 * - Depends on contract INTERFACES via constructor injection; never on concrete classes.
 * - Issued scope is always a subset of (or equal to) the requested scope.
 * - The `kid` for issued leases is a constructor parameter; it must match the
 *   Signer's active signing key so verification succeeds.
 */
import type { AuditSink, Lease, LeaseRequest, PolicyEngine, PendingStore, Signer } from '../contract/index.js';
/** A lease was successfully issued. */
export type GrantedResult = {
    type: 'granted';
    /** PASETO v4.public token — the wire form of the lease. */
    token: string;
    /** The issued Lease (structured claims). */
    lease: Lease;
};
/**
 * The policy required human veto approval before a lease can be issued.
 * The caller should surface `reqId` to the operator (e.g. via CLI).
 */
export type PendingResult = {
    type: 'pending';
    /** ID of the stored pending request. Use with `approve`/`deny`. */
    reqId: string;
};
/** The request was denied (no lease issued). */
export type DeniedResult = {
    type: 'denied';
    reason: string;
};
/** Union of all possible outcomes from `Broker.request` or `Broker.approve`. */
export type IssueResult = GrantedResult | PendingResult | DeniedResult;
/**
 * Issuance orchestrator for the leasebroker.
 *
 * All dependencies are injected as contract interfaces — never as concrete
 * implementations — so each component is swappable without changing this class.
 */
export declare class Broker {
    #private;
    /**
     * @param policy  Evaluates lease requests against policy rules.
     * @param signer  Signs leases into PASETO tokens and verifies them.
     * @param audit   Append-only, hash-chained audit log.
     * @param pending Storage for veto-required requests awaiting human review.
     * @param kid     Key ID for issued leases (must match the Signer's active kid).
     */
    constructor(policy: PolicyEngine, signer: Signer, audit: AuditSink, pending: PendingStore, kid: string);
    /**
     * Process a lease request.
     *
     * Validates, evaluates, and dispatches to grant / veto / deny.
     * Audit events are appended for every request and every decision.
     *
     * @returns `GrantedResult` — lease issued and token returned
     * @returns `PendingResult` — veto required; awaiting human approval
     * @returns `DeniedResult`  — request was denied by policy or validation
     */
    request(req: LeaseRequest): IssueResult;
    /**
     * Approve a pending (veto-required) request.
     *
     * The human operator approved the veto. The request is removed from the
     * PendingStore and a lease is issued under the same grant rules as a
     * normal approval (same scope, same duration math, same audit trail).
     *
     * @returns `GrantedResult` — lease issued
     * @returns `DeniedResult`  — reqId not found in pending
     */
    approve(reqId: string): IssueResult;
    /**
     * Deny a pending (veto-required) request.
     *
     * Removes from pending and appends a denial audit event. No lease is issued.
     * No-op if the reqId is not found.
     */
    deny(reqId: string): void;
}
