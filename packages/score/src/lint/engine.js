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
import { AXIS_NAMES, DETERMINISTIC_AXES } from '../types.js';
import { ALL_RULES } from './rules.js';
// ---------------------------------------------------------------------------
// Per-axis metadata
// ---------------------------------------------------------------------------
/** RubricRefine provider-side category for each axis (arXiv 2605.09730). */
const AXIS_LINEAGE = {
    namespacing: 'tool-choice',
    'tool-selection-confusion': 'tool-choice',
    'param-strictness': 'call-signature',
    'output-leanness': 'output-contract',
    'error-helpfulness': 'provider-only',
};
/**
 * ADR-C weights:
 *  - output-leanness  x 1.5  (load-bearing per RubricRefine ablations)
 *  - param-strictness x 0.75 (capped — weak-model caveat)
 *  - all others       x 1.0
 */
const AXIS_WEIGHTS = {
    namespacing: 1.0,
    'tool-selection-confusion': 1.0,
    'param-strictness': 0.75,
    'output-leanness': 1.5,
    'error-helpfulness': 1.0,
};
/** Deduction per finding severity when computing a raw axis score. */
const SEVERITY_DEDUCTION = {
    error: 2,
    warning: 1,
    info: 0,
};
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/** Compute a raw 1–10 axis score from its findings. */
function axisScore(findings) {
    let deduction = 0;
    for (const f of findings) {
        deduction += SEVERITY_DEDUCTION[f.severity];
    }
    return Math.max(1, 10 - deduction);
}
/**
 * Compute the weighted aggregate lint score (1–10, one decimal place).
 *
 * Formula: Σ(score_i × weight_i) / Σ(weight_i)
 *
 * The result is rounded to one decimal place for stable serialisation.
 */
function weightedAggregate(scores) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const axis of AXIS_NAMES) {
        const { score } = scores[axis];
        // The deterministic badge only counts axes static lint can actually
        // assess; eval-only axes (null score) are excluded, not credited a 10.
        if (score === null || !DETERMINISTIC_AXES.has(axis))
            continue;
        const weight = AXIS_WEIGHTS[axis];
        weightedSum += score * weight;
        totalWeight += weight;
    }
    return totalWeight === 0 ? 0 : Math.round((weightedSum / totalWeight) * 10) / 10;
}
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
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
export function lint(tools) {
    // ── 1. Collect findings per tool ─────────────────────────────────────────
    //
    // Sort tool names for a stable iteration order (determinism guard).
    const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const toolFindingsMap = new Map();
    for (const tool of sortedTools) {
        toolFindingsMap.set(tool.name, []);
    }
    for (const rule of ALL_RULES) {
        for (const tool of sortedTools) {
            const found = rule.check(tool, sortedTools);
            const existing = toolFindingsMap.get(tool.name);
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            toolFindingsMap.set(tool.name, [...existing, ...found]);
        }
    }
    // ── 2. Build ToolReport[] ────────────────────────────────────────────────
    const toolReports = sortedTools.map(tool => ({
        name: tool.name,
        findings: toolFindingsMap.get(tool.name) ?? [],
    }));
    // ── 3. Aggregate findings by axis ────────────────────────────────────────
    const byAxis = {
        namespacing: [],
        'tool-selection-confusion': [],
        'param-strictness': [],
        'output-leanness': [],
        'error-helpfulness': [],
    };
    for (const report of toolReports) {
        for (const finding of report.findings) {
            byAxis[finding.axis].push(finding);
        }
    }
    // ── 4. Build AxisScore record ─────────────────────────────────────────────
    const axisScores = {};
    for (const axis of AXIS_NAMES) {
        const findings = byAxis[axis];
        const assessable = DETERMINISTIC_AXES.has(axis);
        axisScores[axis] = {
            // Eval-only axes are not statically gradable → null deterministic score
            // (populated later by --eval), so the badge is never inflated to a 10
            // for an axis static lint cannot actually measure.
            score: assessable ? axisScore(findings) : null,
            lineage: AXIS_LINEAGE[axis],
            kind: assessable ? 'deterministic' : 'eval',
            findings,
        };
    }
    // ── 5. Compute weighted aggregate ────────────────────────────────────────
    const weighted = weightedAggregate(axisScores);
    return {
        tools: toolReports,
        axisScores,
        aggregate: {
            lintScore: weighted, // deterministic headline (ADR-C)
            weighted,
        },
    };
}
