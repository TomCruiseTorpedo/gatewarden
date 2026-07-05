/**
 * A2A downstream lane tests (ADR-H) — attach snapshot, governed send
 * (deny = no wire traffic), and the card generator dogfood: gatewarden's own
 * generated card is scored by its own vendored card scorer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { scoreCardLintOnly } from '@gatewarden/score';
import type { McpTool } from '@gatewarden/score';
import { LEASE_EXT_URI } from '@gatewarden/govern';
import type { Action, AuditEvent, AuditSink, VerifyResult } from '@gatewarden/govern';

import { attachA2aSnapshot, resolveCardUrl, type FetchLike } from './attach.js';
import {
  deriveSendActions,
  GovernedA2aDownstream,
  LEASE_SERVICE_PARAMETERS,
  type A2aWireClient,
} from './downstream.js';
import { generateAgentCard } from './card-generator.js';
import type { ToolActionMapping } from '../contract/index.js';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const cleanCard: unknown = JSON.parse(
  readFileSync(
    new URL('../../../score/fixtures/agent-cards/clean-card.json', import.meta.url),
    'utf8',
  ),
);

const fetchOk =
  (body: unknown): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

function fakeAudit(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { sink: { append: (e) => void events.push(e) } as AuditSink, events };
}

function fakeWire(): {
  client: A2aWireClient;
  sends: Array<{ message: unknown; options: unknown }>;
} {
  const sends: Array<{ message: unknown; options: unknown }> = [];
  const client: A2aWireClient = {
    async sendMessage(params, options) {
      sends.push({ message: params.message, options });
      return { kind: 'task', id: 'task-1' };
    },
    async getTask() {
      throw new Error('not used');
    },
    async cancelTask() {
      throw new Error('not used');
    },
  };
  return { client, sends };
}

/** Enforcer allowing everything except what `denyKinds` names. */
const enforcerDenying = (denyKinds: ReadonlySet<Action['kind']>, reason = 'denied by test') => ({
  check: (_token: string, action: Action): VerifyResult =>
    denyKinds.has(action.kind) ? { ok: false, reason } : { ok: true },
});

const TOOLS: McpTool[] = [
  {
    name: 'read_report',
    description: 'Reads a report file from the data directory.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  { name: 'charge_card', inputSchema: { type: 'object' } }, // no description — synthesized
];

const MAPPINGS: ToolActionMapping[] = [
  { toolName: 'charge_card', kind: 'spend', currencyArg: 'currency', amountArg: 'amount' },
];

// ---------------------------------------------------------------------------
// attach (increment 1)
// ---------------------------------------------------------------------------

describe('resolveCardUrl', () => {
  it('appends the well-known path to bare origins (A2A §8.2) and preserves explicit paths', () => {
    expect(resolveCardUrl('https://agent.example.com')).toBe(
      'https://agent.example.com/.well-known/agent-card.json',
    );
    expect(resolveCardUrl('https://agent.example.com/cards/custom.json')).toBe(
      'https://agent.example.com/cards/custom.json',
    );
  });
});

describe('attachA2aSnapshot', () => {
  it('fetches, scores, and freezes the snapshot (read-only attach)', async () => {
    const { snapshot, rawCard } = await attachA2aSnapshot(
      { transport: 'a2a', cardUrl: 'https://agent.example.com' },
      fetchOk(cleanCard),
    );
    expect(snapshot.card).toEqual({ name: 'Recipe Research Agent', version: '2.1.0' });
    expect(snapshot.cardScorecard.aggregate.lintScore).toBe(10);
    expect(snapshot.cardScorecard.signature.tier).toBe('structural');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.cardScorecard)).toBe(true);
    expect(rawCard).toEqual(cleanCard);
  });

  it('surfaces HTTP failures instead of scoring nothing', async () => {
    const failing: FetchLike = async () => ({ ok: false, status: 404, text: async () => '' });
    await expect(
      attachA2aSnapshot({ transport: 'a2a', cardUrl: 'https://agent.example.com' }, failing),
    ).rejects.toThrow(/HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// action derivation + governed send (increment 2)
// ---------------------------------------------------------------------------

describe('deriveSendActions', () => {
  const URL_ = 'https://agent.example.com/a2a/v1';

  it('always derives the baseline http.call to the interface URL', () => {
    const derived = deriveSendActions([], URL_);
    expect(derived).toEqual({ actions: [{ kind: 'http.call', endpoint: URL_ }] });
  });

  it('adds a spend action when configured keys are present in a DataPart', () => {
    const parts = [
      {
        content: { $case: 'data' as const, value: { currency: 'CAD', amount: 1500 } },
        metadata: undefined,
        filename: '',
        mediaType: '',
      },
    ];
    const derived = deriveSendActions(parts, URL_, {
      spendExtraction: { currencyKey: 'currency', amountKey: 'amount' },
    });
    expect('actions' in derived && derived.actions).toEqual([
      { kind: 'http.call', endpoint: URL_ },
      { kind: 'spend', currency: 'CAD', amountMinor: 1500 },
    ]);
  });

  it('denies outright on present-but-malformed spend values (deny-by-default)', () => {
    const parts = [
      {
        content: { $case: 'data' as const, value: { currency: 'CAD', amount: 19.99 } },
        metadata: undefined,
        filename: '',
        mediaType: '',
      },
    ];
    const derived = deriveSendActions(parts, URL_, {
      spendExtraction: { currencyKey: 'currency', amountKey: 'amount' },
    });
    expect('malformed' in derived).toBe(true);
  });
});

describe('GovernedA2aDownstream.send', () => {
  const URL_ = 'https://agent.example.com/a2a/v1';

  it('carries the lease per the W3 profile and declares the extension header', async () => {
    const { client, sends } = fakeWire();
    const { sink, events } = fakeAudit();
    const downstream = new GovernedA2aDownstream({
      client,
      interfaceUrl: URL_,
      enforcer: enforcerDenying(new Set()),
      audit: sink,
    });

    const result = await downstream.send({
      content: 'Summarize the quarterly report',
      contextId: 'ctx-42',
      leaseToken: 'v4.public.lease',
    });

    expect(result.sent).toBe(true);
    expect(sends).toHaveLength(1);
    const message = sends[0]?.message as {
      metadata: Record<string, unknown>;
      extensions: string[];
      contextId: string;
    };
    expect(message.contextId).toBe('ctx-42');
    expect(message.extensions).toContain(LEASE_EXT_URI);
    expect(message.metadata[LEASE_EXT_URI]).toEqual({ token: 'v4.public.lease' });
    const options = sends[0]?.options as { serviceParameters: Record<string, string> };
    expect(options.serviceParameters).toEqual({ ...LEASE_SERVICE_PARAMETERS });
    expect(events.map((e) => e.type)).toEqual(['use']);
  });

  it('denies before any wire traffic when the lease does not cover the endpoint', async () => {
    const { client, sends } = fakeWire();
    const { sink, events } = fakeAudit();
    const downstream = new GovernedA2aDownstream({
      client,
      interfaceUrl: URL_,
      enforcer: enforcerDenying(new Set(['http.call']), 'endpoint not in lease scope'),
      audit: sink,
    });

    const result = await downstream.send({
      content: 'hello',
      contextId: 'ctx-1',
      leaseToken: 'tok',
    });

    expect(result).toMatchObject({ sent: false, reason: 'endpoint not in lease scope' });
    expect(sends).toHaveLength(0); // deny = NO wire traffic
    expect(events.map((e) => e.type)).toEqual(['denial']);
  });

  it('denies on the spend action even when the endpoint is allowed', async () => {
    const { client, sends } = fakeWire();
    const { sink } = fakeAudit();
    const downstream = new GovernedA2aDownstream({
      client,
      interfaceUrl: URL_,
      enforcer: enforcerDenying(new Set(['spend']), 'spend cap exceeded'),
      audit: sink,
      policy: { spendExtraction: { currencyKey: 'currency', amountKey: 'amount' } },
    });

    const result = await downstream.send({
      content: [
        {
          content: { $case: 'data', value: { currency: 'CAD', amount: 999999 } },
          metadata: undefined,
          filename: '',
          mediaType: '',
        },
      ],
      contextId: 'ctx-1',
      leaseToken: 'tok',
    });

    expect(result).toMatchObject({ sent: false, reason: 'spend cap exceeded' });
    expect(sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// card generator (increment 3) — dogfood
// ---------------------------------------------------------------------------

describe('generateAgentCard', () => {
  const card = generateAgentCard(TOOLS, MAPPINGS, {
    name: 'Gatewarden Gateway',
    description: 'Score-at-attach, govern-every-call gateway fronting one MCP server.',
    version: '0.1.0',
    interfaceUrl: 'https://gateway.example.com/a2a/v1',
  });

  it('maps tools to skills 1:1, sorted, with synthesized REQUIRED fields', () => {
    expect(card.skills?.map((s) => s.id)).toEqual(['charge_card', 'read_report']);
    const charge = card.skills?.find((s) => s.id === 'charge_card');
    expect(charge?.description).toContain('capability leases');
    expect(charge?.tags).toEqual(['governed', 'spend']);
    const read = card.skills?.find((s) => s.id === 'read_report');
    expect(read?.description).toBe('Reads a report file from the data directory.');
    expect(read?.tags).toEqual(['passthrough']);
  });

  it('declares the lease extension required:true (W3 profile)', () => {
    const ext = card.capabilities?.extensions?.[0];
    expect(ext?.uri).toBe(LEASE_EXT_URI);
    expect(ext?.required).toBe(true);
  });

  it('dogfood: scores ≥ 9.5 under the vendored card scorer (unsigned is the only ding)', () => {
    const scorecard = scoreCardLintOnly(card);
    expect(scorecard.aggregate.lintScore).toBeGreaterThanOrEqual(9.5);
    const errors = Object.values(scorecard.axes).flatMap((a) =>
      a.findings.filter((f) => f.severity === 'error'),
    );
    expect(errors).toEqual([]);
    expect(scorecard.signature.present).toBe(false); // unsigned — expected for a generated card
  });
});
