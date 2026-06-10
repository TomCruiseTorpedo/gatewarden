/**
 * PasetoV4PublicSigner — implements the Signer contract using PASETO v4.public.
 *
 * See ADR-A for the design rationale (Ed25519 on @noble/ed25519, not the stale
 * `paseto` npm package).
 *
 * Key rotation:
 *   - The active signing key is used to issue tokens; its kid is embedded in the
 *     Lease payload (the `kid` field is part of the Lease type).
 *   - The keyring holds all trusted public keys keyed by kid, enabling the
 *     verifier to validate tokens signed under any previous rotation key.
 *
 * Usage:
 *   const kp = generateKeyPair('k1');
 *   const signer = new PasetoV4PublicSigner(kp);
 *   const token = signer.issue(lease);
 *   const result = signer.verify(token);
 */
import type { Lease, Signer, VerifyResult } from '../contract/index.js';
import type { KeyPair } from './keygen.js';
/**
 * PASETO v4.public implementation of the `Signer` contract.
 *
 * - `issue(lease)` → signs lease JSON as PASETO v4.public token (Ed25519)
 * - `verify(token)` → verifies signature and decodes lease; does NOT check expiry
 *
 * The kid in `lease.kid` is used to select the correct public key during
 * verification, supporting key rotation without token invalidation.
 */
export declare class PasetoV4PublicSigner implements Signer {
    /** Active signing key pair. */
    private readonly signingKey;
    /**
     * Map of kid → public key for verification.
     * Always includes the current signing key; may include rotated-out keys.
     */
    private readonly keyring;
    /**
     * @param signingKey        Active key pair used to sign new tokens.
     * @param additionalKeys    Optional retired public keys for verifying old tokens.
     */
    constructor(signingKey: KeyPair, additionalKeys?: ReadonlyArray<{
        kid: string;
        publicKey: Uint8Array;
    }>);
    /**
     * Issue a PASETO v4.public token encoding the given lease.
     *
     * The lease is JSON-serialised and signed with the active signing key.
     * The lease's `kid` field (which should match this signer's active kid)
     * is embedded in the payload claims — no separate footer is used.
     *
     * @returns PASETO v4.public token string
     */
    issue(lease: Lease): string;
    /**
     * Verify a PASETO v4.public token and decode the lease it carries.
     *
     * Verification steps:
     *   1. Validate PASETO v4.public header
     *   2. Peek at unverified payload to read `kid`
     *   3. Resolve the correct public key from the keyring
     *   4. Cryptographically verify the signature (PAE + Ed25519)
     *   5. Parse and return the verified lease
     *
     * This checks ONLY signature integrity.
     * Expiry and revocation are checked separately by the Enforcer (ADR-B).
     *
     * @returns `{ lease }` on success, or `VerifyResult` with `ok: false` on failure
     */
    verify(token: string): {
        lease: Lease;
    } | VerifyResult;
}
