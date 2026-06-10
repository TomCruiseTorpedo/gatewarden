/**
 * mcp-fit lint rules — B-002
 *
 * Each rule is deterministic: given the same tool list it always produces the
 * same findings. Rules are tagged to the scorecard axis they affect (ADR-C).
 *
 * Rule shape:
 *   id       — stable kebab-case identifier used in Finding.ruleId
 *   axis     — which scorecard axis this rule feeds
 *   check()  — receives the target tool + all tools; returns 0-N findings
 */
import type { AxisName, Finding, McpTool } from '../types.js';
export interface Rule {
    readonly id: string;
    readonly axis: AxisName;
    readonly description: string;
    check(tool: McpTool, allTools: readonly McpTool[]): Finding[];
}
export declare const ALL_RULES: readonly Rule[];
