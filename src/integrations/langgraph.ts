/**
 * LangGraph callback handler for Sensu telemetry.
 *
 * LangGraph builds on LangChain Core's callback system, so the existing
 * SensuCallbackHandler already captures LLM calls, tool calls, and step
 * boundaries inside a graph. This handler is a thin subclass that surfaces
 * a discoverable import path for LangGraph users and identifies itself as
 * such in LangChain's debug output. The actual `langgraph_node` detection
 * (which emits step_type='langgraph_node' with the node name) lives in the
 * shared LangChain handler so it works regardless of which class the
 * customer instantiates.
 *
 * Usage:
 *   import { SensuClient } from '@sensu-ai/sdk';
 *   import { SensuLangGraphHandler } from '@sensu-ai/sdk/integrations/langgraph';
 *   import { StateGraph } from '@langchain/langgraph';
 *
 *   const sensu = new SensuClient({ apiKey: '...', agentId: 'my-graph' });
 *   const handler = new SensuLangGraphHandler({ client: sensu });
 *
 *   const graph = new StateGraph({...}).addNode(...).compile();
 *   const result = await graph.invoke(input, { callbacks: [handler] });
 *
 * Requires `@langchain/langgraph` as a peer dependency (>=0.2.0). Install:
 *   npm install @langchain/langgraph
 *
 * For mixed LangChain + LangGraph projects, a single SensuLangGraphHandler
 * captures both: non-graph chains emit step_type='chain', graph nodes emit
 * step_type='langgraph_node' with the node name.
 */
import { SensuCallbackHandler } from './langchain.js';

export class SensuLangGraphHandler extends SensuCallbackHandler {
  // Surfaced in LangChain's debug output and trace dumps.
  override name = 'sensu_langgraph_handler';
}

export type { SensuCallbackHandler };
