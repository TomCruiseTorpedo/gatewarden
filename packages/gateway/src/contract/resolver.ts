/**
 * buildToolActionResolver — pure factory for a ToolActionResolver.
 *
 * Given a declarative ToolActionMapping array, returns a ToolActionResolver
 * function that maps (toolName, args) → Action | undefined.
 *
 * Contract (R5, R6):
 *   - Unmapped tool: return `undefined` → caller treats as passthrough (R5).
 *   - Mapped tool, arg present: return the concrete Action.
 *   - Mapped tool, arg missing or wrong type: return an Action with a sentinel
 *     value that the Enforcer will deny (deny-by-default, R6). Never return
 *     `undefined` for a mapped tool.
 *
 * This function is pure (no I/O, no side effects). The mapping lookup is O(1)
 * via a pre-built Map.
 */

import type { Action, ToolActionMapping, ToolActionResolver } from './types.js';

// ---------------------------------------------------------------------------
// Sentinel values for missing/invalid arguments (R6)
// ---------------------------------------------------------------------------

/**
 * Sentinel path used when the expected path argument is missing or not a string.
 * A path scope glob can never match this value (it contains a NUL byte which is
 * invalid in all filesystem paths), so the Enforcer will always deny it.
 */
const SENTINEL_PATH = '\x00<missing-path-arg>';

/**
 * Sentinel endpoint for missing/invalid endpoint arguments.
 */
const SENTINEL_ENDPOINT = '\x00<missing-endpoint-arg>';

/**
 * Sentinel currency for missing/invalid currency arguments.
 */
const SENTINEL_CURRENCY = '\x00<missing-currency-arg>';

/**
 * Sentinel amount for missing/invalid amount arguments.
 * Using Number.MAX_SAFE_INTEGER ensures it exceeds any realistic spend cap,
 * causing the Enforcer to deny on the spend ceiling check.
 */
const SENTINEL_AMOUNT = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Argument extraction helpers
// ---------------------------------------------------------------------------

function extractString(args: Record<string, unknown>, key: string, sentinel: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : sentinel;
}

function extractAmount(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  return SENTINEL_AMOUNT;
}

// ---------------------------------------------------------------------------
// buildToolActionResolver
// ---------------------------------------------------------------------------

/**
 * Build a ToolActionResolver from a declarative mapping array.
 *
 * @param mappings - Array of ToolActionMapping entries. Duplicate toolName
 *   entries: last one wins (Map.set semantics).
 * @returns A pure resolver function suitable for LeaseEnforcer / LeasebrokerProxy.
 */
export function buildToolActionResolver(mappings: ToolActionMapping[]): ToolActionResolver {
  // Pre-build lookup map for O(1) resolution.
  const byTool = new Map<string, ToolActionMapping>();
  for (const mapping of mappings) {
    byTool.set(mapping.toolName, mapping);
  }

  return function resolveToolAction(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Action | undefined {
    const mapping = byTool.get(toolName);

    if (mapping === undefined) {
      // Unmapped tool → passthrough (R5).
      return undefined;
    }

    // Mapped tool → always return an Action (R6, deny-by-default for malformed args).
    switch (mapping.kind) {
      case 'fs.read': {
        const path = extractString(toolArgs, mapping.pathArg, SENTINEL_PATH);
        return { kind: 'fs.read', path };
      }

      case 'fs.write': {
        const path = extractString(toolArgs, mapping.pathArg, SENTINEL_PATH);
        return { kind: 'fs.write', path };
      }

      case 'http.call': {
        const endpoint = extractString(toolArgs, mapping.endpointArg, SENTINEL_ENDPOINT);
        return { kind: 'http.call', endpoint };
      }

      case 'spend': {
        const currency = extractString(toolArgs, mapping.currencyArg, SENTINEL_CURRENCY);
        const amountMinor = extractAmount(toolArgs, mapping.amountArg);
        return { kind: 'spend', currency, amountMinor };
      }
    }
  };
}
