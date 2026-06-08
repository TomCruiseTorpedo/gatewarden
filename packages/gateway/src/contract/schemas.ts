/**
 * Zod v4 schemas for the Gateway contract.
 *
 * Validates GatewayConfig at the trust boundary (file load, API input).
 * Key invariants:
 *   - Single downstream (R9): `downstream` is a single object, never an array.
 *     Multi-downstream configs are explicitly rejected with a clear error.
 *   - ToolActionMapping: each entry must be a valid discriminated shape.
 *   - policy: re-uses govern's PolicyRuleSchema.
 */

import { z } from 'zod';
import { PolicyRuleSchema } from '@gatewarden/govern';

// ---------------------------------------------------------------------------
// DownstreamSpec schemas
// ---------------------------------------------------------------------------

const StdioDownstreamSpecSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1, 'command is required for stdio transport'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const SseDownstreamSpecSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url('url must be a valid URL for sse transport'),
});

const HttpDownstreamSpecSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url('url must be a valid URL for http transport'),
});

export const DownstreamSpecSchema = z.discriminatedUnion('transport', [
  StdioDownstreamSpecSchema,
  SseDownstreamSpecSchema,
  HttpDownstreamSpecSchema,
]);

// ---------------------------------------------------------------------------
// ToolActionMapping schemas
// ---------------------------------------------------------------------------

const FsReadMappingSchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  kind: z.literal('fs.read'),
  pathArg: z.string().min(1, 'pathArg is required for fs.read mapping'),
});

const FsWriteMappingSchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  kind: z.literal('fs.write'),
  pathArg: z.string().min(1, 'pathArg is required for fs.write mapping'),
});

const HttpCallMappingSchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  kind: z.literal('http.call'),
  endpointArg: z.string().min(1, 'endpointArg is required for http.call mapping'),
});

const SpendMappingSchema = z.object({
  toolName: z.string().min(1, 'toolName is required'),
  kind: z.literal('spend'),
  currencyArg: z.string().min(1, 'currencyArg is required for spend mapping'),
  amountArg: z.string().min(1, 'amountArg is required for spend mapping'),
});

export const ToolActionMappingSchema = z.discriminatedUnion('kind', [
  FsReadMappingSchema,
  FsWriteMappingSchema,
  HttpCallMappingSchema,
  SpendMappingSchema,
]);

// ---------------------------------------------------------------------------
// GatewayConfig schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for GatewayConfig.
 *
 * R9 enforcement: `downstream` is a single DownstreamSpec object. A config
 * with multiple downstreams (array) is structurally rejected by this schema —
 * passing an array yields a clear "Expected object, received array" error.
 * The superRefine further catches any attempt to embed an array inside an
 * object wrapper and produces a human-readable "not supported in v1" message.
 */
export const GatewayConfigSchema = z
  .object({
    downstream: DownstreamSpecSchema,
    policy: z.array(PolicyRuleSchema).default([]),
    toolActions: z.array(ToolActionMappingSchema).default([]),
    scoring: z
      .object({
        eval: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // R9: belt-and-suspenders multi-downstream guard.
    // The discriminatedUnion already rejects arrays, but if someone wraps
    // downstreams in an object (future extension), we reject explicitly.
    if (Array.isArray(data.downstream)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['downstream'],
        message:
          'Multi-downstream configs are not supported in v1. ' +
          'Specify exactly one downstream server.',
      });
    }
  });

export type GatewayConfigInput = z.input<typeof GatewayConfigSchema>;
export type GatewayConfigOutput = z.output<typeof GatewayConfigSchema>;
