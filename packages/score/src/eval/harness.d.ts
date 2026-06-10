/**
 * Eval harness — Harness interface + ClaudeHarness implementation (ADR-B).
 *
 * ADR-B contract:
 *   Harness.runTask(task, toolset, sandbox): Promise<TaskTrace>
 *   - toolset: tool definitions from the re-presentation proxy
 *   - sandbox: enforces capability restrictions during execution
 *   - returns a normalised TaskTrace (chosen tools, token cost, pass/fail,
 *     provenance events)
 *
 * No Claude-specific calls leak outside this file. The ClaudeHarness is the
 * sole v1 implementation; v1.1 adds an ACP adapter without changing the
 * interface.
 *
 * Spec: Dynamic Eval (specs/mcp-fit/spec.md)
 * ADR: ADR-B (docs/adr/ADR-B-harness-interface.md)
 */
import Anthropic from '@anthropic-ai/sdk';
import type { TaskTrace, ProvenanceEvent, ProvenanceEventType } from '../types.js';
import type { Toolset } from './sandbox.js';
import type { Sandbox } from './sandbox.js';
/**
 * A task from the eval corpus.
 * Loaded from fixtures/tasks/tasks.json.
 */
export interface EvalTask {
    taskId: string;
    description: string;
    multiStep: boolean;
    lowSignal: boolean;
    /** Tools expected to be called (used for pass/fail and rubric scoring). */
    expectedTools?: string[];
    /** Human-readable criteria the judge uses for rubric scoring. */
    verificationCriteria?: string;
    /** Optional step decomposition for multi-step tasks. */
    steps?: Array<{
        stepId: string;
        description: string;
        expectedTool: string;
    }>;
}
/**
 * The pluggable harness interface.
 *
 * v1 implementation: ClaudeHarness (this file).
 * v1.1 target: a single ACP adapter for cross-harness coverage.
 */
export interface Harness {
    runTask(task: EvalTask, toolset: Toolset, sandbox: Sandbox): Promise<TaskTrace>;
}
/**
 * Classify the provenance of a single tool argument.
 *
 * Algorithm (v1 heuristic):
 *   1. If the value (as a string) appears verbatim in the task description → 'literal'.
 *   2. If the value appears in any prior tool return (serialised) → 'traced'.
 *   3. Otherwise → 'fabricated'.
 *
 * String values are compared directly; other types are JSON-serialised.
 */
export declare function classifyProvenance(value: unknown, taskDescription: string, priorReturns: unknown[]): ProvenanceEventType;
/**
 * Analyse all arguments of a tool call and emit ProvenanceEvents.
 *
 * Called immediately before the tool result is added to priorReturns so that
 * the current call's own output is not treated as a source for its own inputs.
 */
export declare function analyzeToolCallProvenance(toolName: string, args: Record<string, unknown>, taskDescription: string, priorReturns: unknown[]): ProvenanceEvent[];
/**
 * Compute a preliminary rubric score based on tool selection accuracy.
 *
 * B-006 will replace/augment this with a full LLM-judge contract-rubric loop.
 * This function provides a cheap, deterministic score that validates the shape
 * of the rubric output until B-006 lands.
 *
 * Scoring logic:
 *   - All expected tools called → 9
 *   - Some expected tools called → proportional (4–8)
 *   - No expected tools called → 2
 *   - No expected tools defined → 5 (unknown quality)
 */
export declare function computePreliminaryRubric(task: EvalTask, chosenTools: string[]): {
    score: number;
    round: number;
};
/** Options for constructing a ClaudeHarness. */
export interface ClaudeHarnessOptions {
    /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /** Inject a pre-built Anthropic client (useful for tests). */
    client?: Anthropic;
    /** Model to use. Defaults to claude-3-5-haiku-20241022 (fast + cheap). */
    model?: string;
    /** Maximum conversation turns before giving up. Default 10. */
    maxTurns?: number;
    /** Max tokens per API call. Default 1024. */
    maxTokens?: number;
}
/**
 * v1 harness implementation using the Claude Anthropic SDK.
 *
 * All Claude-specific logic is contained here (ADR-B). Tests inject a mock
 * client via `options.client` to avoid live API calls.
 */
export declare class ClaudeHarness implements Harness {
    private readonly client;
    private readonly model;
    private readonly maxTurns;
    private readonly maxTokens;
    constructor(options?: ClaudeHarnessOptions);
    /**
     * Run a single eval task against the sandbox and return a TaskTrace.
     *
     * The harness:
     *   1. Builds a Claude `tools` array from `sandbox.listTools()`.
     *   2. Drives a conversation loop: user message → tool_use → tool_result → ...
     *   3. Tracks chosen tools, token cost, and provenance events.
     *   4. Computes a preliminary rubric score.
     */
    runTask(task: EvalTask, toolset: Toolset, sandbox: Sandbox): Promise<TaskTrace>;
}
