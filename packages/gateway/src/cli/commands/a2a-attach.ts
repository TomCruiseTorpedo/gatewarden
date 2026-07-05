/**
 * `gatewarden a2a-attach <cardUrl>` — read-only attach to a remote A2A agent
 * (ADR-H increment 1).
 *
 * Fetches the RAW Agent Card (bare origins get /.well-known/agent-card.json),
 * scores it with the vendored card scorer, optionally verifies signatures
 * cryptographically, and prints the frozen A2aGatewaySnapshot as JSON.
 * No message traffic — attach never sends.
 *
 * Output: A2aGatewaySnapshot as JSON; --out also writes card-compat.json.
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { emitCardCompat, keyStoreFromJwks, verifyCardSignature } from '@gatewarden/score';
import type { AgentCardJson } from '@gatewarden/score';
import { attachA2aSnapshot } from '../../a2a/index.js';

export interface A2aAttachOptions {
  cardUrl: string;
  /** Directory to write card-compat.json into (omit to skip the artifact). */
  outDir?: string;
  /** JWKS file for the crypto-pinned verification tier. */
  verifyKeys?: string;
  /** Opt into fetching the header jku JWKS (crypto-jku tier). */
  verifyJku?: boolean;
}

export async function cmdA2aAttach(opts: A2aAttachOptions): Promise<void> {
  const { snapshot, rawCard } = await attachA2aSnapshot({
    transport: 'a2a',
    cardUrl: opts.cardUrl,
  });

  let scorecard = snapshot.cardScorecard;

  // Crypto tiers on explicit request (mirrors mcp-fit card --verify-*).
  if (opts.verifyKeys !== undefined || opts.verifyJku === true) {
    const keyStore =
      opts.verifyKeys !== undefined
        ? keyStoreFromJwks(JSON.parse(readFileSync(resolve(opts.verifyKeys), 'utf8')))
        : undefined;
    const signature = await verifyCardSignature(rawCard as AgentCardJson, {
      ...(keyStore !== undefined ? { keyStore } : {}),
      fetchJku: opts.verifyJku === true,
    });
    scorecard = { ...scorecard, signature };
  }

  const result = { ...snapshot, cardScorecard: scorecard };
  console.log(JSON.stringify(result, null, 2));

  if (opts.outDir !== undefined) {
    const absOut = resolve(opts.outDir);
    await mkdir(absOut, { recursive: true });
    await emitCardCompat(scorecard, join(absOut, 'card-compat.json'));
    console.error(`gatewarden: card-compat.json written to ${absOut}/`);
  }
}
