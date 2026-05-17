/**
 * Unit tests for the LangGraph SensuLangGraphHandler.
 *
 * The detection logic lives in SensuCallbackHandler.handleChainStart — when
 * the optional `metadata` arg contains `langgraph_node`, the step is tagged
 * `step_type='langgraph_node'` with the node name. Tests verify both the
 * standalone LangGraph class and the parent class's auto-detection path.
 */
import { describe, expect, it } from 'vitest';
import { SensuCallbackHandler } from '../src/integrations/langchain.js';
import { SensuLangGraphHandler } from '../src/integrations/langgraph.js';

interface CapturedEvent {
  event_type: string;
  [k: string]: unknown;
}

function makeFakeClient() {
  const events: CapturedEvent[] = [];
  return {
    enqueue: (e: CapturedEvent) => { events.push(e); },
    events,
    orgId: 'org-test',
    agentId: 'agent-test',
  };
}

describe('SensuLangGraphHandler — basic identity', () => {
  it('reports name="sensu_langgraph_handler" for LangChain debug output', () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    expect(handler.name).toBe('sensu_langgraph_handler');
  });

  it('IS a BaseCallbackHandler instance (passes LangChain runtime check)', () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    // The duck-type check LangChain performs at runtime
    expect(typeof handler.copy).toBe('function');
    expect(typeof handler.name).toBe('string');
    expect(typeof handler.awaitHandlers).toBe('boolean');
  });

  it('copy() returns a working SensuLangGraphHandler that shares run identity', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    const cloned = handler.copy();
    expect(cloned).toBeDefined();
    await cloned.handleChainStart({} as never, {}, 'chain-x');
    expect(client.events.length).toBeGreaterThan(0);
  });
});

describe('LangGraph node detection in handleChainStart', () => {
  it('emits step_type="langgraph_node" with node_name when metadata.langgraph_node is set', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      { messages: [] },
      'node-runid',
      undefined,
      ['langgraph'],
      { langgraph_node: 'researcher', langgraph_step: 2 },
    );
    expect(client.events).toHaveLength(1);
    expect(client.events[0]).toMatchObject({
      event_type: 'agent.step.started',
      step_type: 'langgraph_node',
      node_name: 'researcher',
      langgraph_step: 2,
    });
  });

  it('falls back to step_type="chain" when no langgraph_node in metadata', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'plain-chain-runid',
      undefined,
      [],
      { not_langgraph: 'something' },
    );
    expect(client.events[0]).toMatchObject({
      event_type: 'agent.step.started',
      step_type: 'chain',
    });
    expect(client.events[0].node_name).toBeUndefined();
    expect(client.events[0].langgraph_step).toBeUndefined();
  });

  it('omits langgraph_step when only langgraph_node is present', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'rid',
      undefined,
      undefined,
      { langgraph_node: 'writer' },
    );
    expect(client.events[0]).toMatchObject({
      step_type: 'langgraph_node',
      node_name: 'writer',
    });
    expect(client.events[0].langgraph_step).toBeUndefined();
  });

  it('parent SensuCallbackHandler also auto-detects LangGraph nodes', async () => {
    // Important: customers using just the LangChain handler in a mixed
    // LangChain + LangGraph project should still get langgraph_node steps.
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuCallbackHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'mixed-rid',
      undefined,
      undefined,
      { langgraph_node: 'analyst' },
    );
    expect(client.events[0]).toMatchObject({
      step_type: 'langgraph_node',
      node_name: 'analyst',
    });
  });
});

describe('LangGraph hidden-tag filtering (channel-write wrappers)', () => {
  it('skips chain start when tags contain "langsmith:hidden" AND langgraph_node is present', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'hidden-runid',
      undefined,
      ['langsmith:hidden'],
      { langgraph_node: 'plan_step' },
    );
    expect(client.events).toHaveLength(0);
  });

  it('skips the matching chain end so no dangling agent.step.completed fires', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'hidden-rid',
      undefined,
      ['langsmith:hidden'],
      { langgraph_node: 'writer' },
    );
    await handler.handleChainEnd({}, 'hidden-rid');
    expect(client.events).toHaveLength(0);
  });

  it('still emits when hidden tag present but no langgraph_node (plain chain)', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'plain-hidden',
      undefined,
      ['langsmith:hidden'],
      undefined,
    );
    // No langgraph_node → we don't have a clear "is this just plumbing"
    // signal, so fall through to the standard chain step.
    expect(client.events).toHaveLength(1);
    expect(client.events[0].step_type).toBe('chain');
  });
});

describe('LangGraph node lifecycle pairs end events correctly', () => {
  it('chain end after a langgraph_node start uses the same step_id', async () => {
    const client = makeFakeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = new SensuLangGraphHandler({ client: client as any });
    await handler.handleChainStart(
      {} as never,
      {},
      'node-1',
      undefined,
      undefined,
      { langgraph_node: 'planner' },
    );
    await handler.handleChainEnd({}, 'node-1');
    const start = client.events.find((e) => e.event_type === 'agent.step.started');
    const end = client.events.find((e) => e.event_type === 'agent.step.completed');
    expect(start?.step_id).toBeDefined();
    expect(end?.step_id).toBe(start?.step_id);
  });
});
