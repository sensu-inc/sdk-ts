/**
 * Unit tests for the LangChain SensuCallbackHandler.
 *
 * The handler is duck-typed against LangChain's BaseCallbackHandler interface;
 * tests invoke its methods directly with the args LangChain would supply, and
 * assert that the resulting events on the SensuClient queue match the
 * documented wire format. No real LangChain dependency required at test time.
 */
import { describe, expect, it } from 'vitest';
import { SensuCallbackHandler } from '../src/integrations/langchain.js';

interface CapturedEvent {
  event_type: string;
  [k: string]: unknown;
}

/** Minimal stub that captures every enqueue call. */
function makeFakeClient(): { enqueue: (e: CapturedEvent) => void; events: CapturedEvent[]; orgId: string; agentId: string } {
  const events: CapturedEvent[] = [];
  return {
    enqueue: (e: CapturedEvent) => { events.push(e); },
    events,
    orgId: 'org-test',
    agentId: 'agent-test',
  };
}

function makeHandler() {
  const client = makeFakeClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = new SensuCallbackHandler({ client: client as any });
  return { handler, client };
}

describe('SensuCallbackHandler — chain lifecycle', () => {
  it('emits agent.step.started on chain start', async () => {
    const { handler, client } = makeHandler();
    await handler.handleChainStart({}, {}, 'chain-1');
    expect(client.events).toHaveLength(1);
    expect(client.events[0]).toMatchObject({
      event_type: 'agent.step.started',
      step_type: 'chain',
      sequence: 0,
    });
    expect(client.events[0].step_id).toBeDefined();
  });

  it('emits agent.step.completed on chain end with matching step_id', async () => {
    const { handler, client } = makeHandler();
    await handler.handleChainStart({}, {}, 'chain-2');
    const startedStepId = client.events[0].step_id;
    await handler.handleChainEnd({}, 'chain-2');
    expect(client.events).toHaveLength(2);
    expect(client.events[1]).toMatchObject({
      event_type: 'agent.step.completed',
      step_id: startedStepId,
    });
  });
});

describe('SensuCallbackHandler — LLM lifecycle', () => {
  it('emits llm.request.started with provider inferred from name', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatAnthropic' }, [], 'llm-1');
    expect(client.events).toHaveLength(1);
    expect(client.events[0]).toMatchObject({
      event_type: 'llm.request.started',
      provider: 'anthropic',
      model: 'ChatAnthropic',
    });
    expect(client.events[0].is_fallback).toBeUndefined();
  });

  it('infers openai provider for ChatOpenAI / gpt-* names', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatOpenAI' }, [], 'llm-a');
    await handler.handleLLMStart({ name: 'gpt-4o-mini' }, [], 'llm-b');
    expect(client.events[0].provider).toBe('openai');
    expect(client.events[1].provider).toBe('openai');
  });

  it('emits llm.request.completed with model + provider preserved from start', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatAnthropic' }, [], 'llm-2');
    await handler.handleLLMEnd(
      {
        generations: [[{ text: 'hello' }]],
        llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      },
      'llm-2',
    );
    expect(client.events).toHaveLength(2);
    expect(client.events[1]).toMatchObject({
      event_type: 'llm.request.completed',
      provider: 'anthropic',
      model: 'ChatAnthropic',
      status: 'success',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
    expect(client.events[1].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('prefers the model name from generationInfo when present', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatAnthropic' }, [], 'llm-3');
    await handler.handleLLMEnd(
      {
        generations: [[{ text: 'hi', generationInfo: { model: 'claude-sonnet-4-6' } }]],
        llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      },
      'llm-3',
    );
    expect(client.events[1]).toMatchObject({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
  });

  it('marks status=error on handleLLMError and carries forward model + provider', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatOpenAI' }, [], 'llm-4');
    await handler.handleLLMError(new Error('boom'), 'llm-4');
    expect(client.events).toHaveLength(2);
    expect(client.events[1]).toMatchObject({
      event_type: 'llm.request.completed',
      status: 'error',
      model: 'ChatOpenAI',
      provider: 'openai',
    });
  });

  it('tags the next LLM start as is_fallback after an error', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatOpenAI' }, [], 'llm-5a');
    await handler.handleLLMError(new Error('boom'), 'llm-5a');
    await handler.handleLLMStart({ name: 'ChatAnthropic' }, [], 'llm-5b');
    const fallbackStart = client.events.find(
      (e) => e.event_type === 'llm.request.started' && e.is_fallback === true,
    );
    expect(fallbackStart).toBeDefined();
    expect(fallbackStart?.model).toBe('ChatAnthropic');
  });

  it('only emits stream.token.received every Nth token', async () => {
    const { handler, client } = makeHandler();
    await handler.handleLLMStart({ name: 'ChatAnthropic' }, [], 'llm-stream');
    for (let i = 0; i < 25; i++) {
      await handler.handleLLMNewToken('x', null, 'llm-stream');
    }
    const streamEvents = client.events.filter((e) => e.event_type === 'stream.token.received');
    // STREAM_EMIT_EVERY = 10 → emit at 10, 20 → 2 events
    expect(streamEvents).toHaveLength(2);
    expect(streamEvents[0]).toMatchObject({ tokens_so_far: 10 });
    expect(streamEvents[1]).toMatchObject({ tokens_so_far: 20 });
    expect(streamEvents[0].llm_call_id).toBeDefined();
  });
});

describe('SensuCallbackHandler — tool lifecycle', () => {
  it('emits tool.call.started + tool.call.completed with matching tool_call_id', async () => {
    const { handler, client } = makeHandler();
    await handler.handleToolStart({ name: 'web_search' }, 'cats', 'tool-1');
    await handler.handleToolEnd('cat results', 'tool-1');
    const start = client.events.find((e) => e.event_type === 'tool.call.started');
    const end = client.events.find((e) => e.event_type === 'tool.call.completed');
    expect(start).toMatchObject({ tool_name: 'web_search' });
    expect(end).toMatchObject({
      tool_name: 'web_search',
      status: 'success',
      tool_call_id: start?.tool_call_id,
    });
    expect(end?.output_size_bytes).toBe(Buffer.byteLength('cat results', 'utf8'));
  });

  it('marks retry_of when the same tool was called and previously errored', async () => {
    const { handler, client } = makeHandler();
    await handler.handleToolStart({ name: 'flaky_tool' }, 'q', 'tool-r1');
    const firstId = client.events.at(-1)?.tool_call_id;
    await handler.handleToolError(new Error('timeout'), 'tool-r1');
    await handler.handleToolStart({ name: 'flaky_tool' }, 'q', 'tool-r2');
    const retryStart = client.events.at(-1);
    expect(retryStart).toMatchObject({
      event_type: 'tool.call.started',
      tool_name: 'flaky_tool',
      retry_of: firstId,
    });
  });

  it('does not mark retry_of when previous tool call succeeded', async () => {
    const { handler, client } = makeHandler();
    await handler.handleToolStart({ name: 'good_tool' }, 'q', 'tool-g1');
    await handler.handleToolEnd('ok', 'tool-g1');
    await handler.handleToolStart({ name: 'good_tool' }, 'q', 'tool-g2');
    const secondStart = client.events.filter((e) => e.event_type === 'tool.call.started').at(-1);
    expect(secondStart?.retry_of).toBeUndefined();
  });

  it('emits status=error on handleToolError', async () => {
    const { handler, client } = makeHandler();
    await handler.handleToolStart({ name: 'broken' }, 'q', 'tool-e1');
    await handler.handleToolError(new Error('bad'), 'tool-e1');
    const end = client.events.find((e) => e.event_type === 'tool.call.completed');
    expect(end).toMatchObject({ status: 'error', tool_name: 'broken' });
  });
});

describe('SensuCallbackHandler — base event fields', () => {
  it('includes session_id, run_id, trace_id, org_id, agent_id on every event', async () => {
    const { handler, client } = makeHandler();
    await handler.handleChainStart({}, {}, 'c-1');
    const event = client.events[0];
    expect(event.session_id).toBeDefined();
    expect(event.run_id).toBeDefined();
    expect(event.trace_id).toBeDefined();
    expect(event.org_id).toBe('org-test');
    expect(event.agent_id).toBe('agent-test');
    expect(event.event_id).toBeDefined();
    expect(event.timestamp).toBeDefined();
  });

  it('reuses the same session_id/run_id/trace_id across multiple events', async () => {
    const { handler, client } = makeHandler();
    await handler.handleChainStart({}, {}, 'c-x');
    await handler.handleLLMStart({ name: 'ChatAnthropic' }, [], 'l-x');
    await handler.handleToolStart({ name: 't' }, '', 't-x');
    const sessionIds = new Set(client.events.map((e) => e.session_id));
    const runIds = new Set(client.events.map((e) => e.run_id));
    const traceIds = new Set(client.events.map((e) => e.trace_id));
    expect(sessionIds.size).toBe(1);
    expect(runIds.size).toBe(1);
    expect(traceIds.size).toBe(1);
  });

  it('accepts custom sessionId / runId from constructor', async () => {
    const client = makeFakeClient();
    const handler = new SensuCallbackHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      sessionId: 'my-session',
      runId: 'my-run',
    });
    await handler.handleChainStart({}, {}, 'c-1');
    expect(client.events[0]).toMatchObject({
      session_id: 'my-session',
      run_id: 'my-run',
    });
  });
});
