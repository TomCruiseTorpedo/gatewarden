/**
 * PerMessageBinding — token-on-every-message mode for the A2A face.
 *
 * The default `A2aLeaseBinding` implements the profile's context binding
 * (ADR-F): the first message of a `contextId` that presents a token binds the
 * context, and later messages may omit it. The face authenticates no caller, so
 * once a context is bound its `contextId` is a bearer: anyone who sends it,
 * tokenless, acts with the lease's authority.
 *
 * This binding never remembers a token. The gate resolves the token as
 * `presented ?? bound`, so with nothing bound a message with no token has
 * nothing to fall back on and is rejected; a message that carries one is
 * verified on its own, every time (signature, expiry, revocation, scope). It is
 * a stricter posture than the profile requires, so it is opt-in
 * (`a2a-serve --require-token-per-message`) rather than the default.
 *
 * It is a subclass rather than a flag on the gate because the gate lives in the
 * shared govern engine, which the drift manifest keeps byte-identical across
 * repos; the face already accepts a binding to inject.
 */

import { A2aLeaseBinding } from '@gatewarden/govern';

export class PerMessageBinding extends A2aLeaseBinding {
  /**
   * Accept without storing. With nothing ever stored, `tokenFor` has nothing to
   * return and there is never a bound token for a later message to conflict with.
   */
  override bind(_contextId: string, _token: string): { ok: true } {
    return { ok: true };
  }
}
