/**
 * mcp-fit scorer — B-006
 *
 * Combines deterministic lint sub-scores (B-002) with the stochastic
 * contract-rubric eval scores (rubric.ts) into a unified Scorecard.
 *
 * The deterministic lint aggregate is the badge-able headline.
 * The stochastic eval aggregate is reported separately with variance.
 * Both are written into compat.json via emitCompat (B-004).
 *
 * Spec: Scorecard (specs/mcp-fit/spec.md §Requirement: Scorecard)
 * ADR: ADR-C (weights), ADR-A (Scorecard shape)
 * Owns: src/score/
 */
import type { Scorecard, ServerMeta, TaskTrace } from '../types.js';
import type { LintResult } from '../lint/engine.js';
import type { RubricLoopOptions, RubricLoopResult } from './rubric.js';
import type { EvalTask } from '../eval/harness.js';
/**
 * Input to the scorer: lint result + optional eval traces + task corpus.
 * Both the server meta and tool reports come from the lint pipeline.
 */
export interface ScorerInput {
    /** Server metadata from introspection. */
    server: ServerMeta;
    /** Lint result from the static lint engine (B-002). */
    lintResult: LintResult;
    /**
     * Eval traces from the dynamic eval runner (B-005), paired with their
     * source tasks (needed for rubric generation). Omit to produce a
     * lint-only scorecard.
     */
    evalTraces?: Array<{
        task: EvalTask;
        trace: TaskTrace;
    }>;
    /** All tool names the server exposes (for rubric generation context). */
    toolNames?: string[];
    /** Options for the contract-rubric loop. Omit to use defaults. */
    rubricOptions?: RubricLoopOptions;
}
/**
 * Full scorer output — wraps the Scorecard (compat.json shape) plus any
 * per-task rubric details for downstream use.
 */
export interface ScorerResult {
    scorecard: Scorecard;
    /** Rubric loop results per task (empty when eval was not run). */
    rubricResults: RubricLoopResult[];
}
/**
 * Score an MCP server by combining deterministic lint results with an optional
 * stochastic contract-rubric eval loop.
 *
 * When `evalTraces` is omitted (or empty), the result is a lint-only scorecard:
 * all axis scores are deterministic and `evalScore` is absent from the aggregate.
 *
 * When `evalTraces` is provided, the contract-rubric loop is run for each
 * non-low-signal trace, and the result includes both lint and eval scores with
 * variance.
 *
 * @example
 * ```ts
 * // Lint-only scorecard (cheap, deterministic)
 * const { scorecard } = await score({ server, lintResult });
 *
 * // Full scorecard with eval
 * const { scorecard, rubricResults } = await score({
 *   server,
 *   lintResult,
 *   evalTraces: traces.map((trace, i) => ({ task: tasks[i], trace })),
 *   toolNames: serverToolNames,
 * });
 * ```
 */
export declare function score(input: ScorerInput): Promise<ScorerResult>;
/**
 * Produce a lint-only scorecard synchronously (no LLM calls, zero latency).
 *
 * Useful for CI gates, badges, and smoke tests where eval is not needed.
 * The returned scorecard has deterministic axis scores and no `evalScore`.
 */
export declare function scoreLintOnly(server: ServerMeta, lintResult: LintResult): Scorecard;
export { AXIS_LINEAGE, AXIS_WEIGHTS, weightedAggregate } from './axes.js';
