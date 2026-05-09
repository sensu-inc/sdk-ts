/**
 * OpenAI SDK wrapper for Sensu telemetry.
 * Wraps the OpenAI client to automatically track all completions.
 *
 * Usage:
 *   import { wrapOpenAI } from '@sensu-ai/sdk/integrations/openai';
 *   const openai = wrapOpenAI(new OpenAI({ apiKey }), { client: sensu, runHandle });
 *   const resp = await openai.chat.completions.create({ ... }); // auto-tracked
 */

import type { SensuClient, RunHandle } from '../client.js';

interface OpenAILike {
  chat: {
    completions: {
      create: (params: unknown) => Promise<unknown>;
    };
  };
}

interface WrapOpenAIOptions {
  client: SensuClient;
  runHandle?: RunHandle;
  defaultModel?: string;
  defaultProvider?: string;
}

interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface CompletionResponse {
  usage?: CompletionUsage;
  model?: string;
}

export function wrapOpenAI<T extends OpenAILike>(
  openai: T,
  opts: WrapOpenAIOptions,
): T {
  const { client, runHandle } = opts;

  const originalCreate = openai.chat.completions.create.bind(
    openai.chat.completions,
  );

  openai.chat.completions.create = async (params: unknown): Promise<unknown> => {
    const p = params as Record<string, unknown>;
    const model = (p['model'] as string | undefined) ?? opts.defaultModel ?? 'unknown';
    const provider = opts.defaultProvider ?? 'openai';

    let step: import('../client.js').StepHandle | undefined;
    if (runHandle) {
      step = runHandle.startStep({ name: 'openai-completion', stepType: 'llm' });
    }

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
    const r = result as CompletionResponse | undefined;
    const usage = r?.usage;

    const callOpts = {
      provider,
      model: r?.model ?? model,
      input_tokens: usage?.prompt_tokens,
      output_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      latency_ms: latencyMs,
      status,
    };

    if (step) {
      step.recordLlm(callOpts);
      void step.end();
    } else {
      // Emit standalone if no step context
      client.enqueue({
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

  return openai;
}
