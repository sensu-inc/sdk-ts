/**
 * LangChain callback handler for Sensu telemetry.
 *
 * Drop into any LangChain chain, agent, or LLM via the `callbacks` array
 * to capture LLM calls, tool calls, streaming TTFT, retry/fallback chains,
 * and chain step boundaries automatically.
 *
 * Usage:
 *   import { SensuClient } from '@sensu-ai/sdk';
 *   import { SensuCallbackHandler } from '@sensu-ai/sdk/integrations/langchain';
 *
 *   const sensu = new SensuClient({ apiKey: '...', agentId: 'my-agent' });
 *   const handler = new SensuCallbackHandler({ client: sensu });
 *
 *   const chain = new LLMChain({ llm, prompt, callbacks: [handler] });
 *   await chain.invoke({ input }, { callbacks: [handler] });
 *
 * Requires `langchain` as a peer dependency (>=0.1.0). Install separately:
 *   npm install langchain
 */

import { randomUUID } from 'crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import type { SensuClient } from '../client.js';

interface LangChainCallbackHandlerOptions {
  client: SensuClient;
  sessionId?: string;
  runId?: string;
}

export class SensuCallbackHandler extends BaseCallbackHandler {
  // Required by BaseCallbackHandler — surfaced in LangChain debug output.
  name = 'sensu_callback_handler';
  awaitHandlers = true;

  private readonly client: SensuClient;
  private readonly sessionId: string;
  private runId: string;
  private traceId: string;
  private startTimes: Map<string, number> = new Map();
  private toolStartTimes: Map<string, number> = new Map();
  private stepIds: Map<string, string> = new Map();
  // Streaming: track first-token time and token counts per LLM run
  private firstTokenTimes: Map<string, number> = new Map();
  private streamTokenCounts: Map<string, number> = new Map();
  private llmCallIds: Map<string, string> = new Map();
  // Carry model + provider from start to end so completion events aren't 'unknown'
  private llmModels: Map<string, string> = new Map();
  private llmProviders: Map<string, string> = new Map();
  private static readonly STREAM_EMIT_EVERY = 10;
  // Retry + fallback tracking
  private toolCallIds: Map<string, string> = new Map();        // runId → toolCallId
  private toolNames: Map<string, string> = new Map();          // runId → toolName
  private lastToolCallIdByName: Map<string, string> = new Map(); // toolName → last callId
  private failedToolCallIds: Set<string> = new Set();          // callIds that errored
  private lastLlmErrored = false;

  constructor(opts: LangChainCallbackHandlerOptions) {
    super();
    this.client = opts.client;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.runId = opts.runId ?? randomUUID();
    this.traceId = randomUUID();
  }

  /**
   * Required by LangChain's runtime check (`isBaseCallbackHandler`). Returns
   * a handler that emits to the same SensuClient, so a cloned chain context
   * shares the run identity.
   */
  copy(): SensuCallbackHandler {
    return new SensuCallbackHandler({
      client: this.client,
      sessionId: this.sessionId,
      runId: this.runId,
    });
  }

  private base(spanId?: string) {
    return {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      org_id: (this.client as unknown as { orgId: string }).orgId,
      agent_id: (this.client as unknown as { agentId: string }).agentId,
      session_id: this.sessionId,
      run_id: this.runId,
      trace_id: this.traceId,
      span_id: spanId ?? randomUUID(),
    };
  }

  // Called when a chain starts
  async handleChainStart(_chain: Serialized, _inputs: Record<string, unknown>, runId: string) {
    const stepId = randomUUID();
    this.stepIds.set(runId, stepId);
    this.client.enqueue({
      ...this.base(randomUUID()),
      step_id: stepId,
      event_type: 'agent.step.started',
      step_type: 'chain',
      sequence: 0,
    });
  }

  // Called when a chain ends
  async handleChainEnd(_outputs: Record<string, unknown>, runId: string) {
    const stepId = this.stepIds.get(runId);
    this.client.enqueue({
      ...this.base(),
      step_id: stepId,
      event_type: 'agent.step.completed',
    });
    this.stepIds.delete(runId);
  }

  // Called when an LLM starts
  async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
  ) {
    const llmCallId = randomUUID();
    this.startTimes.set(runId, Date.now());
    this.llmCallIds.set(runId, llmCallId);
    this.streamTokenCounts.delete(runId);
    this.firstTokenTimes.delete(runId);

    const isFallback = this.lastLlmErrored;
    this.lastLlmErrored = false;

    // Serialized.id is the class path, e.g. ['langchain_core', 'language_models', 'chat_models', 'ChatAnthropic'].
    // The last element is the most specific class name. Fall back to `name` then 'unknown'.
    const idTail = Array.isArray(llm.id) ? llm.id[llm.id.length - 1] : undefined;
    const model = idTail ?? llm.name ?? 'unknown';
    const provider = inferProvider(model);
    this.llmModels.set(runId, model);
    this.llmProviders.set(runId, provider);

    this.client.enqueue({
      ...this.base(),
      event_type: 'llm.request.started',
      provider,
      model,
      is_fallback: isFallback || undefined,
    });
  }

  // Called for each streaming token (LangChain v0.2+)
  async handleLLMNewToken(_token: string, _idx: { prompt: number; completion: number } | undefined, runId: string) {
    const now = Date.now();
    if (!this.firstTokenTimes.has(runId)) {
      this.firstTokenTimes.set(runId, now);
    }
    const count = (this.streamTokenCounts.get(runId) ?? 0) + 1;
    this.streamTokenCounts.set(runId, count);

    if (count % SensuCallbackHandler.STREAM_EMIT_EVERY === 0) {
      const startMs = this.startTimes.get(runId);
      const firstTokenMs = this.firstTokenTimes.get(runId);
      const ttftMs = startMs && firstTokenMs ? firstTokenMs - startMs : undefined;
      const llmCallId = this.llmCallIds.get(runId);
      (this.client.enqueue as (e: unknown) => void)({
        ...this.base(),
        event_type: 'stream.token.received',
        llm_call_id: llmCallId,
        tokens_so_far: count,
        ttft_ms: ttftMs,
      });
    }
  }

  // Called when an LLM ends
  async handleLLMEnd(output: LLMResult, runId: string) {
    const startMs = this.startTimes.get(runId);
    const latencyMs = startMs ? Date.now() - startMs : undefined;
    const firstTokenMs = this.firstTokenTimes.get(runId);
    const ttftMs = startMs && firstTokenMs ? firstTokenMs - startMs : undefined;
    const isStreamed = this.streamTokenCounts.has(runId);

    // Prefer the model name resolved at generation time (more specific than
    // the LangChain class name we captured at start), fall back to start.
    const endModel = output.generations?.[0]?.[0]?.generationInfo?.['model'] as string | undefined;
    const model = endModel ?? this.llmModels.get(runId) ?? 'unknown';
    const provider = inferProvider(endModel ?? '') !== 'langchain'
      ? inferProvider(endModel ?? '')
      : this.llmProviders.get(runId) ?? 'langchain';

    this.startTimes.delete(runId);
    this.firstTokenTimes.delete(runId);
    this.streamTokenCounts.delete(runId);
    this.llmCallIds.delete(runId);
    this.llmModels.delete(runId);
    this.llmProviders.delete(runId);

    // Extract token usage from llmOutput if available
    const usage = output.llmOutput?.['tokenUsage'] as Record<string, number> | undefined;

    this.client.enqueue({
      ...this.base(),
      event_type: 'llm.request.completed',
      provider,
      model,
      latency_ms: latencyMs,
      ttft_ms: ttftMs,
      streamed: isStreamed,
      status: 'success',
      input_tokens: usage?.['promptTokens'],
      output_tokens: usage?.['completionTokens'],
      total_tokens: usage?.['totalTokens'],
    });
  }

  // Called when an LLM errors
  async handleLLMError(_err: unknown, runId: string) {
    const startMs = this.startTimes.get(runId);
    const latencyMs = startMs ? Date.now() - startMs : undefined;
    const model = this.llmModels.get(runId) ?? 'unknown';
    const provider = this.llmProviders.get(runId) ?? 'langchain';

    this.startTimes.delete(runId);
    this.firstTokenTimes.delete(runId);
    this.streamTokenCounts.delete(runId);
    this.llmCallIds.delete(runId);
    this.llmModels.delete(runId);
    this.llmProviders.delete(runId);
    this.lastLlmErrored = true;

    this.client.enqueue({
      ...this.base(),
      event_type: 'llm.request.completed',
      provider,
      model,
      latency_ms: latencyMs,
      status: 'error',
    });
  }

  // Called when a tool starts
  async handleToolStart(tool: Serialized, _input: string, runId: string) {
    const idTail = Array.isArray(tool.id) ? tool.id[tool.id.length - 1] : undefined;
    const toolName = (tool as Serialized & { name?: string }).name ?? idTail ?? 'unknown';
    const toolCallId = randomUUID();

    this.toolStartTimes.set(runId, Date.now());
    this.toolCallIds.set(runId, toolCallId);
    this.toolNames.set(runId, toolName);

    // Detect retry: same tool was called before and that call failed
    const prevCallId = this.lastToolCallIdByName.get(toolName);
    const retryOf = prevCallId && this.failedToolCallIds.has(prevCallId) ? prevCallId : undefined;
    this.lastToolCallIdByName.set(toolName, toolCallId);

    (this.client.enqueue as (e: unknown) => void)({
      ...this.base(),
      event_type: 'tool.call.started',
      tool_name: toolName,
      tool_call_id: toolCallId,
      retry_of: retryOf,
    });
  }

  // Called when a tool ends
  async handleToolEnd(output: string, runId: string) {
    const startMs = this.toolStartTimes.get(runId);
    const latencyMs = startMs ? Date.now() - startMs : undefined;
    const toolCallId = this.toolCallIds.get(runId);
    const toolName = this.toolNames.get(runId) ?? 'unknown';
    this.toolStartTimes.delete(runId);
    this.toolCallIds.delete(runId);
    this.toolNames.delete(runId);

    (this.client.enqueue as (e: unknown) => void)({
      ...this.base(),
      event_type: 'tool.call.completed',
      tool_name: toolName,
      latency_ms: latencyMs,
      status: 'success',
      output_size_bytes: Buffer.byteLength(output ?? '', 'utf8'),
      tool_call_id: toolCallId,
    });
  }

  // Called when a tool errors
  async handleToolError(_err: unknown, runId: string) {
    const startMs = this.toolStartTimes.get(runId);
    const latencyMs = startMs ? Date.now() - startMs : undefined;
    const toolCallId = this.toolCallIds.get(runId);
    const toolName = this.toolNames.get(runId) ?? 'unknown';
    this.toolStartTimes.delete(runId);
    this.toolCallIds.delete(runId);
    this.toolNames.delete(runId);

    if (toolCallId) this.failedToolCallIds.add(toolCallId);

    (this.client.enqueue as (e: unknown) => void)({
      ...this.base(),
      event_type: 'tool.call.completed',
      tool_name: toolName,
      latency_ms: latencyMs,
      status: 'error',
      tool_call_id: toolCallId,
    });
  }
}

// Map LangChain LLM class names to Sensu provider strings
function inferProvider(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('anthropic') || n.includes('claude')) return 'anthropic';
  if (n.includes('openai') || n.includes('gpt') || n.includes('chatgpt')) return 'openai';
  if (n.includes('google') || n.includes('gemini') || n.includes('vertex')) return 'google';
  if (n.includes('ollama') || n.includes('local')) return 'local';
  if (n.includes('bedrock')) return 'aws';
  if (n.includes('cohere')) return 'cohere';
  if (n.includes('mistral')) return 'mistral';
  return 'langchain';
}
