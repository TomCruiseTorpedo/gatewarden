/**
 * `gatewarden a2a-serve <config>` — serve the governed MCP surface as a live
 * A2A agent (ADR-I, HTTP integration).
 *
 * Wires: config → govern bundle → stdio downstream MCP client → generated
 * Agent Card → serveA2aFace (well-known card + JSON-RPC endpoint with the
 * W3 ingress ladder). Runs until SIGINT/SIGTERM.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { introspect, jwksFromPrivateJwk, signAgentCard } from '@gatewarden/score';
import type { AgentCardJson } from '@gatewarden/score';
import { loadConfig, wireGovern } from '../../config/index.js';
import { generateAgentCard, serveA2aFace } from '../../a2a/index.js';
import type { StdioDownstreamSpec } from '../../contract/index.js';
import type { AgentCard } from '@a2a-js/sdk';

export interface A2aServeOptions {
  configPath: string;
  /** Public URL clients should use (goes on the card). */
  interfaceUrl: string;
  port?: number;
  host?: string;
  name?: string;
  description?: string;
  cardVersion?: string;
  /** Private JWK file (from a2a-keygen) — serve a SIGNED card + JWKS. */
  signingKey?: string;
}


export async function cmdA2aServe(opts: A2aServeOptions): Promise<void> {
  const config = await loadConfig(opts.configPath);

  const downstream = config.downstream;
  if (downstream.transport !== 'stdio') {
    console.error(
      `Error: a2a-serve only supports stdio downstreams in v1 (got "${downstream.transport}")`,
    );
    process.exit(1);
  }

  const spec = downstream as StdioDownstreamSpec;
  const client = new Client(
    { name: 'gatewarden-a2a-face', version: '1.0.0' },
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

  await client.connect(transport);
  const { server, tools } = await introspect(client, 'stdio');

  const bundle = wireGovern(config);

  let card = generateAgentCard(tools, config.toolActions, {
    name: opts.name ?? `${server.name} (via Gatewarden)`,
    description:
      opts.description ??
      `Lease-governed A2A face for the MCP server "${server.name}" — every delegated call is scored and enforced by Gatewarden.`,
    version: opts.cardVersion ?? server.version,
    interfaceUrl: opts.interfaceUrl,
  }) as AgentCardJson;

  // Sign the served card when a key is provided (ADR-I: the re-signing key).
  // jku points at the PUBLIC origin's well-known JWKS, which we also serve.
  let jwks: { keys: unknown[] } | undefined;
  if (opts.signingKey !== undefined) {
    const privateJwk = JSON.parse(
      readFileSync(resolve(opts.signingKey), 'utf8'),
    ) as Parameters<typeof signAgentCard>[1];
    jwks = jwksFromPrivateJwk(privateJwk);
    const publicOrigin = new URL(opts.interfaceUrl).origin;
    card = await signAgentCard(card, privateJwk, {
      jku: `${publicOrigin}/.well-known/jwks.json`,
    });
  }

  const face = await serveA2aFace({
    card: card as unknown as AgentCard,
    bundle,
    downstream: {
      callTool: (name, args) => client.callTool({ name, arguments: args }),
    },
    ...(jwks !== undefined ? { jwks } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
  });

  console.error(`gatewarden a2a-serve: agent card   ${face.cardUrl}${opts.signingKey !== undefined ? '  (SIGNED)' : ''}`);
  if (face.jwksUrl !== undefined) {
    console.error(`gatewarden a2a-serve: JWKS         ${face.jwksUrl}`);
  }
  console.error(`gatewarden a2a-serve: JSON-RPC     ${face.endpointUrl}`);
  console.error(
    `gatewarden a2a-serve: fronting "${server.name}" (${tools.length} tool(s)); lease extension required`,
  );

  const shutdown = async (): Promise<void> => {
    console.error('gatewarden a2a-serve: shutting down');
    await face.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
