/**
 * HTTP mount for the A2A upstream server face (ADR-I integration step).
 *
 * Serves, on plain node:http (no framework dependency):
 *   GET  /.well-known/agent-card.json  → the generated Agent Card (§8.1)
 *   POST <a2aPath>                     → JSON-RPC via JsonRpcTransportHandler
 *
 * Wire behaviour:
 *   - `A2A-Extensions` request header → ServerCallContext.requestedExtensions;
 *     activated extensions are echoed on the response header (SHOULD).
 *   - `A2A-Version` request header → requestedVersion (SDK default '0.3' when
 *     absent, per §3.6.2); echoed on the response.
 *   - Pre-dispatch gate: a `message/send` that does not declare the lease
 *     extension is rejected with JSON-RPC `-32008` ExtensionSupportRequired-
 *     Error (§3.3.4) BEFORE the request handler runs — the executor's own
 *     stage-1 rejection remains as defence in depth.
 *   - Streaming responses (AsyncGenerator) are declined — the card advertises
 *     `streaming: false`; a stream request gets a JSON-RPC error.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AgentCard } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import {
  A2aLeaseBinding,
  declaresLeaseExtension,
  EXTENSION_SUPPORT_REQUIRED_ERROR,
  LEASE_EXT_URI,
  parseExtensionsHeader,
} from '@gatewarden/govern';
import type { GovernBundle } from '../config/index.js';
import { buildA2aServerFace, type DownstreamToolCaller } from './server-face.js';

// ---------------------------------------------------------------------------
// Options / result
// ---------------------------------------------------------------------------

export interface ServeA2aFaceOptions {
  card: AgentCard;
  bundle: GovernBundle;
  downstream: DownstreamToolCaller;
  /** Port to listen on (0 = ephemeral). Default 0. */
  port?: number;
  /** Bind host. Default 127.0.0.1 — expose deliberately, not by default. */
  host?: string;
  /** JSON-RPC endpoint path. Default '/a2a/v1'. */
  a2aPath?: string;
  /**
   * Public JWKS to serve at /.well-known/jwks.json — the verification keys
   * for a signed card (crypto-jku tier). Omit when the card is unsigned.
   */
  jwks?: { keys: unknown[] };
  binding?: A2aLeaseBinding;
  /**
   * Veto-pending predicate. Default: any pending broker request whose taskId
   * equals the contextId (the lease-per-task convention — profile §Context
   * binding pairs a delegation context with its lease task id).
   */
  hasPendingApproval?: (contextId: string) => boolean;
}

export interface RunningA2aFace {
  server: Server;
  /** Base URL actually bound, e.g. http://127.0.0.1:49321 */
  url: string;
  cardUrl: string;
  /** JWKS URL — present only when serving a signed card. */
  jwksUrl?: string | undefined;
  endpointUrl: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WELL_KNOWN_PATH = '/.well-known/agent-card.json';
const JWKS_PATH = '/.well-known/jwks.json';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function jsonRpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ---------------------------------------------------------------------------
// serveA2aFace
// ---------------------------------------------------------------------------

export async function serveA2aFace(options: ServeA2aFaceOptions): Promise<RunningA2aFace> {
  const a2aPath = options.a2aPath ?? '/a2a/v1';
  const host = options.host ?? '127.0.0.1';

  const hasPendingApproval =
    options.hasPendingApproval ??
    ((contextId: string) =>
      options.bundle.pendingStore.list().some(({ request }) => request.taskId === contextId));

  const { transport } = buildA2aServerFace({
    card: options.card,
    bundle: options.bundle,
    downstream: options.downstream,
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
    hasPendingApproval,
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, jsonRpcError(null, -32603, `internal error: ${message}`));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // ── Card availability (§8.1) ─────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === WELL_KNOWN_PATH) {
      sendJson(res, 200, options.card);
      return;
    }

    // ── Verification keys for the signed card (crypto-jku tier) ──────────
    if (req.method === 'GET' && url.pathname === JWKS_PATH) {
      if (options.jwks === undefined) {
        sendJson(res, 404, { error: 'this agent card is not signed' });
      } else {
        sendJson(res, 200, options.jwks);
      }
      return;
    }

    if (req.method !== 'POST' || url.pathname !== a2aPath) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // ── JSON-RPC endpoint ────────────────────────────────────────────────
    const requestedExtensions = parseExtensionsHeader(
      typeof req.headers['a2a-extensions'] === 'string' ? req.headers['a2a-extensions'] : null,
    );
    const requestedVersion =
      typeof req.headers['a2a-version'] === 'string' ? req.headers['a2a-version'] : undefined;

    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, jsonRpcError(null, -32700, 'parse error'));
      return;
    }

    // Pre-dispatch required-extension gate (§3.3.4): message sends from
    // extension-unaware clients are rejected at the protocol level. The v1
    // JSON-RPC method name is PascalCase `SendMessage` (the SDK's active
    // transport handler; the dotted `message/send` is the legacy handler).
    if (parsed['method'] === 'SendMessage' && !declaresLeaseExtension(requestedExtensions)) {
      sendJson(
        res,
        EXTENSION_SUPPORT_REQUIRED_ERROR.httpStatus,
        jsonRpcError(
          parsed['id'],
          EXTENSION_SUPPORT_REQUIRED_ERROR.jsonrpcCode,
          `${EXTENSION_SUPPORT_REQUIRED_ERROR.name}: this agent requires ${LEASE_EXT_URI} (declare it in A2A-Extensions)`,
        ),
        { 'a2a-version': requestedVersion ?? '1.0' },
      );
      return;
    }

    const context = new ServerCallContext({
      requestedExtensions,
      ...(requestedVersion !== undefined ? { requestedVersion } : {}),
    });

    const result = await transport.handle(parsed, context);

    // Streaming declined (the card advertises streaming: false).
    if (Symbol.asyncIterator in Object(result)) {
      sendJson(
        res,
        400,
        jsonRpcError(parsed['id'], -32004, 'streaming is not supported by this agent'),
        { 'a2a-version': requestedVersion ?? '1.0' },
      );
      return;
    }

    const activated = context.activatedExtensions ?? [];
    sendJson(res, 200, result, {
      'a2a-version': requestedVersion ?? '1.0',
      ...(activated.length > 0 ? { 'a2a-extensions': activated.join(', ') } : {}),
    });
  }

  await new Promise<void>((resolvePromise) => server.listen(options.port ?? 0, host, resolvePromise));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port ?? 0;
  const base = `http://${host}:${port}`;

  return {
    server,
    url: base,
    cardUrl: `${base}${WELL_KNOWN_PATH}`,
    jwksUrl: options.jwks !== undefined ? `${base}${JWKS_PATH}` : undefined,
    endpointUrl: `${base}${a2aPath}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((err) => (err ? reject(err) : resolvePromise())),
      ),
  };
}
