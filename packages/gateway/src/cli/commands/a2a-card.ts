/**
 * `gatewarden a2a-card <config>` — generate this gateway's own Agent Card
 * (ADR-H increment 3: the mechanical MCP→A2A discovery mapping).
 *
 * Connects to the configured stdio downstream, introspects its tools, and
 * emits the A2A v1.0 Agent Card advertising the governed tool surface as
 * skills — lease extension declared required:true. The card is what the
 * (future) upstream A2A face will serve at /.well-known/agent-card.json.
 *
 * Output: AgentCard JSON on stdout; --out writes agent-card.json.
 */

import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { introspect, scoreCardLintOnly, signAgentCard } from '@gatewarden/score';
import { loadConfig } from '../../config/index.js';
import { generateAgentCard } from '../../a2a/index.js';
import type { StdioDownstreamSpec } from '../../contract/index.js';

export interface A2aCardOptions {
  configPath: string;
  /** Card identity (defaults derive from the downstream server meta). */
  name?: string;
  description?: string;
  cardVersion?: string;
  /** The URL the upstream A2A face will serve on. */
  interfaceUrl: string;
  /** Directory to write agent-card.json into (omit to skip the artifact). */
  outDir?: string;
  /** Private JWK file (from a2a-keygen) — emit a SIGNED card. */
  signingKey?: string;
  /** jku URL to embed (defaults to interface origin + /.well-known/jwks.json). */
  jku?: string;
}

export async function cmdA2aCard(opts: A2aCardOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);

  const downstream = config.downstream;
  if (downstream.transport !== 'stdio') {
    console.error(
      `Error: a2a-card only supports stdio downstreams in v1 (got "${downstream.transport}")`,
    );
    process.exit(1);
  }

  const spec = downstream as StdioDownstreamSpec;
  const client = new Client(
    { name: 'gatewarden-card-generator', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env:
      spec.env !== undefined
        ? ({ ...process.env, ...spec.env } as Record<string, string>)
        : undefined,
  });

  try {
    await client.connect(transport);
    const { server, tools } = await introspect(client, 'stdio');

    let card = generateAgentCard(tools, config.toolActions, {
      name: opts.name ?? `${server.name} (via Gatewarden)`,
      description:
        opts.description ??
        `Lease-governed A2A face for the MCP server "${server.name}" — every delegated call is scored and enforced by Gatewarden.`,
      version: opts.cardVersion ?? server.version,
      interfaceUrl: opts.interfaceUrl,
    });

    // Sign when a key is provided (ADR-I re-signing key). jku defaults to the
    // interface origin's well-known JWKS (what a2a-serve publishes).
    if (opts.signingKey !== undefined) {
      const privateJwk = JSON.parse(readFileSync(resolve(opts.signingKey), 'utf8')) as Parameters<
        typeof signAgentCard
      >[1];
      const jku = opts.jku ?? `${new URL(opts.interfaceUrl).origin}/.well-known/jwks.json`;
      card = await signAgentCard(card, privateJwk, { jku });
    }

    // Dogfood gate: never emit a card the vendored scorer finds errors in.
    const scorecard = scoreCardLintOnly(card);
    const errors = Object.values(scorecard.axes).flatMap((a) =>
      a.findings.filter((f) => f.severity === 'error'),
    );
    if (errors.length > 0) {
      console.error('Error: generated card has error-severity findings (bug — please report):');
      for (const f of errors) console.error(`  • ${f.message}`);
      process.exit(1);
    }
    console.error(
      `gatewarden: generated card lints ${scorecard.aggregate.lintScore}/10 (${tools.length} tool(s) → ${card.skills?.length ?? 0} skill(s))${
        scorecard.signature.tier === 'structural' ? ' [SIGNED]' : ''
      }`,
    );

    console.log(JSON.stringify(card, null, 2));

    if (opts.outDir !== undefined) {
      const absOut = resolve(opts.outDir);
      await mkdir(absOut, { recursive: true });
      await writeFile(join(absOut, 'agent-card.json'), JSON.stringify(card, null, 2) + '\n', 'utf8');
      console.error(`gatewarden: agent-card.json written to ${absOut}/`);
    }
  } finally {
    await client.close();
  }
}
