/**
 * @gatewarden/gateway/scoring — snapshot attach + rescore.
 *
 * Given a connected MCP `Client`, this module:
 *   1. Introspects the downstream server (tools/list etc.)
 *   2. Runs the deterministic lint engine
 *   3. Assembles an immutable `GatewaySnapshot` via `scoreLintOnly`
 *
 * Design decisions:
 *   - **Keyless by default** (R2): `scoreLintOnly` never calls an LLM.
 *     Eval-only axes carry a `null` deterministic score — they are NOT
 *     inflated to 10 for axes lint cannot measure.
 *   - **Immutable output** (R3): every snapshot is `Object.freeze`'d at
 *     both the top level and the embedded `server` / `scorecard` objects.
 *     `rescore()` always returns a brand-new snapshot; the prior snapshot
 *     is never touched.
 *   - **No side-effects**: both functions are pure async — they read from
 *     the live client and return a fresh value.
 *
 * Eval path (opt-in, NOT required for v1): callers that want LLM-based
 * eval scores should use `@gatewarden/score`'s `score()` directly and
 * assemble their own snapshot. This module's scope is deterministic scoring.
 *
 * Owns: gateway-003 (Wave 1)
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { introspect, lint, scoreLintOnly } from '@gatewarden/score';
import type { TransportOptions } from '@gatewarden/score';
import type { GatewaySnapshot } from '../contract/index.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for `attachSnapshot` / `rescore`.
 *
 * All fields are optional — safe defaults are used when omitted.
 */
export interface ScoringOptions {
  /**
   * Transport kind used in `introspect()` error messages.
   * Defaults to `'stdio'` when not supplied.
   *
   * This does not affect scoring logic — it's metadata for diagnostics only.
   */
  transportKind?: TransportOptions['kind'];
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Run the full keyless scoring pipeline against a connected MCP `client`.
 *
 * Internal helper shared by `attachSnapshot` and `rescore`.
 */
async function runScoring(
  client: Client,
  transportKind: TransportOptions['kind']
): Promise<GatewaySnapshot> {
  // 1. Introspect the downstream server (tools, resources, prompts, meta).
  const { server, tools } = await introspect(client, transportKind);

  // 2. Run the deterministic lint engine against the tool list.
  const lintResult = lint(tools);

  // 3. Assemble a Scorecard using lint results only (no LLM, no API key).
  //    Eval-only axes will have score: null — correct and expected (R2).
  const scorecard = scoreLintOnly(server, lintResult);

  // 4. Build and freeze the snapshot (R3).
  //    Shallow-freeze the three top-level values for defence-in-depth;
  //    TypeScript's `readonly` properties enforce immutability at compile time.
  const snapshot: GatewaySnapshot = Object.freeze({
    server: Object.freeze({ ...server }),
    scorecard: Object.freeze({ ...scorecard }),
    attachedAt: new Date().toISOString(),
  });

  return snapshot;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attach to a downstream MCP server: introspect, lint, and score it.
 *
 * Requires a **connected** `Client` (i.e. `client.connect()` has already
 * succeeded). The client is not closed after scoring — ownership stays with
 * the caller (e.g. `GatewardenProxy` reuses the same client for enforcement).
 *
 * Returns an immutable `GatewaySnapshot` with:
 *   - `server`     — identity metadata from the handshake
 *   - `scorecard`  — deterministic lint scores (eval-only axes = null)
 *   - `attachedAt` — ISO 8601 timestamp of this scoring run
 *
 * @example
 * ```ts
 * const snapshot = await attachSnapshot(client, { transportKind: 'stdio' });
 * console.log(snapshot.scorecard.aggregate.lintScore); // e.g. 7.4
 * ```
 */
export async function attachSnapshot(
  client: Client,
  opts: ScoringOptions = {}
): Promise<GatewaySnapshot> {
  return runScoring(client, opts.transportKind ?? 'stdio');
}

/**
 * Re-score a downstream server, producing a **new** `GatewaySnapshot`.
 *
 * Semantically equivalent to `attachSnapshot` but named to convey intent:
 * "I already have a snapshot, give me a fresher one." The prior snapshot is
 * never read or mutated (R3).
 *
 * @example
 * ```ts
 * const snap1 = await attachSnapshot(client);
 * // ... time passes, server may have been updated ...
 * const snap2 = await rescore(client);   // brand-new snapshot
 * console.log(snap1 !== snap2);          // true — distinct frozen objects
 * ```
 */
export async function rescore(
  client: Client,
  opts: ScoringOptions = {}
): Promise<GatewaySnapshot> {
  return runScoring(client, opts.transportKind ?? 'stdio');
}
