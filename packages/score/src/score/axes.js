/**
 * Axis metadata and ADR-C weight constants for the scorer (B-006).
 *
 * Centralises all per-axis configuration so scorer.ts and tests share a
 * single source of truth.
 *
 * Spec: Scorecard (specs/mcp-fit/spec.md §Requirement: Scorecard)
 * ADR: ADR-C (docs/adr/ADR-C-lint-rules-weights.md)
 */
import { AXIS_NAMES } from '../types.js';
// ---------------------------------------------------------------------------
// Per-axis metadata
// ---------------------------------------------------------------------------
/** RubricRefine provider-side contract category for each axis (arXiv 2605.09730). */
export const AXIS_LINEAGE = {
    namespacing: 'tool-choice',
    'tool-selection-confusion': 'tool-choice',
    'param-strictness': 'call-signature',
    'output-leanness': 'output-contract',
    'error-helpfulness': 'provider-only',
};
/**
 * ADR-C scoring weights:
 *  - output-leanness  × 1.5  (load-bearing per RubricRefine ablations)
 *  - param-strictness × 0.75 (capped — weak-model over-penalty caveat)
 *  - all others       × 1.0
 */
export const AXIS_WEIGHTS = {
    namespacing: 1.0,
    'tool-selection-confusion': 1.0,
    'param-strictness': 0.75,
    'output-leanness': 1.5,
    'error-helpfulness': 1.0,
};
/**
 * Compute a weighted aggregate score (1–10, one decimal place) from a
 * per-axis score record.
 *
 * Formula: Σ(score_i × weight_i) / Σ(weight_i)
 *
 * Rounds to one decimal for stable serialisation.
 */
export function weightedAggregate(scores) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const axis of AXIS_NAMES) {
        weightedSum += scores[axis] * AXIS_WEIGHTS[axis];
        totalWeight += AXIS_WEIGHTS[axis];
    }
    return Math.round((weightedSum / totalWeight) * 10) / 10;
}
