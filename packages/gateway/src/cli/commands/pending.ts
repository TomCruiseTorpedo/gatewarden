/**
 * `gatewarden pending` — list all pending requests awaiting approval.
 *
 * Output: JSON array of { reqId, request } objects.
 */

import type { CliState } from '../state.js';

export function cmdPending(state: CliState): void {
  const pending = state.pendingStore.list();
  console.log(JSON.stringify(pending, null, 2));
}
