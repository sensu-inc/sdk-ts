/**
 * Tests for the run-less feedback() and score() helpers on SensuClient.
 * Mocks global fetch and asserts the wire format hitting /api/v1/feedback
 * and /api/v1/eval-scores. No live server required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensuClient } from '../src/index.js';

interface CapturedRequest {
  url: string;
  method: string;
  apiKey: string;
  body: Record<string, unknown>;
}

function makeClient(): SensuClient {
  return new SensuClient({
    apiKey: 'test-key',
    baseUrl: 'http://localhost:9999',
    agentId: 'agent-1',
    orgId: 'org-1',
    batchSize: 100,
    flushIntervalMs: 999_999,
    disableLivePricing: true,
  });
}

function mockFetchOk(id: string): { fetchMock: ReturnType<typeof vi.fn>; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      apiKey: (init.headers as Record<string, string>)['X-API-Key'] ?? '',
      body: JSON.parse(init.body as string),
    });
    return new Response(JSON.stringify({ id }), { status: 201 });
  });
  // @ts-expect-error — overriding global fetch in test
  globalThis.fetch = fetchMock;
  return { fetchMock, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SensuClient.feedback', () => {
  it('POSTs camelCase body to /api/v1/feedback with API key', async () => {
    const { calls } = mockFetchOk('fb_123');
    const client = makeClient();

    const res = await client.feedback({
      runId:     'run-abc',
      type:      'thumbs_down',
      score:     0.2,
      comment:   'missed the point',
      endUserId: 'user-77',
    });

    expect(res).toEqual({ id: 'fb_123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:9999/api/v1/feedback');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.apiKey).toBe('test-key');
    expect(calls[0]!.body).toEqual({
      runId:     'run-abc',
      type:      'thumbs_down',
      score:     0.2,
      comment:   'missed the point',
      endUserId: 'user-77',
    });
  });

  it('returns null on non-2xx', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => new Response('Run not found', { status: 404 }));
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();

    const res = await client.feedback({ runId: 'missing', type: 'thumbs_up' });
    expect(res).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
  });

  it('short-circuits to null when client is disabled', async () => {
    const fetchMock = vi.fn();
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = fetchMock;
    const client = new SensuClient({ apiKey: 'k', disabled: true });

    const res = await client.feedback({ runId: 'r', type: 'thumbs_up' });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SensuClient.score', () => {
  it('POSTs camelCase body to /api/v1/eval-scores', async () => {
    const { calls } = mockFetchOk('es_999');
    const client = makeClient();

    const res = await client.score({
      runId:            'run-abc',
      metric:           'helpfulness',
      score:            0.83,
      evaluatorId:      'human-v1',
      modelUsedForEval: 'claude-haiku-4-5',
      stepId:           'step-1',
      llmCallId:        'call-1',
    });

    expect(res).toEqual({ id: 'es_999' });
    expect(calls[0]!.url).toBe('http://localhost:9999/api/v1/eval-scores');
    expect(calls[0]!.body).toEqual({
      runId:            'run-abc',
      metric:           'helpfulness',
      score:            0.83,
      evaluatorId:      'human-v1',
      modelUsedForEval: 'claude-haiku-4-5',
      stepId:           'step-1',
      llmCallId:        'call-1',
    });
  });

  it('returns null on network error', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();

    const res = await client.score({ runId: 'r', metric: 'm', score: 0.5 });
    expect(res).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
  });
});
