/**
 * LeaseEnforcer — implements the Enforcer contract (ADR-B).
 *
 * Evaluation order (deny on first failure):
 *   1. Verify token signature (Signer)
 *   2. Check not expired
 *   3. Check not revoked (RevocationList)
 *   4. Check action is within scope (path globs / endpoint allow-list)
 *   5. Accrue spend (SpendLedger) — only for spend actions
 *
 * Depends on the audit lane's InMemorySpendLedger (concrete) to call
 * setCap lazily when a spend-capable lease is first encountered.  The
 * enforce lane explicitly depends on the audit lane (see plan.md module map).
 */
import type { Action, Enforcer, RevocationList, Signer, VerifyResult } from '../contract/index.js';
import type { InMemorySpendLedger } from '../audit/index.js';
export declare class LeaseEnforcer implements Enforcer {
    private readonly signer;
    private readonly revocationList;
    private readonly spendLedger;
    /**
     * Set of leaseIds whose spend caps have already been registered with the
     * ledger.  Caps are registered lazily on the first spend-action check.
     */
    private readonly registeredCaps;
    constructor(signer: Signer, revocationList: RevocationList, spendLedger: InMemorySpendLedger);
    /**
     * Check whether the presented token authorises the given action.
     *
     * @returns `{ ok: true }` if permitted, `{ ok: false, reason }` if denied.
     */
    check(token: string, action: Action): VerifyResult;
}
