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

function makeClient(overrides: Partial<{
  apiKey: string;
  disabled: boolean;
  disableLivePricing: boolean;
  pricingCacheTtlMs: number;
}> = {}): SensuClient {
  return new SensuClient({
    apiKey:           overrides.apiKey ?? 'test-key',
    baseUrl:          'http://localhost:9999',
    agentId:          'agent-1',
    orgId:            'org-1',
    batchSize:        100,
    flushIntervalMs:  999_999,
    disabled:         overrides.disabled ?? false,
    disableLivePricing: overrides.disableLivePricing ?? false,
    ...(overrides.pricingCacheTtlMs !== undefined ? { pricingCacheTtlMs: overrides.pricingCacheTtlMs } : {}),
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

describe('SensuClient.resolvePricing — cache TTL', () => {
  function mockFetchReturning(input: number, output: number): { fetchMock: ReturnType<typeof vi.fn>; calls: () => number } {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      inputPricePer1mTokens: input,
      outputPricePer1mTokens: output,
    }), { status: 200 }));
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = fetchMock;
    return { fetchMock, calls: () => fetchMock.mock.calls.length };
  }

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockFetchReturning(15, 75);
      const client = makeClient({ pricingCacheTtlMs: 60_000 }); // 1 minute TTL

      const first = await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(first).toEqual([15, 75]);
      expect(calls()).toBe(1);

      // Advance just under the TTL — still cache hit.
      vi.advanceTimersByTime(59_000);
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(calls()).toBe(1);

      // Cross the TTL threshold — next call refetches.
      vi.advanceTimersByTime(2_000);
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks up updated rates on the refetch', async () => {
    vi.useFakeTimers();
    try {
      // First mock returns one rate set.
      let mock1 = vi.fn(async () => new Response(JSON.stringify({
        inputPricePer1mTokens: 15, outputPricePer1mTokens: 75,
      }), { status: 200 }));
      // @ts-expect-error
      globalThis.fetch = mock1;

      const client = makeClient({ pricingCacheTtlMs: 1_000 });
      const before = await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(before).toEqual([15, 75]);

      // Swap fetch mock — second call returns a different (e.g. discounted) rate.
      const mock2 = vi.fn(async () => new Response(JSON.stringify({
        inputPricePer1mTokens: 12, outputPricePer1mTokens: 60,
      }), { status: 200 }));
      // @ts-expect-error
      globalThis.fetch = mock2;
      void mock1; // suppress unused

      // Advance past TTL → next call refetches → gets new rate.
      vi.advanceTimersByTime(1_500);
      const after = await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(after).toEqual([12, 60]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('default TTL is 1 hour (cache holds across multiple in-window calls)', async () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockFetchReturning(15, 75);
      const client = makeClient(); // no TTL override

      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      vi.advanceTimersByTime(45 * 60 * 1000); // 45 min — within default 1h
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(calls()).toBe(1);

      vi.advanceTimersByTime(20 * 60 * 1000); // total 65 min — past 1h
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TTL=0 disables caching (every call hits the API)', async () => {
    const { calls } = mockFetchReturning(15, 75);
    const client = makeClient({ pricingCacheTtlMs: 0 });

    for (let i = 0; i < 5; i++) {
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
    }
    expect(calls()).toBe(5);
  });

  it('TTL applies per (provider, model) pair independently', async () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockFetchReturning(15, 75);
      const client = makeClient({ pricingCacheTtlMs: 60_000 });

      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      // Different pair — cache miss regardless of TTL.
      await client.resolvePricing('openai', 'gpt-4o');
      expect(calls()).toBe(2);

      // Within TTL — both hit the cache.
      vi.advanceTimersByTime(30_000);
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      await client.resolvePricing('openai', 'gpt-4o');
      expect(calls()).toBe(2);

      // Past TTL — both refetch.
      vi.advanceTimersByTime(60_000);
      await client.resolvePricing('anthropic', 'claude-opus-4-7');
      await client.resolvePricing('openai', 'gpt-4o');
      expect(calls()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
