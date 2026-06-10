/**
 * Zod schemas for leasebroker contract types.
 *
 * These schemas validate incoming data at the trust boundary (e.g. API requests,
 * policy rule files). They are the runtime enforcement of the type definitions
 * in types.ts.
 *
 * Key invariant: money (capMinor, amountMinor) is always an integer — never float.
 */
import { z } from 'zod';
/**
 * Validated Capability discriminated union.
 * Rejects any unknown `kind` values.
 */
export declare const CapabilitySchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"fs.read">;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"fs.write">;
    paths: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"http.call">;
    endpoints: z.ZodArray<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"spend">;
    currency: z.ZodString;
    capMinor: z.ZodNumber;
}, z.core.$strip>], "kind">;
/** Inferred TypeScript type from the Capability schema. */
export type CapabilityInput = z.infer<typeof CapabilitySchema>;
/**
 * Validates a lease request from an agent.
 * Rejects missing fields, empty capabilities, and negative durations.
 */
export declare const LeaseRequestSchema: z.ZodObject<{
    agentId: z.ZodString;
    taskId: z.ZodString;
    capabilities: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fs.read">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"fs.write">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"http.call">;
        endpoints: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"spend">;
        currency: z.ZodString;
        capMinor: z.ZodNumber;
    }, z.core.$strip>], "kind">>;
    requestedDurationMs: z.ZodNumber;
}, z.core.$strip>;
/** Inferred TypeScript type from the LeaseRequest schema. */
export type LeaseRequestInput = z.infer<typeof LeaseRequestSchema>;
/**
 * Validates a Lease object (e.g. when deserialising from a PASETO token payload).
 */
export declare const LeaseSchema: z.ZodObject<{
    id: z.ZodString;
    agentId: z.ZodString;
    taskId: z.ZodString;
    capabilities: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"fs.read">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"fs.write">;
        paths: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"http.call">;
        endpoints: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"spend">;
        currency: z.ZodString;
        capMinor: z.ZodNumber;
    }, z.core.$strip>], "kind">>;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    kid: z.ZodString;
}, z.core.$strip>;
/** Inferred TypeScript type from the Lease schema. */
export type LeaseInput = z.infer<typeof LeaseSchema>;
/**
 * Validates a declarative allow-rule for the policy engine (ADR-C).
 *
 * Rules are stored as data (e.g. YAML/JSON config files) and loaded at startup.
 * No matching allow-rule → deny (deny-by-default).
 */
export declare const PolicyRuleSchema: z.ZodObject<{
    ruleId: z.ZodString;
    agentId: z.ZodOptional<z.ZodString>;
    capabilityKind: z.ZodOptional<z.ZodEnum<{
        "fs.read": "fs.read";
        "fs.write": "fs.write";
        "http.call": "http.call";
        spend: "spend";
    }>>;
    effect: z.ZodEnum<{
        allow: "allow";
        "veto-required": "veto-required";
    }>;
    maxDurationMs: z.ZodOptional<z.ZodNumber>;
    paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    endpoints: z.ZodOptional<z.ZodArray<z.ZodString>>;
    maxCapMinor: z.ZodOptional<z.ZodNumber>;
    currency: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Inferred TypeScript type from the PolicyRule schema. */
export type PolicyRuleInput = z.infer<typeof PolicyRuleSchema>;
