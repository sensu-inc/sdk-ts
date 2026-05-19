/**
 * Tests for client.registerAgentVersion() — the eval-gated CI/CD (§5.2)
 * convenience helper that wraps POST /api/v1/agents/:id/versions.
 * Mocks global fetch; no live server required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SensuClient } from '../src/index.js';

interface CapturedRequest {
  url:    string;
  method: string;
  apiKey: string;
  body:   Record<string, unknown>;
}

function makeClient(): SensuClient {
  return new SensuClient({
    apiKey:             'test-key',
    baseUrl:            'http://localhost:9999',
    agentId:            'agent-1',
    orgId:              'org-1',
    batchSize:          100,
    flushIntervalMs:    999_999,
    disableLivePricing: true,
  });
}

function mockFetchOk(payload: Record<string, unknown>): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      apiKey: (init.headers as Record<string, string>)['X-API-Key'] ?? '',
      body:   JSON.parse(init.body as string),
    });
    return new Response(JSON.stringify(payload), { status: 201 });
  });
  // @ts-expect-error — overriding global fetch in test
  globalThis.fetch = fetchMock;
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SensuClient.registerAgentVersion', () => {
  it('POSTs {sha, config} to /api/v1/agents/:id/versions with API key', async () => {
    const { calls } = mockFetchOk({
      id:        'ver_xyz123',
      agentId:   'org-1:cust-support-v3',
      sha:       'a1b2c3d4',
      config:    { systemPrompt: 'tighter rules', model: 'claude-sonnet-4-6' },
      createdAt: '2026-05-19T12:00:00.000Z',
    });
    const client = makeClient();

    const res = await client.registerAgentVersion({
      agentId: 'cust-support-v3',
      sha:     'a1b2c3d4',
      config:  { systemPrompt: 'tighter rules', model: 'claude-sonnet-4-6' },
    });

    expect(res).not.toBeNull();
    expect(res!.id).toBe('ver_xyz123');
    expect(res!.agentId).toBe('org-1:cust-support-v3');
    expect(res!.sha).toBe('a1b2c3d4');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'http://localhost:9999/api/v1/agents/cust-support-v3/versions',
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.apiKey).toBe('test-key');
    expect(calls[0]!.body).toEqual({
      sha:    'a1b2c3d4',
      config: { systemPrompt: 'tighter rules', model: 'claude-sonnet-4-6' },
    });
  });

  it('URL-encodes agentId so labels containing reserved chars round-trip', async () => {
    const { calls } = mockFetchOk({
      id:        'ver_1',
      agentId:   'org-1:agent/with/slashes',
      sha:       'sha',
      config:    { systemPrompt: 'p' },
      createdAt: '2026-05-19T00:00:00.000Z',
    });
    const client = makeClient();

    await client.registerAgentVersion({
      agentId: 'agent/with/slashes',
      sha:     'sha',
      config:  { systemPrompt: 'p' },
    });

    expect(calls[0]!.url).toBe(
      'http://localhost:9999/api/v1/agents/agent%2Fwith%2Fslashes/versions',
    );
  });

  it('returns null on non-2xx and logs', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => new Response('Agent not found', { status: 404 }));
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();

    const res = await client.registerAgentVersion({
      agentId: 'missing',
      sha:     'x',
      config:  { systemPrompt: 'p' },
    });
    expect(res).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
  });

  it('returns null on network error and logs', async () => {
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();

    const res = await client.registerAgentVersion({
      agentId: 'a',
      sha:     's',
      config:  { systemPrompt: 'p' },
    });
    expect(res).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
  });

  it('short-circuits to null when client is disabled', async () => {
    const fetchMock = vi.fn();
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = fetchMock;
    const client = new SensuClient({ apiKey: 'k', disabled: true });

    const res = await client.registerAgentVersion({
      agentId: 'a', sha: 's', config: { systemPrompt: 'p' },
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('short-circuits to null when apiKey is missing', async () => {
    const fetchMock = vi.fn();
    // @ts-expect-error — overriding global fetch
    globalThis.fetch = fetchMock;
    const client = new SensuClient({ apiKey: '' });

    const res = await client.registerAgentVersion({
      agentId: 'a', sha: 's', config: { systemPrompt: 'p' },
    });
    expect(res).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
