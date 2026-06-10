/**
 * Contract-rubric instance-specific rubric loop (B-006).
 *
 * Algorithm (from RubricRefine §4, adapted to provider-side contracts):
 *   Phase 1 — Rubric generation:
 *     A verifier LLM generates a task- and registry-specific rubric
 *     (ordered list of criteria) from the task description + tool list.
 *   Phase 2 — Scoring loop:
 *     The judge scores the agent's trace against the rubric (1–10).
 *     Early-stops when score == 10 (perfect) or patience exhausted.
 *   Variance:
 *     Run the scoring loop N times on a sample; report mean ± stdev.
 *     Calibrated for top-bin reliability (score ≥ 8) only.
 *
 * Spec: Scorecard — stochastic eval score with variance
 * ADR: ADR-B (harness interface), ADR-C (weights)
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EvalTask } from '../eval/harness.js';
import type { TaskTrace } from '../types.js';
/** A single rubric criterion. */
export interface RubricCriterion {
    id: string;
    description: string;
    /** Weight 1–3; higher = more important. */
    weight: number;
}
/** A generated rubric for a specific task + server context. */
export interface TaskRubric {
    taskId: string;
    criteria: RubricCriterion[];
}
/** Result of a single judge scoring pass. */
export interface JudgeScore {
    score: number;
    round: number;
    rationale: string;
}
/** Aggregated result after N scoring rounds. */
export interface RubricLoopResult {
    /** Ordinal score 1–10 (mean across rounds). */
    score: number;
    /** Round at which scoring completed (early-stop or patience exhausted). */
    round: number;
    /** Mean score across all rounds. */
    mean: number;
    /** Standard deviation across all rounds. */
    stdev: number;
    /** Number of rounds run. */
    n: number;
}
/** Options for the rubric loop. */
export interface RubricLoopOptions {
    /** Pre-built Anthropic client (useful for tests). */
    client?: Anthropic;
    /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
    apiKey?: string;
    /**
     * Model for rubric generation and scoring.
     * Defaults to claude-3-5-haiku-20241022 (fast + cheap).
     */
    model?: string;
    /**
     * Maximum number of scoring rounds before taking the average.
     * Early-stop at score == 10 or patience exhausted. Default 3.
     */
    maxRounds?: number;
    /**
     * Patience: max rounds without a score increase before stopping.
     * Default 2.
     */
    patience?: number;
    /** Max tokens per LLM call. Default 512. */
    maxTokens?: number;
}
/**
 * Generate an instance-specific rubric for the given task + server tool list.
 *
 * The generated rubric is a short ordered list of weighted criteria tailored
 * to what the task requires and what the server provides.
 *
 * @param client  Anthropic client.
 * @param model   Model identifier.
 * @param task    Eval task.
 * @param toolNames  Names of tools the server exposes.
 * @param maxTokens  Token budget for the generation call.
 */
export declare function generateRubric(client: Anthropic, model: string, task: EvalTask, toolNames: readonly string[], maxTokens: number): Promise<TaskRubric>;
/**
 * Score a TaskTrace against a TaskRubric in a single round.
 *
 * @param client     Anthropic client.
 * @param model      Model identifier.
 * @param rubric     Generated rubric.
 * @param trace      The agent's execution trace.
 * @param round      Current round number (for bookkeeping).
 * @param maxTokens  Token budget.
 */
export declare function scoreTrace(client: Anthropic, model: string, rubric: TaskRubric, trace: TaskTrace, round: number, maxTokens: number): Promise<JudgeScore>;
/**
 * Run the full contract-rubric loop for a single task trace.
 *
 * 1. Generate an instance-specific rubric (once per task).
 * 2. Score the trace up to `maxRounds` times (early-stop at 10 or patience).
 * 3. Return aggregated result with mean, stdev, and round count.
 *
 * @param task        The eval task.
 * @param trace       The agent's execution trace.
 * @param toolNames   Tool names the server exposes (for rubric generation).
 * @param options     Loop configuration.
 */
export declare function runRubricLoop(task: EvalTask, trace: TaskTrace, toolNames: readonly string[], options?: RubricLoopOptions): Promise<RubricLoopResult>;
