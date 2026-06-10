/**
 * mcp-fit static lint engine — B-002
 *
 * Runs all lint rules against a list of MCP tools and produces:
 *  - per-tool findings
 *  - per-axis scores (deterministic, 1–10)
 *  - a weighted aggregate lint score (the badge-able headline, ADR-C)
 *
 * Determinism guarantee: given the same `McpTool[]` input, `lint()` always
 * returns structurally-identical output. No randomness, no I/O, no global
 * mutable state.
 */
import type { AxisName, AxisScore, McpTool, ToolReport } from '../types.js';
/** Full result returned by lint(). */
export interface LintResult {
    /** Per-tool findings (sorted by tool name for determinism). */
    tools: ToolReport[];
    /** Per-axis deterministic scores. */
    axisScores: Readonly<Record<AxisName, AxisScore>>;
    /** Weighted aggregate. */
    aggregate: {
        lintScore: number;
        weighted: number;
    };
}
/**
 * Run the static lint engine against `tools`.
 *
 * @param tools  Array of MCP tool definitions (readonly — never mutated).
 * @returns      LintResult with deterministic per-tool and per-axis findings.
 *
 * @example
 * ```ts
 * import { lint } from './src/lint/engine.js';
 * const result = lint(server.tools);
 * console.log(result.aggregate.lintScore); // e.g. 7.4
 * ```
 */
export declare function lint(tools: readonly McpTool[]): LintResult;
