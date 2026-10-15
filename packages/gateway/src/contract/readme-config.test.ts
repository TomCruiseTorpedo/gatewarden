/**
 * README config drift guard.
 *
 * Every ```json block in this package's README is a GatewayConfig that a reader
 * copies into a file and passes to `gatewarden score` / `serve`. Each block is
 * run through GatewayConfigSchema here, so a README that drifts from the schema
 * (a renamed or removed key) fails CI instead of failing for the reader with
 * "Invalid gateway configuration".
 *
 * JSON in the README that is not a gateway config must be fenced as something
 * other than `json`.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GatewayConfigSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonBlock {
  /** 1-based README line of the opening fence. */
  line: number;
  body: string;
}

function extractJsonBlocks(markdown: string): JsonBlock[] {
  const lines = markdown.split('\n');
  const blocks: JsonBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^```json\s*$/.test(lines[i] ?? '')) continue;
    const line = i + 1;
    const body: string[] = [];
    for (i++; i < lines.length && !/^```\s*$/.test(lines[i] ?? ''); i++) {
      body.push(lines[i] ?? '');
    }
    blocks.push({ line, body: body.join('\n') });
  }
  return blocks;
}

/**
 * Paths of keys present in `input` but missing from the parsed `output`.
 * GatewayConfigSchema strips unknown keys rather than rejecting them, so a
 * misspelt or renamed optional key still parses and is then silently ignored.
 */
function droppedKeys(input: unknown, output: unknown, path = ''): string[] {
  if (Array.isArray(input)) {
    const out: unknown[] = Array.isArray(output) ? output : [];
    return input.flatMap((item, i) => droppedKeys(item, out[i], `${path}[${i}]`));
  }
  if (input === null || typeof input !== 'object') return [];
  const out = (output !== null && typeof output === 'object' ? output : {}) as Record<
    string,
    unknown
  >;
  return Object.entries(input).flatMap(([key, value]) => {
    const keyPath = path ? `${path}.${key}` : key;
    return key in out ? droppedKeys(value, out[key], keyPath) : [keyPath];
  });
}

const blocks = extractJsonBlocks(
  readFileSync(new URL('../../README.md', import.meta.url), 'utf8'),
);

// ---------------------------------------------------------------------------
// README config blocks
// ---------------------------------------------------------------------------

describe('README.md json config blocks', () => {
  it('finds at least one block', () => {
    // An empty list would let it.each below pass without checking anything.
    expect(blocks.length).toBeGreaterThan(0);
  });

  it.each(blocks)('README.md:$line is a valid GatewayConfig', ({ body }) => {
    const input: unknown = JSON.parse(body);
    const result = GatewayConfigSchema.safeParse(input);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(droppedKeys(input, result.data)).toEqual([]);
  });
});
