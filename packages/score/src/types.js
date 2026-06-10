/**
 * mcp-fit shared types — canonical contract (ADR-A).
 *
 * This is the single source of truth for all scorecard, finding, axis, trace,
 * MCP-wire, and introspection types. Every other bead imports from here and
 * never redefines these contracts. Changing this file is a new ADR.
 *
 * Spec: Machine-Readable Output (specs/mcp-fit/spec.md)
 * ADR: ADR-A (docs/adr/ADR-A-scorecard-schema.md)
 *
 * Integration note (B-009): Guzzle (B-004) is the canonical authority per ADR-A.
 * Extended with:
 *   - ruleId on Finding (lint rule traceability, optional)
 *   - McpParam, McpInputSchema, McpTool (B-002 lint input shapes)
 *   - ToolDef, ResourceDef, PromptDef, ServerIntrospection (B-001 connector)
 *   - DescriptionOverride (B-001 proxy / B-007 fix-mode)
 */
// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------
/** Bump this when the compat.json shape changes in a breaking way. */
export const COMPAT_SCHEMA_VERSION = '1.0.0';
/** Bump this when the evals.jsonl entry shape changes in a breaking way. */
export const EVALS_SCHEMA_VERSION = '1.0.0';
/** Every axis in a fixed order for iteration. */
export const AXIS_NAMES = [
    'namespacing',
    'tool-selection-confusion',
    'param-strictness',
    'output-leanness',
    'error-helpfulness',
];
/**
 * Axes the deterministic static lint can meaningfully assess. Axes NOT listed
 * here are eval-only: their quality is behavioural (output shape, error
 * helpfulness, tool-selection confusion at runtime) and cannot be graded
 * statically. Eval-only axes are excluded from the deterministic aggregate and
 * carry a null deterministic `score` until `--eval` populates them — so the
 * badge never claims a verdict it did not measure.
 */
export const DETERMINISTIC_AXES = new Set([
    'namespacing',
    'param-strictness',
]);
