/**
 * GatewayConfig loader.
 *
 * Loads a GatewayConfig from a JSON or ES-module JS/TS file, validates it
 * through the Zod schema (clear errors), and enforces R9 (no multi-downstream).
 *
 * Supported file formats:
 *   - `.json`   — parsed with JSON.parse
 *   - `.js`, `.mjs`, `.ts`, `.mts` — dynamic import (default export consumed)
 *
 * Error handling:
 *   - File not found → throws ConfigLoadError with code 'NOT_FOUND'
 *   - Invalid JSON    → throws ConfigLoadError with code 'PARSE_ERROR'
 *   - Schema failure  → throws ConfigLoadError with code 'INVALID_CONFIG' with
 *                       human-readable field-by-field Zod messages
 *   - R9 violation    → caught as INVALID_CONFIG from the schema's superRefine
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GatewayConfigSchema } from '../contract/index.js';
import type { GatewayConfig } from '../contract/index.js';

// ---------------------------------------------------------------------------
// ConfigLoadError
// ---------------------------------------------------------------------------

export type ConfigLoadErrorCode =
  | 'NOT_FOUND'
  | 'PARSE_ERROR'
  | 'INVALID_CONFIG'
  | 'UNSUPPORTED_FORMAT';

export class ConfigLoadError extends Error {
  constructor(
    public readonly code: ConfigLoadErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load and validate a GatewayConfig from a file path.
 *
 * @param filePath - Absolute or relative path to a `.json` or `.js/.mjs` config file.
 * @returns The validated GatewayConfig.
 * @throws ConfigLoadError on any load or validation failure.
 */
export async function loadConfig(filePath: string): Promise<GatewayConfig> {
  const absolutePath = resolve(filePath);
  const ext = absolutePath.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';

  let raw: unknown;

  if (ext === 'json') {
    raw = await loadJson(absolutePath);
  } else if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].includes(ext)) {
    raw = await loadModule(absolutePath);
  } else {
    throw new ConfigLoadError(
      'UNSUPPORTED_FORMAT',
      `Unsupported config file format: .${ext}. Use .json or .js/.mjs.`,
    );
  }

  return validate(raw);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadJson(absolutePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(absolutePath, 'utf8');
  } catch (err) {
    throw new ConfigLoadError(
      'NOT_FOUND',
      `Config file not found: ${absolutePath}`,
      err,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ConfigLoadError(
      'PARSE_ERROR',
      `Failed to parse JSON config at ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

async function loadModule(absolutePath: string): Promise<unknown> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  } catch (err) {
    // Distinguish "file not found" from other import errors
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound =
      msg.includes('Cannot find module') ||
      msg.includes('ENOENT') ||
      msg.includes('ERR_MODULE_NOT_FOUND');
    throw new ConfigLoadError(
      isNotFound ? 'NOT_FOUND' : 'PARSE_ERROR',
      `Failed to load config module at ${absolutePath}: ${msg}`,
      err,
    );
  }

  // Prefer default export; fall back to the module object itself
  return 'default' in mod ? mod['default'] : mod;
}

function validate(raw: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(raw);

  if (!result.success) {
    // Format Zod errors into human-readable field-by-field messages.
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  ${path}: ${issue.message}`;
      })
      .join('\n');

    throw new ConfigLoadError(
      'INVALID_CONFIG',
      `Invalid gateway configuration:\n${messages}`,
    );
  }

  return result.data as GatewayConfig;
}
