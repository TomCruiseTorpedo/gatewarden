/**
 * DeclarativePolicyEngine — the v1 policy engine (ADR-C).
 *
 * Evaluates a LeaseRequest against a set of declarative allow-rules.
 * Deny-by-default: if no allow-rule matches a requested capability, the
 * entire request is denied with a reason.
 *
 * -- CEDAR EXTENSION SEAM (ADR-C) ----------------------------------------
 *
 * This class implements the `PolicyEngine` interface from the contract.
 * To swap in a Cedar-backed engine (or any other policy language):
 *
 *   1. Create a new class (e.g. `CedarPolicyEngine`) in a sibling module,
 *      e.g. `src/policy/cedar-engine.ts`.
 *   2. Implement `PolicyEngine.evaluate(request: LeaseRequest): Decision`.
 *   3. Pass the new engine to the broker's constructor instead of
 *      `DeclarativePolicyEngine`. No other code changes are required.
 *
 * Consumers (broker, CLI, enforce) depend only on the `PolicyEngine`
 * interface from `src/contract/`. The seam is the interface boundary.
 *
 * Mapping to Cedar concepts (for the future implementor):
 *   - `PolicyRule`          ≈ Cedar `permit` policy
 *   - `effect: 'veto-required'` ≈ Cedar `permit` with a side-effect flag
 *   - `agentId`             ≈ Cedar principal
 *   - `capabilityKind`      ≈ Cedar resource type / action group
 *   - `paths` / `endpoints` ≈ Cedar resource attributes
 *   - `maxCapMinor`         ≈ Cedar context condition
 *
 * -------------------------------------------------------------------------
 */
import type { Decision, LeaseRequest, PolicyEngine, PolicyRule } from '../contract/index.js';
/** Implements the `PolicyEngine` interface over declarative allow-rules. */
export declare class DeclarativePolicyEngine implements PolicyEngine {
    #private;
    /**
     * @param rules - Validated `PolicyRule[]`, typically produced by `loadRules`.
     */
    constructor(rules: readonly PolicyRule[]);
    /**
     * Evaluate the request against the loaded allow-rules.
     *
     * Algorithm:
     *   - For each requested capability, find the first matching rule.
     *   - If any capability has no matching rule → deny (deny-by-default).
     *   - If all capabilities match, the aggregate effect is:
     *       - `veto-required` if any matched rule yields `veto-required`.
     *       - `grant` if all matched rules yield `allow`.
     */
    evaluate(request: LeaseRequest): Decision;
}
