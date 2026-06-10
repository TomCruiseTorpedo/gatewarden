/**
 * Axis metadata and ADR-C weight constants for the scorer (B-006).
 *
 * Centralises all per-axis configuration so scorer.ts and tests share a
 * single source of truth.
 *
 * Spec: Scorecard (specs/mcp-fit/spec.md §Requirement: Scorecard)
 * ADR: ADR-C (docs/adr/ADR-C-lint-rules-weights.md)
 */
import type { AxisName, LineageCategory } from '../types.js';
/** RubricRefine provider-side contract category for each axis (arXiv 2605.09730). */
export declare const AXIS_LINEAGE: Readonly<Record<AxisName, LineageCategory>>;
/**
 * ADR-C scoring weights:
 *  - output-leanness  × 1.5  (load-bearing per RubricRefine ablations)
 *  - param-strictness × 0.75 (capped — weak-model over-penalty caveat)
 *  - all others       × 1.0
 */
export declare const AXIS_WEIGHTS: Readonly<Record<AxisName, number>>;
/**
 * Compute a weighted aggregate score (1–10, one decimal place) from a
 * per-axis score record.
 *
 * Formula: Σ(score_i × weight_i) / Σ(weight_i)
 *
 * Rounds to one decimal for stable serialisation.
 */
export declare function weightedAggregate(scores: Readonly<Record<AxisName, number>>): number;
