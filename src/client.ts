import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { TelemetryEvent } from '@sensu-ai/shared';
import type {
  SensuClientOptions,
  StartRunOptions,
  StartStepOptions,
  TrackLlmOptions,
  TrackStreamingLlmOptions,
  TrackToolOptions,
  RawLlmCallOptions,
  TrackRetrievalOptions,
  RawRetrievalOptions,
  TrackEmbeddingOptions,
  RawEmbeddingOptions,
  RecordFeedbackOptions,
  RecordEvalScoreOptions,
  FeedbackOptions,
  ScoreOptions,
  HandoffOptions,
  SpawnRunOptions,
  TrackGuardrailOptions,
  RawGuardrailOptions,
  RecordPromptRenderOptions,
  DeployPromptVersionOptions,
  StartSessionOptions,
  ResumeSessionOptions,
  RetrievalChunkInput,
  MessageSnapshotItem,
  RegisterAgentVersionOptions,
  AgentVersion,
} from './types.js';

// Server-side enforces the same cap via z.string().max(65536) on
// MessageSnapshotItemSchema. Trim eagerly so a single oversized message
// doesn't reject the whole batch.
const MAX_BODY_CHARS = 65_536;

// Tool I/O body capture (TOOL_IO_CAPTURE_PLAN.md §5.1 + §11.3). 256 KB
// per field — wider than the LLM message cap because real tool outputs
// (JSON manifests, HTML excerpts) routinely run past 64 KB. Server
// enforces the same cap defensively via z.string().max(262144) on the
// tool.call.completed schema.
const MAX_TOOL_BODY_CHARS = 262_144;

// Cross-SDK truncation marker (TOOL_IO_CAPTURE_PLAN.md §5.4). The
// leading space is intentional — let it land on a word boundary so the
// inspector renders cleanly inline. Final body length stays at exactly
// MAX_TOOL_BODY_CHARS when truncation triggers.
const TRUNCATION_MARKER = ' …[truncated]';

/**
 * Serialize a tool call's input args + result for transport when the
 * caller opted in via `captureBodies: true`. Returns an object that
 * spreads cleanly into the `tool.call.completed` event payload:
 *
 *   - opt-out (default): empty object, neither body field emitted.
 *   - opt-in + both sides serialize: `{ input_body, output_body }`
 *     each ≤ 256 KB.
 *   - opt-in + either side fails (circular structure, BigInt, etc.)
 *     OR JSON.stringify returns undefined (e.g., a bare `undefined`
 *     args or result, a function-only result): empty object. We skip
 *     BOTH bodies rather than half-capturing so the server-side
 *     "snapshotMissing" affordance stays coherent
 *     (TOOL_IO_CAPTURE_PLAN.md §11.4).
 *
 * Exported for unit-testing the serialization rules without standing
 * up a full client + run + step + fetch mock.
 */
export function serializeToolBodiesForCapture(
  args: unknown,
  result: unknown,
  captureBodies: boolean | undefined,
): { input_body?: string; output_body?: string } {
  if (!captureBodies) return {};
  let inputBody: string | undefined;
  let outputBody: string | undefined;
  try {
    inputBody  = JSON.stringify(args);
    outputBody = JSON.stringify(result);
  } catch {
    return {};
  }
  // JSON.stringify returns undefined for `undefined`, functions, and
  // symbols. Treat as a serialization failure — skip both fields.
  if (typeof inputBody !== 'string' || typeof outputBody !== 'string') return {};
  return {
    input_body:  truncateToolBodyForTransport(inputBody),
    output_body: truncateToolBodyForTransport(outputBody),
  };
}

function truncateToolBodyForTransport(s: string): string {
  if (s.length <= MAX_TOOL_BODY_CHARS) return s;
  return s.slice(0, MAX_TOOL_BODY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// StepHandle — fluent API for a single step
// ---------------------------------------------------------------------------

export class StepHandle {
  private readonly client: SensuClient;
  readonly stepId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly traceId: string;
  readonly spanId: string;
  private sequence: number;
  private stepName?: string;
  private ended = false;

  constructor(
    client: SensuClient,
    opts: {
      stepId: string;
      runId: string;
      sessionId: string;
      agentId: string;
      orgId: string;
      traceId: string;
      spanId: string;
      sequence: number;
      name?: string;
    },
  ) {
    this.client = client;
    this.stepId = opts.stepId;
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.orgId = opts.orgId;
    this.traceId = opts.traceId;
    this.spanId = opts.spanId;
    this.sequence = opts.sequence;
    this.stepName = opts.name;
  }

  private base() {
    return {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: this.agentId,
      session_id: this.sessionId,
      run_id: this.runId,
      step_id: this.stepId,
      trace_id: this.traceId,
      span_id: randomUUID(),
      parent_span_id: this.spanId,
    };
  }

  /** Track an LLM call — wraps fn(), measures latency, emits event */
  async trackLlm(opts: TrackLlmOptions): Promise<unknown> {
    const startMs = Date.now();
    const spanId = randomUUID();
    const llmCallId = opts.llmCallId ?? randomUUID();

    this.client.enqueue({
      ...this.base(),
      span_id: spanId,
      event_type: 'llm.request.started',
      provider: opts.provider,
      model: opts.model,
      max_context_tokens: opts.maxContextTokens,
    });

    let result: unknown;
    let status: 'success' | 'error' = 'success';
    let err: unknown;

    try {
      result = await opts.fn();
    } catch (e) {
      status = 'error';
      err = e;
    }

    const latencyMs = Date.now() - startMs;

    // Try to extract token usage from common response shapes
    const usage = extractUsage(result, opts.model);
    const contextBreakdown = opts.extractContextBreakdown?.(result);

    // Override cost estimate with live pricing when tokens are known
    const inputTok = usage['input_tokens'] ?? 0;
    const outputTok = usage['output_tokens'] ?? 0;
    if (inputTok > 0 || outputTok > 0) {
      try {
        const [inputRate, outputRate] = await this.client.resolvePricing(opts.provider, opts.model);
        usage['cost_usd_estimate'] =
          (inputTok / 1_000_000) * inputRate + (outputTok / 1_000_000) * outputRate;
      } catch {
        // keep bundled estimate on failure
      }
    }

    (this.client.enqueue as (e: unknown) => void)({
      ...this.base(),
      span_id: spanId,
      event_type: 'llm.request.completed',
      llm_call_id: llmCallId,
      provider: opts.provider,
      model: opts.model,
      max_context_tokens: opts.maxContextTokens,
      latency_ms: latencyMs,
      status,
      ...usage,
      ...(contextBreakdown ? { context_breakdown: contextBreakdown } : {}),
      ...(opts.messagesSnapshot?.length
        ? { messages_snapshot: this.client.sanitizeMessagesSnapshot(opts.messagesSnapshot) }
        : {}),
      ...(opts.referencedChunkIds?.length ? { referenced_chunk_ids: opts.referencedChunkIds } : {}),
    });

    if (err) throw err;
    return result;
  }

  /**
   * Track a streaming LLM call — consumes the async iterable, measures TTFT,
   * and emits stream.token.received events as tokens arrive.
   * Returns the full concatenated text.
   */
  async trackStreamingLlm(opts: TrackStreamingLlmOptions): Promise<string> {
    const startMs = Date.now();
    const llmCallId = opts.llmCallId ?? randomUUID();
    const emitEvery = opts.emitEveryNTokens ?? 10;
    const spanId = randomUUID();

    this.client.enqueue({
      ...this.base(),
      span_id: spanId,
      event_type: 'llm.request.started',
      provider: opts.provider,
      model: opts.model,
      max_context_tokens: opts.maxContextTokens,
      stream: true,
    });

    let ttftMs: number | undefined;
    let tokenCount = 0;
    let accumulated = '';

    for await (const chunk of opts.stream) {
      // Capture time-to-first-token on the very first chunk
      if (ttftMs === undefined) {
        ttftMs = Date.now() - startMs;
      }

      // Extract text from common chunk shapes (Anthropic / OpenAI streaming)
      const text = extractStreamChunkText(chunk);
      if (text) {
        accumulated += text;
        tokenCount++;
      }

      // Emit stream.token.received every N tokens
      if (tokenCount > 0 && tokenCount % emitEvery === 0) {
        (this.client.enqueue as (e: unknown) => void)({
          ...this.base(),
          event_type: 'stream.token.received',
          llm_call_id: llmCallId,
          tokens_so_far: tokenCount,
          ttft_ms: ttftMs,
        });
      }
    }

    const latencyMs = Date.now() - startMs;

    (this.client.enqueue as (e: unknown) => void)({
      ...this.base(),
      span_id: spanId,
      event_type: 'llm.request.completed',
      llm_call_id: llmCallId,
      provider: opts.provider,
      model: opts.model,
      max_context_tokens: opts.maxContextTokens,
      latency_ms: latencyMs,
      ttft_ms: ttftMs,
      streamed: true,
      status: 'success',
    });

    opts.onComplete?.(accumulated, ttftMs);
    return accumulated;
  }

  /** Emit a raw LLM call event (when you have the stats already) */
  recordLlm(opts: RawLlmCallOptions): void {
    this.client.enqueue({
      ...this.base(),
      event_type: 'llm.request.completed',
      provider: opts.provider,
      model: opts.model,
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cached_input_tokens: opts.cachedInputTokens,
      total_tokens: opts.totalTokens,
      max_context_tokens: opts.maxContextTokens,
      context_used_tokens: opts.contextUsedTokens,
      latency_ms: opts.latencyMs,
      ttft_ms: opts.ttftMs,
      cost_usd_estimate: opts.costUsdEstimate,
      status: opts.status,
      ...(opts.contextBreakdown ? { context_breakdown: opts.contextBreakdown } : {}),
      ...(opts.referencedChunkIds ? { referenced_chunk_ids: opts.referencedChunkIds } : {}),
    });
  }

  /** Track a tool call — wraps fn(), measures latency */
  async trackTool(opts: TrackToolOptions): Promise<unknown> {
    const startMs = Date.now();
    const toolCallId = randomUUID();
    let result: unknown;
    let status: 'success' | 'error' = 'success';
    let err: unknown;

    this.client.enqueue({
      ...this.base(),
      event_type: 'tool.call.started',
      tool_name: opts.toolName,
      tool_call_id: toolCallId,
      retry_of: opts.retryOf,
    });

    try {
      result = await opts.fn();
    } catch (e) {
      status = 'error';
      err = e;
    }

    const latencyMs = Date.now() - startMs;
    const outputSize = estimateBytes(result);
    const bodyFields = serializeToolBodiesForCapture(opts.args, result, opts.captureBodies);

    this.client.enqueue({
      ...this.base(),
      event_type: 'tool.call.completed',
      tool_name: opts.toolName,
      latency_ms: latencyMs,
      status,
      output_size_bytes: outputSize,
      tool_call_id: toolCallId,
      retry_of: opts.retryOf,
      ...bodyFields,
    });

    this.client.notifyToolCall(this.runId, opts.toolName);

    if (err) throw err;
    return result;
  }

  /** Track a retrieval call — wraps fn(), measures latency, emits started + completed */
  async trackRetrieval(opts: TrackRetrievalOptions): Promise<unknown> {
    const startMs = Date.now();
    const spanId = randomUUID();

    this.client.enqueue({
      ...this.base(),
      span_id: spanId,
      event_type: 'retrieval.started',
      vector_store_id: opts.vectorStoreId,
      top_k: opts.topK,
    });

    let result: unknown;
    let status: 'success' | 'error' = 'success';
    let err: unknown;

    try {
      result = await opts.fn();
    } catch (e) {
      status = 'error';
      err = e;
    }

    const latencyMs = Date.now() - startMs;

    this.client.enqueue({
      ...this.base(),
      span_id: spanId,
      event_type: 'retrieval.completed',
      vector_store_id: opts.vectorStoreId,
      top_k: opts.topK,
      latency_ms: latencyMs,
      status,
    });

    if (err) throw err;
    return result;
  }

  /** Emit a raw retrieval completed event (when you have the stats already) */
  recordRetrieval(opts: RawRetrievalOptions): void {
    const chunks: RetrievalChunkInput[] | undefined = opts.chunks;
    this.client.enqueue({
      ...this.base(),
      event_type: 'retrieval.completed',
      vector_store_id: opts.vectorStoreId,
      top_k: opts.topK,
      latency_ms: opts.latencyMs,
      chunks_returned: opts.chunksReturned,
      tokens_injected: opts.tokensInjected,
      similarity_score_avg: opts.similarityScoreAvg,
      status: opts.status,
      ...(chunks?.length ? { chunks } : {}),
    });
  }

  /** Track an embedding call — wraps fn(), measures latency */
  async trackEmbedding(opts: TrackEmbeddingOptions): Promise<unknown> {
    const startMs = Date.now();
    let result: unknown;
    let err: unknown;

    try {
      result = await opts.fn();
    } catch (e) {
      err = e;
    }

    const latencyMs = Date.now() - startMs;

    this.client.enqueue({
      ...this.base(),
      event_type: 'embedding.created',
      model: opts.model,
      input_text_length: opts.inputTextLength,
      batch_size: opts.batchSize,
      latency_ms: latencyMs,
    });

    if (err) throw err;
    return result;
  }

  /** Emit a raw embedding event */
  recordEmbedding(opts: RawEmbeddingOptions): void {
    this.client.enqueue({
      ...this.base(),
      event_type: 'embedding.created',
      model: opts.model,
      input_text_length: opts.inputTextLength,
      token_count: opts.tokenCount,
      latency_ms: opts.latencyMs,
      cost_usd_estimate: opts.costUsdEstimate,
      batch_size: opts.batchSize,
    });
  }

  /** Track a guardrail check — wraps fn(), measures latency, handles block */
  async trackGuardrail(opts: TrackGuardrailOptions): Promise<'pass' | 'fail' | 'modified'> {
    const startMs = Date.now();

    this.client.enqueue({
      ...this.base(),
      event_type: 'guardrail.check.started',
      guardrail_id: opts.guardrailId,
      guardrail_type: opts.guardrailType,
      input_hash: opts.inputHash,
    });

    let result: 'pass' | 'fail' | 'modified' = 'pass';
    let err: unknown;

    try {
      result = await opts.fn();
    } catch (e) {
      err = e;
    }

    const latencyMs = Date.now() - startMs;

    this.client.enqueue({
      ...this.base(),
      event_type: 'guardrail.check.completed',
      guardrail_id: opts.guardrailId,
      guardrail_type: opts.guardrailType,
      input_hash: opts.inputHash,
      result,
      latency_ms: latencyMs,
    });

    if (err) throw err;
    return result;
  }

  /** Emit a raw guardrail result (check or block) */
  recordGuardrail(opts: RawGuardrailOptions): void {
    if (opts.blocked) {
      this.client.enqueue({
        ...this.base(),
        event_type: 'guardrail.blocked',
        guardrail_id: opts.guardrailId,
        guardrail_type: opts.guardrailType,
        input_hash: opts.inputHash,
        block_reason: opts.blockReason,
        severity: opts.severity,
      });
    } else {
      this.client.enqueue({
        ...this.base(),
        event_type: 'guardrail.check.completed',
        guardrail_id: opts.guardrailId,
        guardrail_type: opts.guardrailType,
        input_hash: opts.inputHash,
        result: opts.result,
        latency_ms: opts.latencyMs,
      });
    }
  }

  /** Record a prompt template render event */
  recordPromptRender(opts: RecordPromptRenderOptions): void {
    this.client.enqueue({
      ...this.base(),
      event_type: 'prompt.rendered',
      template_id: opts.templateId,
      template_version: opts.templateVersion,
      rendered_token_count: opts.renderedTokenCount,
      variable_count: opts.variableCount,
      latency_ms: opts.latencyMs,
    });
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.client.enqueue({
      ...this.base(),
      event_type: 'agent.step.completed',
    });
    await this.client.flush();
  }
}

// ---------------------------------------------------------------------------
// RunHandle — fluent API for a single run
// ---------------------------------------------------------------------------

export class RunHandle {
  private readonly client: SensuClient;
  readonly runId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly traceId: string;
  readonly spanId: string;
  private stepCount = 0;
  private ended = false;

  constructor(
    client: SensuClient,
    opts: {
      runId: string;
      sessionId: string;
      agentId: string;
      orgId: string;
      traceId: string;
      spanId: string;
    },
  ) {
    this.client = client;
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.orgId = opts.orgId;
    this.traceId = opts.traceId;
    this.spanId = opts.spanId;
  }

  private base() {
    return {
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: this.agentId,
      session_id: this.sessionId,
      run_id: this.runId,
      trace_id: this.traceId,
      span_id: randomUUID(),
      parent_span_id: this.spanId,
    };
  }

  startStep(opts: StartStepOptions = {}): StepHandle {
    const stepId = opts.stepId ?? randomUUID();
    const sequence = this.stepCount++;

    this.client.enqueue({
      ...this.base(),
      step_id: stepId,
      event_type: 'agent.step.started',
      step_type: opts.stepType ?? 'llm',
      step_name: opts.name,
      sequence: opts.sequence ?? sequence,
    });

    return new StepHandle(this.client, {
      stepId,
      runId: this.runId,
      sessionId: this.sessionId,
      agentId: this.agentId,
      orgId: this.orgId,
      traceId: this.traceId,
      spanId: this.spanId,
      sequence: opts.sequence ?? sequence,
      name: opts.name,
    });
  }

  /** Record user feedback for this run */
  recordFeedback(opts: RecordFeedbackOptions): void {
    this.client.enqueue({
      ...this.base(),
      event_type: 'feedback.received',
      type: opts.type,
      score: opts.score,
      comment: opts.comment,
      end_user_id: opts.endUserId,
    });
  }

  /** Record an automated eval score for this run */
  recordEvalScore(opts: RecordEvalScoreOptions): void {
    this.client.enqueue({
      ...this.base(),
      event_type: 'eval.score.recorded',
      metric: opts.metric,
      score: opts.score,
      evaluator_id: opts.evaluatorId,
      model_used_for_eval: opts.modelUsedForEval,
      ...(opts.stepId ? { step_id: opts.stepId } : {}),
      ...(opts.llmCallId ? { llm_call_id: opts.llmCallId } : {}),
    });
  }

  /** Emit an agent.handoff event from this run to another agent */
  handoff(opts: HandoffOptions): void {
    this.client.enqueue({
      ...this.base(),
      event_type: 'agent.handoff',
      to_agent_id: opts.toAgentId,
      reason: opts.reason,
      context_tokens_transferred: opts.contextTokensTransferred,
    });
  }

  async end(status: 'completed' | 'failed' = 'completed'): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const eventType =
      status === 'completed' ? 'agent.run.completed' : 'agent.run.failed';
    this.client.enqueue({ ...this.base(), event_type: eventType });
    this.client.clearRunLoopState(this.runId);
    await this.client.flush();
  }
}

// ---------------------------------------------------------------------------
// SensuClient
// ---------------------------------------------------------------------------

export class SensuClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly orgId: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  readonly disabled: boolean;
  private readonly disableLivePricing: boolean;
  private readonly debugMode: boolean;
  // When false (default), the SDK strips `body` from every message
  // snapshot before flushing — protects the wire from accidental PII
  // leakage from callers that pre-fill bodies without thinking about
  // capture posture. See REPLAY_V1_PLAN.md §7.
  readonly captureMessageBodies: boolean;
  private readonly onLoopDetected?: (toolName: string, callCount: number) => void;
  private readonly loopThreshold: number;
  // runId → toolName → call count within that run
  private readonly runToolCallCounts = new Map<string, Map<string, number>>();
  // provider:model → [inputPricePer1M, outputPricePer1M]
  private readonly pricingCache = new Map<string, [number, number]>();
  // Async context storage for concurrent-safe run propagation (Node.js only)
  private readonly runStorage: AsyncLocalStorage<RunHandle>;

  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _exitHandler: (() => void) | null = null;

  constructor(opts: SensuClientOptions = {}) {
    const fromEnv = opts.fromEnv ?? false;

    this.apiKey =
      opts.apiKey ??
      (fromEnv ? (process.env.SENSU_API_KEY ?? '') : '');
    this.baseUrl =
      opts.baseUrl ??
      (fromEnv
        ? (process.env.SENSU_BASE_URL ?? 'http://localhost:3001')
        : 'http://localhost:3001');
    this.agentId =
      opts.agentId ??
      (fromEnv ? (process.env.SENSU_AGENT_ID ?? 'unknown-agent') : 'unknown-agent');
    this.orgId =
      opts.orgId ??
      (fromEnv ? (process.env.SENSU_ORG_ID ?? '') : '');

    this.batchSize = opts.batchSize ?? 10;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.disabled = opts.disabled ?? false;
    this.disableLivePricing = opts.disableLivePricing ?? false;
    this.debugMode = opts.debugMode ?? false;
    this.captureMessageBodies = opts.captureMessageBodies ?? false;
    this.onLoopDetected = opts.onLoopDetected;
    this.loopThreshold = opts.loopThreshold ?? 5;
    this.runStorage = new AsyncLocalStorage<RunHandle>();

    if (!this.disabled) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      if (this.flushTimer.unref) this.flushTimer.unref();

      if (typeof process !== 'undefined') {
        this._exitHandler = () => { void this.flush(); };
        process.on('beforeExit', this._exitHandler);
      }
    }
  }

  /** Enqueue an event for batched sending */
  enqueue(event: TelemetryEvent): void {
    if (this.disabled) return;
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Strip `body` from each message snapshot unless the client was
   * constructed with `captureMessageBodies: true`. Also caps body length
   * at 65,536 chars to match the server schema.
   *
   * Called from trackLlm() before the snapshot hits the wire — keeps the
   * decision in one place so future producers (e.g. a streaming version
   * that accepts mid-stream snapshots) can use the same sanitizer.
   */
  sanitizeMessagesSnapshot(input: MessageSnapshotItem[]): MessageSnapshotItem[] {
    if (!this.captureMessageBodies) {
      return input.map(({ body: _omit, ...rest }) => rest);
    }
    return input.map((m) => {
      if (m.body && m.body.length > MAX_BODY_CHARS) {
        return { ...m, body: m.body.slice(0, MAX_BODY_CHARS) };
      }
      return m;
    });
  }

  /** Flush all buffered events to the Sensu API */
  async flush(): Promise<void> {
    if (this.disabled || this.buffer.length === 0) return;
    const events = this.buffer.splice(0);

    if (this.debugMode) {
      for (const ev of events) {
        console.log(`[Sensu] ${formatDebugEvent(ev)}`);
      }
      console.log(`[Sensu] → Flushing ${events.length} event${events.length === 1 ? '' : 's'}`);
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({ events }),
      });
      const body = await res.text();
      if (!res.ok) {
        console.error(`[sensu:sdk] flush failed ${res.status}: ${body}`);
      } else {
        const parsed = JSON.parse(body) as { processed?: number; errors?: { index: number; error: string }[] };
        if (parsed.errors?.length) {
          for (const { index, error } of parsed.errors) {
            const ev = events[index];
            console.warn(
              `[sensu:sdk] event[${index}] ${ev?.event_type ?? '?'} rejected: ${error}`,
              ev ? JSON.stringify(ev) : '',
            );
          }
        }
      }
    } catch (err) {
      // Re-queue on network error (best-effort)
      console.error('[sensu:sdk] flush network error:', err);
      this.buffer.unshift(...events);
    }
  }

  /**
   * Post end-user feedback for a run. Run-less helper — no active sensu.run() context required.
   * Hits POST /api/v1/feedback directly (not the event buffer).
   * Returns the created feedback id.
   */
  async feedback(opts: FeedbackOptions): Promise<{ id: string } | null> {
    if (this.disabled || !this.apiKey) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({
          runId:     opts.runId,
          type:      opts.type,
          score:     opts.score,
          comment:   opts.comment,
          endUserId: opts.endUserId,
        }),
      });
      if (!res.ok) {
        console.error(`[sensu:sdk] feedback failed ${res.status}: ${await res.text()}`);
        return null;
      }
      return (await res.json()) as { id: string };
    } catch (err) {
      console.error('[sensu:sdk] feedback network error:', err);
      return null;
    }
  }

  /**
   * Post an automated eval score for a run. Run-less helper.
   * Hits POST /api/v1/eval-scores directly (not the event buffer).
   * Returns the created eval score id.
   */
  async score(opts: ScoreOptions): Promise<{ id: string } | null> {
    if (this.disabled || !this.apiKey) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/eval-scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({
          runId:            opts.runId,
          metric:           opts.metric,
          score:            opts.score,
          evaluatorId:      opts.evaluatorId,
          modelUsedForEval: opts.modelUsedForEval,
          stepId:           opts.stepId,
          llmCallId:        opts.llmCallId,
        }),
      });
      if (!res.ok) {
        console.error(`[sensu:sdk] score failed ${res.status}: ${await res.text()}`);
        return null;
      }
      return (await res.json()) as { id: string };
    } catch (err) {
      console.error('[sensu:sdk] score network error:', err);
      return null;
    }
  }

  /**
   * Register a candidate config (system prompt + optional model) used for a
   * given commit so eval-gate checks (§5.2) can reference it as `versionId`
   * instead of inlining the full config every request. Run-less helper.
   * Hits POST /api/v1/agents/:id/versions directly.
   *
   * Customers typically call this from their deploy step, then pass the
   * returned `id` to the Sensu eval-gate Action.
   */
  async registerAgentVersion(opts: RegisterAgentVersionOptions): Promise<AgentVersion | null> {
    if (this.disabled || !this.apiKey) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/api/v1/agents/${encodeURIComponent(opts.agentId)}/versions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
          body: JSON.stringify({ sha: opts.sha, config: opts.config }),
        },
      );
      if (!res.ok) {
        console.error(`[sensu:sdk] registerAgentVersion failed ${res.status}: ${await res.text()}`);
        return null;
      }
      return (await res.json()) as AgentVersion;
    } catch (err) {
      console.error('[sensu:sdk] registerAgentVersion network error:', err);
      return null;
    }
  }

  /** Track a tool call for loop detection; fires onLoopDetected when threshold is reached. */
  notifyToolCall(runId: string, toolName: string): void {
    if (!this.onLoopDetected) return;
    let runMap = this.runToolCallCounts.get(runId);
    if (!runMap) {
      runMap = new Map();
      this.runToolCallCounts.set(runId, runMap);
    }
    const count = (runMap.get(toolName) ?? 0) + 1;
    runMap.set(toolName, count);
    if (count >= this.loopThreshold) {
      this.onLoopDetected(toolName, count);
    }
  }

  /** Remove per-run loop counters when the run ends to avoid memory leaks. */
  clearRunLoopState(runId: string): void {
    this.runToolCallCounts.delete(runId);
  }

  /**
   * Returns the RunHandle for the current async execution context.
   * Only populated when called from within a sensu.run() callback.
   * Used by wrapAnthropic(), trackTool(), and other client-level helpers.
   */
  getActiveRun(): RunHandle | undefined {
    return this.runStorage.getStore();
  }

  /**
   * Start a run, execute fn inside its async context, and end the run automatically.
   * Uses AsyncLocalStorage so concurrent requests each get their own isolated run context —
   * no race conditions even under parallel request handling.
   *
   * All wrapAnthropic() calls and sensu.trackTool/trackRetrieval/trackEmbedding/trackGuardrail()
   * calls made inside fn are automatically attributed to this run.
   *
   * Note: requires Node.js (uses async_hooks). For browser/edge runtimes use startRun() directly
   * and pass the runHandle explicitly to wrapAnthropic({ runHandle }).
   */
  async run<T>(opts: StartRunOptions, fn: (run: RunHandle) => Promise<T>): Promise<T> {
    const runHandle = this.startRun(opts);

    let succeeded = false;

    try {
      const result = await this.runStorage.run(runHandle, () => fn(runHandle));
      succeeded = true;
      return result;
    } finally {
      // Status reflects whether fn succeeded, not whether flush succeeded.
      // runHandle.end() is idempotent — safe to call even if fn already called it.
      await runHandle.end(succeeded ? 'completed' : 'failed').catch(() => {
        // Swallow SDK-internal flush errors — telemetry must never break user code.
      });
    }
  }

  /**
   * Track a tool call inside the active sensu.run() context.
   * Graceful no-op (executes fn without tracking) if called outside sensu.run().
   *
   * Pass `args` + `captureBodies: true` to ship the tool's input args
   * and result on `tool.call.completed` for replay/debugging. Server
   * runs the PII pipeline at ingest — raw bodies stay inside the
   * audited unmask flow. Default is opt-out per call so storage and
   * PII exposure are explicit decisions (TOOL_IO_CAPTURE_PLAN.md §11.2).
   */
  async trackTool<T>(
    toolName: string,
    fn: () => Promise<T>,
    opts?: { retryOf?: string; args?: unknown; captureBodies?: boolean },
  ): Promise<T> {
    const run = this.getActiveRun();
    if (!run) return fn();

    const step = run.startStep({ name: toolName, stepType: 'tool' });
    try {
      return await step.trackTool({
        toolName,
        fn,
        retryOf:       opts?.retryOf,
        args:          opts?.args,
        captureBodies: opts?.captureBodies,
      }) as T;
    } finally {
      await step.end();
    }
  }

  /**
   * Track a retrieval call inside the active sensu.run() context.
   * fn may return { result, chunks } to supply per-chunk data for retrieval noise analysis,
   * or any other value for basic latency/status tracking only.
   * Graceful no-op (executes fn without tracking) if called outside sensu.run().
   */
  async trackRetrieval<T>(
    retrievalStoreId: string,
    opts: { topK?: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const run = this.getActiveRun();
    if (!run) return fn();

    const step = run.startStep({ name: retrievalStoreId, stepType: 'retrieval' });
    const startMs = Date.now();
    let result: T | undefined;
    let err: unknown;

    try {
      result = await fn();
    } catch (e) {
      err = e;
    }

    const latencyMs = Date.now() - startMs;

    // Detect { result, chunks } return shape for noise analysis
    const maybeRich = result as { chunks?: RetrievalChunkInput[] } | undefined;
    const chunks = Array.isArray(maybeRich?.chunks) ? maybeRich.chunks : undefined;

    step.recordRetrieval({
      vectorStoreId: retrievalStoreId,
      topK: opts.topK,
      latencyMs,
      status: err ? 'error' : 'success',
      chunksReturned: chunks?.length,
      chunks,
    });

    await step.end();
    if (err) throw err;
    return result!;
  }

  /**
   * Track an embedding call inside the active sensu.run() context.
   * Graceful no-op (executes fn without tracking) if called outside sensu.run().
   */
  async trackEmbedding<T>(
    model: string,
    opts: { inputLength?: number; batchSize?: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const run = this.getActiveRun();
    if (!run) return fn();

    const step = run.startStep({ name: `embed-${model}`, stepType: 'embedding' });
    try {
      return await step.trackEmbedding({ model, fn, inputTextLength: opts.inputLength, batchSize: opts.batchSize }) as T;
    } finally {
      await step.end();
    }
  }

  /**
   * Track a guardrail check inside the active sensu.run() context.
   * Graceful no-op (executes fn without tracking) if called outside sensu.run().
   */
  async trackGuardrail(
    guardrailId: string,
    guardrailType: 'content' | 'pii' | 'jailbreak' | 'custom',
    fn: () => Promise<'pass' | 'fail' | 'modified'>,
  ): Promise<'pass' | 'fail' | 'modified'> {
    const run = this.getActiveRun();
    if (!run) return fn();

    const step = run.startStep({ name: guardrailId, stepType: 'guardrail' });
    try {
      return await step.trackGuardrail({ guardrailId, guardrailType, fn });
    } finally {
      await step.end();
    }
  }

  /** Start a new agent run */
  startRun(opts: StartRunOptions = {}): RunHandle {
    const runId = opts.runId ?? randomUUID();
    const sessionId = opts.sessionId ?? randomUUID();
    const traceId = randomUUID();
    const spanId = randomUUID();

    this.enqueue({
      event_id: randomUUID(),
      event_type: 'agent.run.started',
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: this.agentId,
      session_id: sessionId,
      run_id: runId,
      trace_id: traceId,
      span_id: spanId,
      run_type: opts.runType,
      end_user_id: opts.endUserId,
    });

    return new RunHandle(this, {
      runId,
      sessionId,
      agentId: this.agentId,
      orgId: this.orgId,
      traceId,
      spanId,
    });
  }

  /**
   * Spawn a child agent run from within a parent run.
   * Emits `agent.spawned` on the parent and returns a RunHandle for the child.
   */
  spawnRun(parentRun: RunHandle, opts: SpawnRunOptions): RunHandle {
    const childRunId = opts.childRunId ?? randomUUID();
    const childAgentId = opts.childAgentId;
    const sessionId = opts.sessionId ?? parentRun.sessionId;
    const traceId = parentRun.traceId;
    const spanId = randomUUID();

    // Emit agent.spawned on the parent run
    this.enqueue({
      event_id: randomUUID(),
      event_type: 'agent.spawned',
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: parentRun.agentId,
      session_id: sessionId,
      run_id: parentRun.runId,
      trace_id: traceId,
      span_id: spanId,
      child_run_id: childRunId,
      child_agent_id: childAgentId,
      spawn_reason: opts.spawnReason,
    });

    // Emit agent.run.started for the child run (child agent emits this itself in practice,
    // but the SDK can also do it on behalf of known child agents)
    this.enqueue({
      event_id: randomUUID(),
      event_type: 'agent.run.started',
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: childAgentId,
      session_id: sessionId,
      run_id: childRunId,
      trace_id: traceId,
      span_id: randomUUID(),
      run_type: opts.runType,
    });

    return new RunHandle(this, {
      runId: childRunId,
      sessionId,
      agentId: childAgentId,
      orgId: this.orgId,
      traceId,
      spanId,
    });
  }

  /** Explicitly start a session (sets channel and end_user_id) */
  startSession(opts: StartSessionOptions = {}): string {
    const sessionId = opts.sessionId ?? randomUUID();
    const traceId = randomUUID();
    const spanId = randomUUID();

    this.enqueue({
      event_id: randomUUID(),
      event_type: 'session.started',
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: this.agentId,
      session_id: sessionId,
      run_id: sessionId, // run_id required by base schema; reuse session_id as placeholder
      trace_id: traceId,
      span_id: spanId,
      channel: opts.channel,
      end_user_id: opts.endUserId,
    });

    return sessionId;
  }

  /** Resume a previous session */
  resumeSession(opts: ResumeSessionOptions): string {
    const sessionId = opts.sessionId ?? randomUUID();
    const traceId = randomUUID();
    const spanId = randomUUID();

    this.enqueue({
      event_id: randomUUID(),
      event_type: 'session.resumed',
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: this.agentId,
      session_id: sessionId,
      run_id: sessionId,
      trace_id: traceId,
      span_id: spanId,
      resumed_from_session_id: opts.resumedFromSessionId,
      channel: opts.channel,
      end_user_id: opts.endUserId,
    });

    return sessionId;
  }

  /** Record a prompt version deployment (org-level event, not tied to a run) */
  deployPromptVersion(opts: DeployPromptVersionOptions): void {
    this.enqueue({
      event_id: randomUUID(),
      event_type: 'prompt.version.deployed',
      timestamp: new Date().toISOString(),
      org_id: this.orgId,
      agent_id: this.agentId,
      session_id: 'system',
      run_id: 'system',
      trace_id: randomUUID(),
      span_id: randomUUID(),
      template_id: opts.templateId,
      new_version: opts.newVersion,
      old_version: opts.oldVersion,
      deployed_by: opts.deployedBy,
    });
  }

  /**
   * Resolve per-1M-token pricing for a model.
   *
   * Always hits the Sensu API on first use; caches the result for the
   * session lifetime (per provider+model). Cost estimates are an online
   * concern — no bundled fallback table ships in this SDK
   * (see SDK_CONSOLIDATION_PLAN.md §3c in the platform repo).
   *
   * On failure (API unreachable, model not in any cascade tier,
   * `disableLivePricing: true`, client `disabled`, or no API key):
   * returns `[0, 0]` so the call's cost estimate becomes 0. Warns at
   * most once per (provider, model) per client lifetime so logs don't
   * spam. The server's ingest pipeline reconciles cost at query time
   * from `llm_calls` + the catalog regardless of what the SDK sent.
   */
  async resolvePricing(provider: string, model: string): Promise<[number, number]> {
    const key = `${provider}:${model}`;

    if (this.disableLivePricing || this.disabled || !this.apiKey) {
      this.warnPricingMissOnce(key, this.disableLivePricing
        ? 'disableLivePricing=true'
        : this.disabled ? 'client disabled' : 'no API key');
      return [0, 0];
    }

    const cached = this.pricingCache.get(key);
    if (cached) return cached;

    try {
      const res = await fetch(
        `${this.baseUrl}/api/v1/pricing/models/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`,
        { headers: { 'X-API-Key': this.apiKey } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          inputPricePer1mTokens?: number | null;
          outputPricePer1mTokens?: number | null;
        };
        if (data.inputPricePer1mTokens != null && data.outputPricePer1mTokens != null) {
          const pair: [number, number] = [data.inputPricePer1mTokens, data.outputPricePer1mTokens];
          this.pricingCache.set(key, pair);
          return pair;
        }
      }
      this.warnPricingMissOnce(key, `API returned ${res.status}`);
    } catch (err) {
      this.warnPricingMissOnce(key, `network error: ${(err as Error).message}`);
    }
    return [0, 0];
  }

  private readonly warnedPricingMisses = new Set<string>();

  private warnPricingMissOnce(key: string, reason: string): void {
    if (this.warnedPricingMisses.has(key)) return;
    this.warnedPricingMisses.add(key);
    console.warn(
      `[sensu:sdk] live pricing unavailable for ${key} (${reason}); ` +
      `cost estimates for this model will be 0 until the API call succeeds. ` +
      `If this is a custom model, register it via POST /api/v1/pricing/org-models.`,
    );
  }

  destroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this._exitHandler && typeof process !== 'undefined') {
      process.off('beforeExit', this._exitHandler);
      this._exitHandler = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SDK_CONSOLIDATION_PLAN.md §3c — bundled pricing fallback removed.
// `extractUsage` no longer sets `cost_usd_estimate` synchronously; the
// async override in `trackLlm` calls `resolvePricing()` (live API) and
// sets it after the fact. Server-side ingest reconciles cost from
// `llm_calls` + the catalog as the source of truth.

function extractUsage(result: unknown, _model: string): Record<string, number | undefined> {
  if (!result || typeof result !== 'object') return {};
  const r = result as Record<string, unknown>;

  // Anthropic shape: { usage: { input_tokens, output_tokens, cache_read_input_tokens } }
  if (r['usage'] && typeof r['usage'] === 'object') {
    const u = r['usage'] as Record<string, unknown>;
    const inputTokens = num(u['input_tokens']) ?? 0;
    const outputTokens = num(u['output_tokens']) ?? 0;
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_input_tokens: num(u['cache_read_input_tokens']),
      total_tokens: inputTokens + outputTokens,
      // cost_usd_estimate intentionally omitted — set later by trackLlm's
      // async resolvePricing() override; server reconciles regardless.
    };
  }

  // OpenAI shape: { choices: [...], usage: { prompt_tokens, completion_tokens, total_tokens } }
  if (r['choices'] && r['usage'] && typeof r['usage'] === 'object') {
    const u = r['usage'] as Record<string, unknown>;
    const inputTokens = num(u['prompt_tokens']) ?? 0;
    const outputTokens = num(u['completion_tokens']) ?? 0;
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: num(u['total_tokens']),
      // cost_usd_estimate intentionally omitted — see Anthropic branch.
    };
  }

  return {};
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function estimateBytes(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

function formatDebugEvent(ev: TelemetryEvent): string {
  const e = ev as Record<string, unknown>;
  const type = String(e['event_type'] ?? '?');

  switch (type) {
    case 'llm.request.completed': {
      const tokens = ((e['input_tokens'] as number | undefined) ?? 0) + ((e['output_tokens'] as number | undefined) ?? 0);
      const cached = e['cached_input_tokens'] ? ` cached=${e['cached_input_tokens']}` : '';
      const cost = e['cost_usd_estimate'] ? ` cost=$${(e['cost_usd_estimate'] as number).toFixed(4)}` : '';
      return `llm.request.completed   provider=${e['provider'] ?? '?'}  model=${e['model'] ?? '?'}  tokens=${tokens}${cached}  latency=${e['latency_ms'] ?? '?'}ms${cost}`;
    }
    case 'tool.call.completed':
      return `tool.call.completed     tool=${e['tool_name'] ?? '?'}  latency=${e['latency_ms'] ?? '?'}ms  status=${e['status'] ?? '?'}`;
    case 'retrieval.completed':
      return `retrieval.completed     store=${e['vector_store_id'] ?? '?'}  chunks=${e['chunks_returned'] ?? '?'}  tokens=${e['tokens_injected'] ?? '?'}  latency=${e['latency_ms'] ?? '?'}ms`;
    case 'embedding.created':
      return `embedding.created       model=${e['model'] ?? '?'}  latency=${e['latency_ms'] ?? '?'}ms`;
    case 'guardrail.check.completed':
      return `guardrail.check.completed  id=${e['guardrail_id'] ?? '?'}  result=${e['result'] ?? '?'}  latency=${e['latency_ms'] ?? '?'}ms`;
    case 'agent.run.started':
      return `agent.run.started       run=${String(e['run_id'] ?? '?').slice(0, 8)}`;
    case 'agent.run.completed':
      return `agent.run.completed     run=${String(e['run_id'] ?? '?').slice(0, 8)}`;
    case 'agent.run.failed':
      return `agent.run.failed        run=${String(e['run_id'] ?? '?').slice(0, 8)}`;
    case 'agent.step.started':
      return `agent.step.started      step=${e['step_name'] ?? e['step_type'] ?? '?'}`;
    case 'agent.step.completed':
      return `agent.step.completed    step=${String(e['step_id'] ?? '?').slice(0, 8)}`;
    default:
      return `${type}`;
  }
}

// Extract text from common streaming chunk shapes (Anthropic / OpenAI)
function extractStreamChunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk !== 'object' || chunk === null) return '';
  const c = chunk as Record<string, unknown>;
  // Anthropic: { type: 'content_block_delta', delta: { type: 'text_delta', text: '...' } }
  if (c['type'] === 'content_block_delta') {
    const delta = c['delta'] as Record<string, unknown> | undefined;
    if (typeof delta?.['text'] === 'string') return delta['text'];
  }
  // OpenAI: { choices: [{ delta: { content: '...' } }] }
  const choices = c['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const delta = (choices[0] as Record<string, unknown>)['delta'] as Record<string, unknown> | undefined;
    if (typeof delta?.['content'] === 'string') return delta['content'];
  }
  return '';
}
