/**
 * Tests for the per-call `captureBodies` opt-in on `trackTool`
 * (TOOL_IO_CAPTURE_PLAN.md §5.1 + §5.4 + §11).
 *
 * Two layers:
 *   1. Direct unit tests on the serialization helper
 *      `serializeToolBodiesForCapture` — pinned semantics for the
 *      cross-SDK invariants (default off, opt-in, JSON.stringify
 *      both, 256 KB truncation marker, skip-both on serialization
 *      failure).
 *   2. End-to-end wire-shape tests that mock `globalThis.fetch` and
 *      assert what `tool.call.completed` looks like on the wire —
 *      whether `input_body` / `output_body` are present, what shape
 *      they take, and that the v1 metadata fields (status, latency)
 *      are untouched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensuClient } from '../src/index.js';
import { serializeToolBodiesForCapture } from '../src/client.js';

// ---------------------------------------------------------------------------
// Layer 1 — pure serialization helper
// ---------------------------------------------------------------------------

describe('serializeToolBodiesForCapture', () => {
  it('opt-out (captureBodies undefined/false) returns an empty object', () => {
    expect(serializeToolBodiesForCapture({ q: 'a' }, { ok: 1 }, undefined)).toEqual({});
    expect(serializeToolBodiesForCapture({ q: 'a' }, { ok: 1 }, false)).toEqual({});
  });

  it('opt-in + JSON-serializable args/result returns both bodies as JSON.stringify output', () => {
    const out = serializeToolBodiesForCapture(
      { query: 'find user@example.com' },
      { matches: 1, top: { email: 'user@example.com' } },
      true,
    );
    expect(out.input_body).toBe(JSON.stringify({ query: 'find user@example.com' }));
    expect(out.output_body).toBe(JSON.stringify({ matches: 1, top: { email: 'user@example.com' } }));
  });

  it('opt-in + primitive args + primitive result still works', () => {
    const out = serializeToolBodiesForCapture('hello', 42, true);
    expect(out.input_body).toBe('"hello"');
    expect(out.output_body).toBe('42');
  });

  it('opt-in + circular args structure → both bodies skipped (no half-capture)', () => {
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const out = serializeToolBodiesForCapture(cyclic, { ok: true }, true);
    expect(out.input_body).toBeUndefined();
    expect(out.output_body).toBeUndefined();
  });

  it('opt-in + circular result structure → both bodies skipped', () => {
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const out = serializeToolBodiesForCapture({ ok: true }, cyclic, true);
    expect(out.input_body).toBeUndefined();
    expect(out.output_body).toBeUndefined();
  });

  it('opt-in + BigInt anywhere → both bodies skipped (JSON.stringify throws)', () => {
    const out = serializeToolBodiesForCapture({ size: 5n }, { ok: true }, true);
    expect(out.input_body).toBeUndefined();
    expect(out.output_body).toBeUndefined();
  });

  it('opt-in + bare undefined args → both bodies skipped (JSON.stringify(undefined) is undefined)', () => {
    const out = serializeToolBodiesForCapture(undefined, { ok: true }, true);
    expect(out.input_body).toBeUndefined();
    expect(out.output_body).toBeUndefined();
  });

  it('opt-in + bare function result → both bodies skipped', () => {
    const out = serializeToolBodiesForCapture({ q: 'a' }, () => 'fn', true);
    expect(out.input_body).toBeUndefined();
    expect(out.output_body).toBeUndefined();
  });

  it('opt-in + body exactly at the 256 KB cap is preserved verbatim (no marker)', () => {
    // After JSON.stringify, a `"x...x"` body is N+2 chars (the two
    // wrapping quotes). Aim for an inner string sized so the wire body
    // is exactly 262144.
    const inner = 'x'.repeat(262_142);
    const out = serializeToolBodiesForCapture(inner, 'ok', true);
    expect(out.input_body?.length).toBe(262_144);
    expect(out.input_body?.endsWith('[truncated]')).toBe(false);
  });

  it('opt-in + oversize body → truncated to exactly 256 KB with the cross-SDK marker', () => {
    // JSON.stringify('x'.repeat(300_000)) → 300_002 chars (quotes). Well above the cap.
    const giant = 'x'.repeat(300_000);
    const out = serializeToolBodiesForCapture(giant, 'ok', true);
    expect(out.input_body?.length).toBe(262_144);
    // The marker carries a leading space + ellipsis + tag; the leading
    // space is intentional (§5.4) so the marker lands cleanly on a
    // word boundary in the inspector preview.
    expect(out.input_body?.endsWith(' …[truncated]')).toBe(true);
    // output_body wasn't oversize → preserved unchanged.
    expect(out.output_body).toBe('"ok"');
  });

  it('opt-in + both sides oversize → both get truncated independently', () => {
    const giantIn  = 'a'.repeat(300_000);
    const giantOut = 'b'.repeat(300_000);
    const out = serializeToolBodiesForCapture(giantIn, giantOut, true);
    expect(out.input_body?.length).toBe(262_144);
    expect(out.output_body?.length).toBe(262_144);
    expect(out.input_body?.endsWith(' …[truncated]')).toBe(true);
    expect(out.output_body?.endsWith(' …[truncated]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — wire-shape via mocked fetch
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url:  string;
  body: { events: Array<Record<string, unknown>> };
}

function makeClient(): SensuClient {
  return new SensuClient({
    apiKey:              'test-key',
    baseUrl:             'http://localhost:9999',
    agentId:             'agent-1',
    orgId:               'org-1',
    batchSize:           100,
    flushIntervalMs:     999_999,
    disableLivePricing:  true,
  });
}

function mockFetchOk(): { fetchMock: ReturnType<typeof vi.fn>; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(init.body as string) as CapturedRequest['body'],
    });
    return new Response(JSON.stringify({ processed: 0, errors: [] }), { status: 200 });
  });
  // @ts-expect-error — overriding global fetch in test
  globalThis.fetch = fetchMock;
  return { fetchMock, calls };
}

function findToolCompleted(calls: CapturedRequest[]): Record<string, unknown> | undefined {
  for (const c of calls) {
    for (const e of c.body.events) {
      if (e['event_type'] === 'tool.call.completed') return e;
    }
  }
  return undefined;
}

describe('trackTool — captureBodies wire shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('default (no captureBodies) → tool.call.completed has no body fields', async () => {
    const client = makeClient();
    const { calls } = mockFetchOk();

    await client.run({}, async () => {
      await client.trackTool('crm_lookup', async () => ({ matches: 1 }));
    });
    await client.flush();

    const evt = findToolCompleted(calls);
    expect(evt).toBeDefined();
    expect(evt).not.toHaveProperty('input_body');
    expect(evt).not.toHaveProperty('output_body');
    expect(evt!['tool_name']).toBe('crm_lookup');
    expect(evt!['status']).toBe('success');
  });

  it('opt-in → tool.call.completed carries both input_body and output_body as JSON', async () => {
    const client = makeClient();
    const { calls } = mockFetchOk();

    await client.run({}, async () => {
      await client.trackTool(
        'crm_lookup',
        async () => ({ matches: 1, top: { email: 'user@example.com' } }),
        {
          args:          { query: 'find user@example.com' },
          captureBodies: true,
        },
      );
    });
    await client.flush();

    const evt = findToolCompleted(calls)!;
    expect(evt['input_body']).toBe(JSON.stringify({ query: 'find user@example.com' }));
    expect(evt['output_body']).toBe(JSON.stringify({ matches: 1, top: { email: 'user@example.com' } }));
    // v1 metadata stays untouched.
    expect(evt['status']).toBe('success');
    expect(typeof evt['latency_ms']).toBe('number');
    expect(typeof evt['tool_call_id']).toBe('string');
  });

  it('opt-in but result throws → status is error AND no body fields land (no half-capture)', async () => {
    const client = makeClient();
    const { calls } = mockFetchOk();

    await expect(
      client.run({}, async () => {
        await client.trackTool(
          'crm_lookup',
          async () => { throw new Error('boom'); },
          { args: { query: 'a' }, captureBodies: true },
        );
      }),
    ).rejects.toThrow('boom');
    await client.flush();

    const evt = findToolCompleted(calls)!;
    // result was never produced — JSON.stringify(undefined) returns
    // undefined, helper returns {}, neither field lands on the wire.
    expect(evt).not.toHaveProperty('input_body');
    expect(evt).not.toHaveProperty('output_body');
    expect(evt['status']).toBe('error');
  });

  it('opt-in + circular result → tool.call.completed lands without either body, status preserved', async () => {
    const client = makeClient();
    const { calls } = mockFetchOk();
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;

    await client.run({}, async () => {
      await client.trackTool(
        'crm_lookup',
        async () => cyclic,
        { args: { query: 'a' }, captureBodies: true },
      );
    });
    await client.flush();

    const evt = findToolCompleted(calls)!;
    expect(evt).not.toHaveProperty('input_body');
    expect(evt).not.toHaveProperty('output_body');
    expect(evt['status']).toBe('success');
  });
});
