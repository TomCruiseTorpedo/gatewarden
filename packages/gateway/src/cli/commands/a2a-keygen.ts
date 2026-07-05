/**
 * `gatewarden a2a-keygen` — mint the gateway's card-signing key pair.
 *
 * Writes two files into --out:
 *   card-signing-key.jwk.json  the PRIVATE JWK (mode 0600 — keep secret;
 *                              pass to a2a-card/a2a-serve via --signing-key)
 *   jwks.json                  the public JWKS (served at
 *                              /.well-known/jwks.json by a2a-serve, or pin it)
 *
 * Rotation = mint a new pair with a new --kid and re-sign; the signer
 * REPLACES prior signatures by design (re-signing semantics, ADR-H).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { generateCardSigningKeys, type CardSigningAlg } from '@gatewarden/score';

export interface A2aKeygenOptions {
  outDir: string;
  alg?: CardSigningAlg;
  kid?: string;
}

export async function cmdA2aKeygen(opts: A2aKeygenOptions): Promise<void> {
  const keys = await generateCardSigningKeys({
    ...(opts.alg !== undefined ? { alg: opts.alg } : {}),
    ...(opts.kid !== undefined ? { kid: opts.kid } : {}),
  });

  const absOut = resolve(opts.outDir);
  await mkdir(absOut, { recursive: true });

  const privatePath = join(absOut, 'card-signing-key.jwk.json');
  const jwksPath = join(absOut, 'jwks.json');

  await writeFile(privatePath, JSON.stringify(keys.privateJwk, null, 2) + '\n', { mode: 0o600 });
  await chmod(privatePath, 0o600); // belt and braces if the file pre-existed
  await writeFile(jwksPath, JSON.stringify(keys.jwks, null, 2) + '\n', 'utf8');

  console.error(`gatewarden a2a-keygen: kid=${String(keys.privateJwk.kid)} alg=${String(keys.privateJwk.alg)}`);
  console.error(`  private key  ${privatePath}  (mode 0600 — do NOT commit)`);
  console.error(`  public JWKS  ${jwksPath}`);
}
