export interface SensuClientOptions {
  apiKey?: string;
  baseUrl?: string;
  agentId?: string;
  orgId?: string;
  /** Read config from environment variables */
  fromEnv?: boolean;
  /** Flush buffer when this many events accumulate */
  batchSize?: number;
  /** Flush buffer every N milliseconds */
  flushIntervalMs?: number;
  /** Disable all telemetry (useful for tests) */
  disabled?: boolean;
  /**
   * Called when the SDK detects a tool being called repeatedly within a single run.
   * @param toolName - the tool that is looping
   * @param callCount - how many times it has been called in this run
   */
  onLoopDetected?: (toolName: string, callCount: number) => void;
  /**
   * Number of repeated calls to the same tool within one run before onLoopDetected fires.
   * Default: 5
   */
  loopThreshold?: number;
  /**
   * When true, the SDK will not attempt to fetch live pricing from the API.
   * Cost estimates will use the bundled MODEL_PRICING table only.
   * Default: false
   */
  disableLivePricing?: boolean;
  /**
   * When true, print a one-line summary of each event to the console before flushing.
   * Useful during development to verify the integration is working without opening the dashboard.
   * Events are still sent to the API — this flag observes only, never suppresses.
   * Default: false
   */
  debugMode?: boolean;
  /**
   * When true, message bodies attached to `messagesSnapshot` are forwarded to
   * the API on each LLM call. The API runs them through its shared PII
   * pipeline at ingest, stores the masked form for display, and keeps the
   * raw bodies tenant-side for the Replay scrubber's audited unmask flow.
   *
   * Default: false. Bodies are NEVER sent unless this flag is explicitly
   * enabled — back-compat + privacy posture.
   *
   * See planning/REPLAY_V1_PLAN.md §7 for the storage + retention contract.
   */
  captureMessageBodies?: boolean;
}

/** Alias for StartRunOptions — used with the sensu.run() high-level API. */
export type RunOptions = StartRunOptions;

export interface StartRunOptions {
  sessionId?: string;
  runType?: string;
  endUserId?: string;
  runId?: string;
}

export interface StartStepOptions {
  name?: string;
  stepType?: string;
  sequence?: number;
  stepId?: string;
}

export interface ContextBreakdown {
  system_tokens?: number;
  user_tokens?: number;
  assistant_tokens?: number;
  tool_tokens?: number;
  retrieval_tokens?: number;
}

export interface MessageSnapshotItem {
  role: 'system' | 'user' | 'assistant' | 'tool';
  tool_name?: string;
  token_count: number;
  content_hash: string;
  /**
   * Optional raw message body. Only forwarded to the API when the client
   * was constructed with `captureMessageBodies: true`. The API masks PII
   * via its shared pipeline at ingest; the masked form is what every
   * non-unmask consumer reads. Max 65,536 chars (longer bodies are
   * silently dropped to match the server-side schema cap).
   */
  body?: string;
}

export interface TrackLlmOptions {
  provider: string;
  model: string;
  /** Wraps the LLM call and measures latency automatically */
  fn: () => Promise<unknown>;
  maxContextTokens?: number;
  /**
   * Optional callback to extract a context breakdown from the LLM response.
   * Called with the raw response after fn() resolves.
   */
  extractContextBreakdown?: (result: unknown) => ContextBreakdown | undefined;
  /** Stable ID for this LLM call — used to link eval scores. Generated if omitted. */
  llmCallId?: string;
  /** Snapshot of every message in the context window sent to this LLM call. */
  messagesSnapshot?: MessageSnapshotItem[];
  /** IDs of retrieval chunks whose content the model actually referenced in its output. */
  referencedChunkIds?: string[];
}

export interface LlmResult {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsdEstimate?: number;
  result: unknown;
}

export interface TrackStreamingLlmOptions {
  provider: string;
  model: string;
  /** Async generator that yields token chunks (e.g. an Anthropic or OpenAI stream) */
  stream: AsyncIterable<unknown>;
  maxContextTokens?: number;
  llmCallId?: string;
  /** How often to emit stream.token.received (every N tokens). Default: 10 */
  emitEveryNTokens?: number;
  /** Called with the full accumulated text once streaming completes */
  onComplete?: (text: string, ttftMs: number | undefined) => void;
}

export interface TrackToolOptions {
  toolName: string;
  fn: () => Promise<unknown>;
  /** ID of the original failed tool call this is retrying, for chain visualization */
  retryOf?: string;
  /**
   * Tool-call input arguments. When `captureBodies` is true these are
   * JSON-stringified and shipped on `tool.call.completed` as
   * `input_body`; the awaited result of `fn` becomes `output_body`.
   * Server runs the PII pipeline on each at ingest, so raw bodies
   * never leave the tenant boundary unmasked. Default behavior (no
   * `captureBodies` flag) keeps the v1 shape — neither body field is
   * emitted.
   */
  args?: unknown;
  /**
   * When true, the call's input args and resolved result are
   * JSON-stringified and shipped on `tool.call.completed`. Server
   * runs the PII pipeline at ingest, masks both into `_masked`
   * columns, and surfaces the raw bodies only via the audited
   * unmask flow. Default: false (matches v1).
   *
   * Serialization is best-effort: if `JSON.stringify` fails for
   * either side (circular structure, BigInt, etc.) both fields
   * are skipped so the inspector's "not captured" affordance
   * stays coherent (no half-captured state).
   */
  captureBodies?: boolean;
}

export interface RawLlmCallOptions {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  maxContextTokens?: number;
  contextUsedTokens?: number;
  latencyMs?: number;
  ttftMs?: number;
  costUsdEstimate?: number;
  status?: 'success' | 'error' | 'timeout';
  contextBreakdown?: ContextBreakdown;
  referencedChunkIds?: string[];
}

// ---------------------------------------------------------------------------
// Retrieval & Embedding
// ---------------------------------------------------------------------------

export interface TrackRetrievalOptions {
  /** Wraps the retrieval call and measures latency automatically */
  fn: () => Promise<unknown>;
  vectorStoreId?: string;
  topK?: number;
}

export interface RetrievalChunkInput {
  chunk_id: string;
  source?: string;
  token_count: number;
  similarity_score?: number;
  content_preview?: string;
}

export interface RawRetrievalOptions {
  vectorStoreId?: string;
  topK?: number;
  latencyMs?: number;
  chunksReturned?: number;
  tokensInjected?: number;
  similarityScoreAvg?: number;
  status?: 'success' | 'error';
  /** Per-chunk detail for retrieval noise analysis. */
  chunks?: RetrievalChunkInput[];
}

export interface TrackEmbeddingOptions {
  model: string;
  /** Wraps the embedding call and measures latency automatically */
  fn: () => Promise<unknown>;
  inputTextLength?: number;
  batchSize?: number;
}

export interface RawEmbeddingOptions {
  model: string;
  inputTextLength?: number;
  tokenCount?: number;
  latencyMs?: number;
  costUsdEstimate?: number;
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// Evaluation & Feedback
// ---------------------------------------------------------------------------

export interface RecordFeedbackOptions {
  type: 'thumbs_up' | 'thumbs_down' | 'score' | 'correction';
  score?: number;
  comment?: string;
  endUserId?: string;
}

export interface RecordEvalScoreOptions {
  metric: string;
  score: number;
  evaluatorId?: string;
  modelUsedForEval?: string;
  /** Step ID this eval score is linked to — enables quality correlation view. */
  stepId?: string;
  /** LLM call ID this eval score is linked to — must match the llmCallId used in trackLlm(). */
  llmCallId?: string;
}

/** Options for the run-less, top-level `client.feedback()` helper. */
export interface FeedbackOptions extends RecordFeedbackOptions {
  /** The runId you want to attach this feedback to. Required because there's no active run handle. */
  runId: string;
}

/** Options for the run-less, top-level `client.score()` helper. */
export interface ScoreOptions extends RecordEvalScoreOptions {
  /** The runId you want to attach this eval score to. Required because there's no active run handle. */
  runId: string;
}

// ---------------------------------------------------------------------------
// Multi-Agent
// ---------------------------------------------------------------------------

export interface SpawnRunOptions {
  childAgentId: string;
  childRunId?: string;
  spawnReason?: string;
  /** Options forwarded to the child RunHandle */
  runType?: string;
  sessionId?: string;
}

export interface HandoffOptions {
  toAgentId: string;
  reason?: string;
  contextTokensTransferred?: number;
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export interface TrackGuardrailOptions {
  guardrailId: string;
  guardrailType?: 'content' | 'pii' | 'jailbreak' | 'custom';
  inputHash?: string;
  /** Wraps the guardrail check and measures latency automatically */
  fn: () => Promise<'pass' | 'fail' | 'modified'>;
}

export interface RawGuardrailOptions {
  guardrailId: string;
  guardrailType?: 'content' | 'pii' | 'jailbreak' | 'custom';
  inputHash?: string;
  result?: 'pass' | 'fail' | 'modified';
  blockReason?: string;
  severity?: 'low' | 'medium' | 'high';
  latencyMs?: number;
  blocked?: boolean;
}

// ---------------------------------------------------------------------------
// Prompt Management
// ---------------------------------------------------------------------------

export interface RecordPromptRenderOptions {
  templateId: string;
  templateVersion?: string;
  renderedTokenCount?: number;
  variableCount?: number;
  latencyMs?: number;
}

export interface DeployPromptVersionOptions {
  templateId: string;
  newVersion: string;
  oldVersion?: string;
  deployedBy?: string;
}

// ---------------------------------------------------------------------------
// Session Lifecycle
// ---------------------------------------------------------------------------

export interface StartSessionOptions {
  sessionId?: string;
  channel?: 'web' | 'api' | 'mobile';
  endUserId?: string;
}

export interface ResumeSessionOptions {
  sessionId?: string;
  resumedFromSessionId: string;
  channel?: 'web' | 'api' | 'mobile';
  endUserId?: string;
}
