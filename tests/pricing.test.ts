/**
 * Tests for SensuClient.resolvePricing (post-pivot, v0.12.0).
 *
 * The bundled MODEL_PRICING fallback was removed per
 * SDK_CONSOLIDATION_PLAN.md §3c. The SDK now relies entirely on the
 * live /api/v1/pricing/models endpoint with a session-scoped cache.
 * On any failure it returns [0, 0] and warns at most once per
 * (provider, model).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SensuClient } from '../src/index.js';

function makeClient(overrides: Partial<{ apiKey: string; disabled: boolean; disableLivePricing: boolean }> = {}): SensuClient {
  return new SensuClient({
    apiKey:           overrides.apiKey ?? 'test-key',
    baseUrl:          'http://localhost:9999',
    agentId:          'agent-1',
    orgId:            'org-1',
    batchSize:        100,
    flushIntervalMs:  999_999,
    disabled:         overrides.disabled ?? false,
    disableLivePricing: overrides.disableLivePricing ?? false,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SensuClient.resolvePricing — live API success', () => {
  it('fetches from the API and caches by (provider, model)', async () => {
    let fetchCalls = 0;
    // @ts-expect-error — overriding global fetch in test
    globalThis.fetch = vi.fn(async (url: string) => {
      fetchCalls++;
      expect(url).toContain('/api/v1/pricing/models/anthropic/claude-opus-4-7');
      return new Response(JSON.stringify({
        provider: 'anthropic',
        model:    'claude-opus-4-7',
        source:   'catalog',
        inputPricePer1mTokens:  15,
        outputPricePer1mTokens: 75,
      }), { status: 200 });
    });

    const client = makeClient();
    const first = await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(first).toEqual([15, 75]);

    // Second call hits the cache, no extra fetch.
    const second = await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(second).toEqual([15, 75]);
    expect(fetchCalls).toBe(1);
  });

  it('returns [0, 0] and warns when the API returns 4xx', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => new Response('not found', { status: 404 }));

    const client = makeClient();
    const result = await client.resolvePricing('cohere', 'command-r-future');
    expect(result).toEqual([0, 0]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/live pricing unavailable for cohere:command-r-future/);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/API returned 404/);
  });

  it('returns [0, 0] and warns on network error', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });

    const client = makeClient();
    const result = await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(result).toEqual([0, 0]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/network error: ECONNREFUSED/);
  });

  it('warns at most once per (provider, model) per client lifetime', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 }));

    const client = makeClient();
    await client.resolvePricing('anthropic', 'claude-opus-4-7');
    await client.resolvePricing('anthropic', 'claude-opus-4-7');
    await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns once per unique (provider, model) pair', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 }));

    const client = makeClient();
    await client.resolvePricing('anthropic', 'claude-opus-4-7');
    await client.resolvePricing('openai',    'gpt-4o');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('handles a 200 with null rates as a miss (warns, returns zeros)', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      provider: 'anthropic', model: 'mystery',
      inputPricePer1mTokens: null, outputPricePer1mTokens: null,
    }), { status: 200 }));

    const client = makeClient();
    const result = await client.resolvePricing('anthropic', 'mystery');
    expect(result).toEqual([0, 0]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('SensuClient.resolvePricing — short-circuit paths', () => {
  it('returns [0, 0] and warns when disableLivePricing is true (no fetch)', async () => {
    const fetchMock = vi.fn();
    // @ts-expect-error
    globalThis.fetch = fetchMock;

    const client = makeClient({ disableLivePricing: true });
    const result = await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(result).toEqual([0, 0]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/disableLivePricing=true/);
  });

  it('returns [0, 0] and warns when the client is disabled', async () => {
    const fetchMock = vi.fn();
    // @ts-expect-error
    globalThis.fetch = fetchMock;

    const client = makeClient({ disabled: true });
    const result = await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(result).toEqual([0, 0]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/client disabled/);
  });

  it('returns [0, 0] and warns when apiKey is missing', async () => {
    const fetchMock = vi.fn();
    // @ts-expect-error
    globalThis.fetch = fetchMock;

    const client = makeClient({ apiKey: '' });
    const result = await client.resolvePricing('anthropic', 'claude-opus-4-7');
    expect(result).toEqual([0, 0]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/no API key/);
  });
});
