/**
 * PASETO v4.public — minimal implementation on @noble/ed25519.
 *
 * Implements the PASETO v4.public token format per the PASETO RFC:
 *   https://paseto.io/rfc/
 *
 * Key decisions (ADR-A):
 *   - Crypto primitive: @noble/ed25519 (audited, maintained)
 *   - The canonical `paseto` npm lib is NOT used (3yr stale, no patch path)
 *   - SHA-512 is injected from Node.js `crypto` to enable the sync API without
 *     adding @noble/hashes as a dependency
 *
 * PASETO v4.public framing:
 *   sign:   m2 = PAE("v4.public.", m, f, i)
 *           sig = Ed25519.sign(m2, sk)
 *           token = "v4.public." || base64url(m || sig) [|| "." || base64url(f)]
 *
 *   verify: parse token, recover m and sig
 *           m2 = PAE("v4.public.", m, f, i)
 *           Ed25519.verify(sig, m2, pk)
 */
import { sign, verify, getPublicKey } from '@noble/ed25519';
export { getPublicKey, sign as ed25519Sign, verify as ed25519Verify };
/** Encode bytes to base64url (no padding). */
export declare function toBase64Url(bytes: Uint8Array): string;
/** Decode base64url string to bytes (with or without padding). */
export declare function fromBase64Url(s: string): Uint8Array;
/**
 * Pre-Authentication Encoding.
 *
 * PAE(pieces...) = LE64(count) || for each piece: LE64(len(piece)) || piece
 *
 * Lengths are encoded as unsigned 64-bit little-endian integers.
 * This provides unambiguous framing for the signed message, preventing
 * signature confusion across different token structures.
 *
 * @example
 * pae(
 *   new TextEncoder().encode('v4.public.'),
 *   message,
 *   footer,
 *   implicitAssertion,
 * )
 */
export declare function pae(...pieces: Uint8Array[]): Uint8Array;
/**
 * Sign a message as a PASETO v4.public token.
 *
 * @param message           Raw message bytes (typically UTF-8 JSON)
 * @param secretKey         32-byte Ed25519 seed (private key seed)
 * @param footer            Optional footer bytes — stored in the token, not encrypted
 * @param implicitAssertion Optional implicit assertion — signed but NOT stored in token
 * @returns PASETO v4.public token string
 */
export declare function v4PublicSign(message: Uint8Array, secretKey: Uint8Array, footer?: Uint8Array, implicitAssertion?: Uint8Array): string;
/**
 * Verify and decode a PASETO v4.public token.
 *
 * Checks ONLY cryptographic integrity (signature).
 * Expiry and revocation must be checked separately by the Enforcer.
 *
 * @param token             PASETO v4.public token string
 * @param publicKey         32-byte Ed25519 public key
 * @param implicitAssertion Optional implicit assertion — must match what was used at sign time
 * @returns `{ payload, footer }` on success, `null` on any verification failure
 */
export declare function v4PublicVerify(token: string, publicKey: Uint8Array, implicitAssertion?: Uint8Array): {
    payload: Uint8Array;
    footer: Uint8Array;
} | null;
