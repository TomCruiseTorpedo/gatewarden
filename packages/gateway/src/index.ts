/**
 * @gatewarden/gateway — public API barrel (placeholder).
 *
 * Scaffold placeholder so the workspace stays green (tsc + vitest) from minute
 * one. `gateway-001` (the contract bead) replaces this with the real barrel.
 *
 * The smoke imports below prove the re-home import surface resolves — the
 * gateway can pull a value + a type from BOTH vendored cores. Delete on first
 * real bead.
 */

import { scoreLintOnly } from '@gatewarden/score';
import type { Scorecard, ServerMeta } from '@gatewarden/score';
import { LeaseEnforcer } from '@gatewarden/govern';
import type { Action, Lease, PolicyRule } from '@gatewarden/govern';

/** Re-home smoke: both cores resolve as workspace deps (value + type). */
export const __rehomeSmoke = { scoreLintOnly, LeaseEnforcer } as const;

export type { Scorecard, ServerMeta, Action, Lease, PolicyRule };
