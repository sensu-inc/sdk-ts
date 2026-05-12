/**
 * Tests for `captureMessageBodies` — when false (default) the SDK MUST
 * strip `body` from every message before flushing; when true the body is
 * preserved and oversize bodies are capped at the server schema limit.
 *
 * This is the wire contract behind the Replay v1 unmask flow. If you
 * break it, see planning/REPLAY_V1_PLAN.md §7.
 */
import { describe, expect, it } from 'vitest';
import { SensuClient } from '../src/index.js';
import type { MessageSnapshotItem } from '../src/types.js';

function makeClient(captureMessageBodies: boolean): SensuClient {
  return new SensuClient({
    apiKey:           'test-key',
    baseUrl:          'http://localhost:9999',
    agentId:          'agent-1',
    orgId:            'org-1',
    batchSize:        100,
    flushIntervalMs:  999_999,
    disableLivePricing: true,
    captureMessageBodies,
  });
}

const sample = (body?: string): MessageSnapshotItem => ({
  role:         'user',
  token_count:  5,
  content_hash: 'h1',
  body,
});

describe('sanitizeMessagesSnapshot', () => {
  it('strips `body` from every message when captureMessageBodies is false (default)', () => {
    const client = makeClient(false);
    const out = client.sanitizeMessagesSnapshot([
      sample('hello'),
      sample('world'),
      sample(undefined),
    ]);
    expect(out).toHaveLength(3);
    for (const m of out) {
      expect(m).not.toHaveProperty('body');
    }
  });

  it('preserves `body` when captureMessageBodies is true', () => {
    const client = makeClient(true);
    const out = client.sanitizeMessagesSnapshot([
      sample('hello'),
      sample(''),
      sample(undefined),
    ]);
    expect(out[0]!.body).toBe('hello');
    expect(out[1]!.body).toBe('');
    expect(out[2]!.body).toBeUndefined();
  });

  it('caps body length at 65,536 chars to match the server schema', () => {
    const client = makeClient(true);
    const giant = 'x'.repeat(80_000);
    const out = client.sanitizeMessagesSnapshot([sample(giant)]);
    expect(out[0]!.body!.length).toBe(65_536);
  });

  it('preserves non-body fields whether or not capture is on', () => {
    const m: MessageSnapshotItem = {
      role:         'assistant',
      tool_name:    'search',
      token_count:  42,
      content_hash: 'abc123',
      body:         'sensitive',
    };
    const off = makeClient(false).sanitizeMessagesSnapshot([m])[0]!;
    expect(off.role).toBe('assistant');
    expect(off.tool_name).toBe('search');
    expect(off.token_count).toBe(42);
    expect(off.content_hash).toBe('abc123');

    const on = makeClient(true).sanitizeMessagesSnapshot([m])[0]!;
    expect(on.body).toBe('sensitive');
  });
});
