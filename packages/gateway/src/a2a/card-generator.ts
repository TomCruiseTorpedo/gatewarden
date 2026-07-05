/**
 * Agent Card generator — the mechanical MCP→A2A discovery mapping
 * (ADR-H; W4 increment 3; the full upstream A2A server face is deferred).
 *
 * Maps the gateway's governed MCP tool surface onto an A2A v1.0 Agent Card:
 *   - Tool.name        → skill.id and skill.name (1:1 — the tool IS the skill)
 *   - Tool.description → skill.description (synthesized when absent — MCP
 *                         descriptions are optional, card descriptions are
 *                         REQUIRED)
 *   - tags             → the ToolActionMapping capability kind when mapped
 *                         ('governed' + kind), else 'passthrough' — tags are
 *                         REQUIRED and no MCP source exists (spec-depth C7)
 *   - inputSchema      → DROPS OUT: AgentSkill carries no parameter schema
 *                         (spec-depth C5) — parameter contracts survive only
 *                         as description text
 *
 * The generated card declares the lease extension required:true (W3 profile)
 * and one JSON-RPC interface. Pure function — no I/O.
 */

import type { AgentCardJson, AgentSkillJson, McpTool } from '@gatewarden/score';
import { leaseCardExtension } from '@gatewarden/govern';
import type { ToolActionMapping } from '../contract/index.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CardGeneratorOptions {
  /** Card name (REQUIRED on the wire). */
  name: string;
  /** Card description (REQUIRED on the wire). */
  description: string;
  /** Card version (REQUIRED on the wire). */
  version: string;
  /** The URL the (future) upstream A2A face will serve on. */
  interfaceUrl: string;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/** Synthesize a REQUIRED description for an undescribed tool. */
function synthesizeDescription(tool: McpTool, mapped: ToolActionMapping | undefined): string {
  const governed =
    mapped !== undefined
      ? ` Governed by capability leases (${mapped.kind}); calls outside the lease scope are denied.`
      : ' Forwarded to the downstream MCP server unchanged.';
  return `Invokes the downstream MCP tool "${tool.name}".${governed}`;
}

/** Tags are REQUIRED on skills; derive them from the governance mapping. */
function tagsFor(mapped: ToolActionMapping | undefined): string[] {
  return mapped !== undefined ? ['governed', mapped.kind] : ['passthrough'];
}

/**
 * Generate an A2A v1.0 Agent Card advertising the gateway's governed tool
 * surface as skills. Deterministic: same inputs, same card.
 */
export function generateAgentCard(
  tools: readonly McpTool[],
  toolActions: readonly ToolActionMapping[],
  options: CardGeneratorOptions,
): AgentCardJson {
  const mappingByTool = new Map(toolActions.map((m) => [m.toolName, m]));

  // Widen the govern-lane entry to the score-lane wire shape (index-signature
  // tolerant reader) — same fields, different canonical modules.
  const lease = leaseCardExtension({ required: true });
  const leaseExtensionEntry = {
    uri: lease.uri,
    description: lease.description,
    required: lease.required,
  };

  const skills: AgentSkillJson[] = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const mapped = mappingByTool.get(tool.name);
      const description =
        tool.description !== undefined && tool.description.trim().length > 0
          ? tool.description
          : synthesizeDescription(tool, mapped);
      return {
        id: tool.name,
        name: tool.name,
        description,
        tags: tagsFor(mapped),
      };
    });

  return {
    name: options.name,
    description: options.description,
    version: options.version,
    supportedInterfaces: [
      {
        url: options.interfaceUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [leaseExtensionEntry],
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills,
  };
}
