/**
 * A2A attach — fetch, verify (structural tier), and score a remote agent's
 * card into an immutable A2aGatewaySnapshot (ADR-H; W4 increment 1).
 *
 * The card is fetched RAW and scored as served — deliberately NOT through the
 * SDK's AgentCardResolver, which auto-translates v0.3-shaped payloads: the
 * scorecard must reflect the document the agent actually publishes.
 *
 * Keyless, deterministic given the same card bytes (R2 semantics); frozen
 * output (R3 semantics); `fetchImpl` is injectable for tests.
 */

import { scoreCardLintOnly } from '@gatewarden/score';
import type { A2aDownstreamSpec, A2aGatewaySnapshot } from '../contract/index.js';

/** Minimal fetch signature (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Resolve the effective card URL: bare origins get the well-known path (§8.2). */
export function resolveCardUrl(raw: string): string {
  const parsed = new URL(raw); // throws on invalid — surfaced to the caller
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/.well-known/agent-card.json';
  }
  return parsed.toString();
}

/** Fetch the RAW card JSON (unknown — parsing defects are lint findings). */
export async function fetchAgentCardRaw(
  cardUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<unknown> {
  const target = resolveCardUrl(cardUrl);
  const response = await fetchImpl(target, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`fetching agent card failed: HTTP ${response.status} for ${target}`);
  }
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`agent card at ${target} is not valid JSON`);
  }
}

/**
 * Attach to an A2A downstream: fetch the card, score it (the structural
 * signature tier is embedded in the scorecard's SignatureReport), and freeze
 * the snapshot. No message traffic — attach is read-only (increment 1).
 */
export async function attachA2aSnapshot(
  spec: A2aDownstreamSpec,
  fetchImpl?: FetchLike,
): Promise<{ snapshot: A2aGatewaySnapshot; rawCard: unknown }> {
  const rawCard = await fetchAgentCardRaw(spec.cardUrl, fetchImpl);
  const cardScorecard = scoreCardLintOnly(rawCard);

  const snapshot: A2aGatewaySnapshot = Object.freeze({
    card: Object.freeze({ ...cardScorecard.card }),
    cardScorecard: Object.freeze({ ...cardScorecard }),
    attachedAt: new Date().toISOString(),
  });

  return { snapshot, rawCard };
}
