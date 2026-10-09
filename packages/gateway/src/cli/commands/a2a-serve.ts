/**
 * `gatewarden a2a-serve <config>` — serve the governed MCP surface as a live
 * A2A agent (ADR-I, HTTP integration).
 *
 * Wires: config → govern bundle → stdio downstream MCP client → generated
 * Agent Card → serveA2aFace (well-known card + JSON-RPC endpoint with the
 * W3 ingress ladder). Runs until SIGINT/SIGTERM.
 *
 * The govern bundle is wired from the persisted CLI state (`--state-dir`,
 * `GATEWARDEN_STATE_DIR`, or `.gatewarden/`), the same directory
 * `gatewarden request`, `revoke` and `approve` use. Without that the face
 * signed and verified with a key generated for this process alone, so no lease
 * the CLI issued could be accepted, and a `revoke` could not reach it. See
 * `openServeSession` for what is saved on shutdown.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { introspect, jwksFromPrivateJwk, signAgentCard } from '@gatewarden/score';
import type { AgentCardJson } from '@gatewarden/score';
import { loadConfig, wireGovern } from '../../config/index.js';
import { loadPendingStore, openServeSession, resolveStateDir } from '../state.js';
import { generateAgentCard, PerMessageBinding, serveA2aFace } from '../../a2a/index.js';
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
  /** State directory holding the signing key and stores. Defaults per `resolveStateDir`. */
  stateDir?: string;
  /**
   * Require a lease token on every message instead of letting a context bind
   * once and omit it afterwards (see `PerMessageBinding`).
   */
  requireTokenPerMessage?: boolean;
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

  const stateDir = resolveStateDir(opts.stateDir);
  const session = openServeSession(stateDir);
  // The session save is refused on a tampered log, which would lose this run's
  // audit events. Fail closed at startup instead, before spawning the downstream.
  if (session.state.auditIntegrity === 'tampered') {
    console.error(
      'refusing to start: audit log fails stored hash-chain verification — possible tampering. ' +
        'Archive the audit log manually to resume with a fresh chain.',
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

  const bundle = wireGovern(config, session.state);

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
    // Read pending.json as it is now: `gatewarden request` adds veto-pending
    // requests, and `approve` / `deny` resolve them, from other processes while
    // this one runs. The bundle's in-memory store only knows the startup view.
    hasPendingApproval: (contextId) =>
      loadPendingStore(stateDir)
        .list()
        .some(({ request }) => request.taskId === contextId),
    ...(opts.requireTokenPerMessage === true ? { binding: new PerMessageBinding() } : {}),
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
  // Say which posture is active. Under the default, a context that has presented
  // a valid token is bound, and a later message on that contextId may omit the
  // token, so the contextId is a bearer; an operator should not have to read the
  // profile to learn that.
  console.error(
    opts.requireTokenPerMessage === true
      ? 'gatewarden a2a-serve: token required on EVERY message (--require-token-per-message)'
      : 'gatewarden a2a-serve: context binding ON — once a context has presented a valid token, ' +
          'later messages on that contextId may omit it, so a bound contextId acts as a bearer. ' +
          'Use --require-token-per-message to require the token every time.',
  );

  const shutdown = async (): Promise<void> => {
    console.error('gatewarden a2a-serve: shutting down');
    try {
      session.save();
    } catch (err) {
      console.error(`gatewarden a2a-serve: ${(err as Error).message}`);
    }
    await face.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
