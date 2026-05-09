/**
 * Anthropic SDK wrapper for Sensu telemetry.
 * Wraps the Anthropic client to automatically track all messages.create() calls.
 *
 * Node.js (concurrent-safe via AsyncLocalStorage):
 *   const anthropic = wrapAnthropic(new Anthropic(), { client: sensu });
 *   await sensu.run({ sessionId }, async () => {
 *     await anthropic.messages.create({...}); // auto-tracked
 *   });
 *
 * Browser / Edge Runtime (explicit run handle):
 *   const run = sensu.startRun({ sessionId });
 *   const anthropic = wrapAnthropic(new Anthropic(), { client: sensu, runHandle: run });
 *   await anthropic.messages.create({...}); // tracked via explicit runHandle
 *   await run.end();
 */

import type { SensuClient, RunHandle } from '../client.js';

interface AnthropicMessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessageLike {
  model?: string;
  usage?: AnthropicMessageUsage;
}

interface AnthropicLike {
  messages: {
    create: (params: unknown) => Promise<unknown>;
  };
}

interface WrapAnthropicOptions {
  client: SensuClient;
  /**
   * Explicit run handle — for browser/edge runtimes where AsyncLocalStorage is unavailable.
   * Takes priority over the AsyncLocalStorage context when provided.
   */
  runHandle?: RunHandle;
  /** Defaults to 'anthropic' */
  defaultProvider?: string;
}

export function wrapAnthropic<T extends AnthropicLike>(
  anthropic: T,
  opts: WrapAnthropicOptions,
): T {
  const { client } = opts;
  const provider = opts.defaultProvider ?? 'anthropic';

  const originalCreate = anthropic.messages.create.bind(anthropic.messages);

  anthropic.messages.create = async (params: unknown): Promise<unknown> => {
    const p = params as Record<string, unknown>;
    const model = (p['model'] as string | undefined) ?? 'unknown';

    // Run resolution: explicit runHandle → AsyncLocalStorage context → standalone event
    const run = opts.runHandle ?? client.getActiveRun();
    const step = run?.startStep({ name: 'anthropic-completion', stepType: 'llm' });

    const startMs = Date.now();
    let result: unknown;
    let status: 'success' | 'error' = 'success';
    let err: unknown;

    try {
      result = await originalCreate(params);
    } catch (e) {
      status = 'error';
      err = e;
    }

    const latencyMs = Date.now() - startMs;
    const r = result as AnthropicMessageLike | undefined;
    const usage = r?.usage;

    const inputTokens = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
    const outputTokens = usage?.output_tokens ?? 0;
    const cachedInputTokens = usage?.cache_read_input_tokens;

    const callOpts = {
      provider,
      model: r?.model ?? model,
      input_tokens: inputTokens || undefined,
      output_tokens: outputTokens || undefined,
      ...(cachedInputTokens != null ? { cached_input_tokens: cachedInputTokens } : {}),
      total_tokens: inputTokens + outputTokens || undefined,
      latency_ms: latencyMs,
      status,
    };

    if (step) {
      step.recordLlm(callOpts);
      void step.end();
    } else {
      // No active run — emit a standalone event so data is never silently dropped
      (client.enqueue as (e: unknown) => void)({
        event_id: crypto.randomUUID(),
        event_type: 'llm.request.completed',
        timestamp: new Date().toISOString(),
        org_id: (client as unknown as { orgId: string }).orgId,
        agent_id: (client as unknown as { agentId: string }).agentId,
        session_id: crypto.randomUUID(),
        run_id: crypto.randomUUID(),
        trace_id: crypto.randomUUID(),
        span_id: crypto.randomUUID(),
        ...callOpts,
      });
    }

    if (err) throw err;
    return result;
  };

  return anthropic;
}
