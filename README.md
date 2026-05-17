# @sensu-ai/sdk

The official Node.js SDK for [Sensu](https://sensu-ai.com) — observability for AI agents.

Instrument your agents to track LLM calls, tool use, token spend, latency, and cost. Events are buffered and sent in batches so there's no impact on your agent's performance.

## Installation

```bash
npm install @sensu-ai/sdk
```

## Quick start

### High-level API (recommended for Node.js)

Uses `AsyncLocalStorage` so concurrent requests each get an isolated run context automatically — no run handle passing required.

```ts
import { SensuClient } from '@sensu-ai/sdk';
import { wrapAnthropic } from '@sensu-ai/sdk/integrations/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const sensu = new SensuClient({
  apiKey: process.env.SENSU_API_KEY,
  agentId: 'my-agent',
});

const anthropic = wrapAnthropic(new Anthropic(), { client: sensu });

// sensu.run() creates a run, propagates context automatically, and ends on completion
await sensu.run({ sessionId: 'abc' }, async (run) => {
  // All wrapAnthropic calls inside here are automatically attributed to this run
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
  });

  // Client-level helpers — no step handle needed
  const result = await sensu.trackTool('search_web', () => searchWeb(query));
});
```

### Low-level API

```ts
import { SensuClient } from '@sensu-ai/sdk';

const sensu = new SensuClient({
  apiKey: process.env.SENSU_API_KEY,
  agentId: 'my-agent',
});

const run = sensu.startRun();
const step = run.startStep({ name: 'plan' });

// Wrap an LLM call — latency and token usage are captured automatically
const response = await step.trackLlm({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  fn: () => anthropic.messages.create({ ... }),
});

// Wrap a tool call
const result = await step.trackTool({
  toolName: 'search_web',
  fn: () => searchWeb(query),
});

await step.end();
await run.end();
```

## Configuration

```ts
const sensu = new SensuClient({
  apiKey: 'sns_live_...',      // Required. Your Sensu API key
  agentId: 'my-agent',         // Required. Identifies this agent in the dashboard
  baseUrl: 'https://...',      // Default: http://localhost:3001
  orgId: '',                   // Optional. Populated automatically from your API key
  batchSize: 10,               // Flush after N events (default: 10)
  flushIntervalMs: 2000,       // Flush every N ms (default: 2000)
  disabled: false,             // Set true to disable all telemetry (e.g. in tests)
  debugMode: false,            // Print one-line event summaries to the console during dev
});
```

`debugMode: true` prints a human-readable line to `console.log` for every event before it is flushed. Events are still sent to the API — this flag observes only.

You can also load config from environment variables:

```ts
const sensu = new SensuClient({ fromEnv: true });
```

| Variable | Description |
|---|---|
| `SENSU_API_KEY` | Your Sensu API key |
| `SENSU_AGENT_ID` | Agent identifier |
| `SENSU_BASE_URL` | API base URL |
| `SENSU_ORG_ID` | Organisation ID (optional) |

## API

### `SensuClient`

| Method | Description |
|---|---|
| `run(opts, fn)` | Execute `fn` inside a new run context (Node.js only — uses `AsyncLocalStorage`). Ends the run automatically when `fn` resolves or throws. |
| `startRun(opts?)` | Start a new agent run. Returns a `RunHandle`. |
| `getActiveRun()` | Returns the `RunHandle` for the current async context, or `undefined` if called outside `sensu.run()`. |
| `trackTool(name, fn, opts?)` | Track a tool call inside the active `sensu.run()` context. No-op if called outside a run. |
| `trackRetrieval(storeId, opts, fn)` | Track a retrieval call inside the active `sensu.run()` context. No-op if called outside a run. |
| `trackEmbedding(model, opts, fn)` | Track an embedding call inside the active `sensu.run()` context. No-op if called outside a run. |
| `trackGuardrail(id, type, fn)` | Track a guardrail check inside the active `sensu.run()` context. No-op if called outside a run. |
| `flush()` | Manually flush buffered events to the API. |
| `destroy()` | Stop the background flush timer and deregister the `beforeExit` handler. |

### `RunHandle`

| Method | Description |
|---|---|
| `startStep(opts?)` | Start a step within the run. Returns a `StepHandle`. |
| `end(status?)` | End the run. `status` is `'completed'` (default) or `'failed'`. |

### `StepHandle`

| Method | Description |
|---|---|
| `trackLlm(opts)` | Wrap an LLM call — measures latency and extracts token usage from the response. |
| `recordLlm(opts)` | Emit a raw LLM event when you already have the stats. |
| `trackTool(opts)` | Wrap a tool call — measures latency and output size. |
| `trackRetrieval(opts)` | Track a vector store retrieval. |
| `recordRetrieval(opts)` | Emit a raw retrieval event when you already have the stats. |
| `trackEmbedding(opts)` | Track an embedding call. |
| `trackGuardrail(opts)` | Track a guardrail check. Returns the check result (`'pass'` \| `'fail'` \| `'modified'`). |
| `end()` | End the step. |

## Integrations

### Anthropic (recommended)

Wrap the Anthropic client to track all `messages.create()` calls automatically.

**Node.js — concurrent-safe via `AsyncLocalStorage`:**

```ts
import { wrapAnthropic } from '@sensu-ai/sdk/integrations/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = wrapAnthropic(new Anthropic(), { client: sensu });

await sensu.run({ sessionId }, async () => {
  // Automatically tracked — no run handle needed
  const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', ... });
});
```

**Browser / Edge Runtime — explicit run handle:**

```ts
const run = sensu.startRun({ sessionId });
const anthropic = wrapAnthropic(new Anthropic(), { client: sensu, runHandle: run });

const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', ... });
await run.end();
```

### OpenAI

Wrap the OpenAI client to track all completions automatically:

```ts
import { wrapOpenAI } from '@sensu-ai/sdk/integrations/openai';
import OpenAI from 'openai';

const openai = wrapOpenAI(new OpenAI({ apiKey }), {
  client: sensu,
  runHandle: run,
});

// All calls to openai.chat.completions.create() are now tracked
const response = await openai.chat.completions.create({ model: 'gpt-4o', ... });
```

### LangChain

Drop the Sensu callback handler into any LangChain chain, agent, or LLM.
Chain boundaries, LLM calls (with streaming TTFT and retry/fallback detection),
and tool calls are captured automatically.

```ts
import { SensuClient } from '@sensu-ai/sdk';
import { SensuCallbackHandler } from '@sensu-ai/sdk/integrations/langchain';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatPromptTemplate } from '@langchain/core/prompts';

const sensu = new SensuClient({
  apiKey: process.env.SENSU_API_KEY,
  agentId: 'my-langchain-agent',
});

const handler = new SensuCallbackHandler({ client: sensu });

const prompt = ChatPromptTemplate.fromMessages([['human', '{question}']]);
const llm = new ChatAnthropic({ model: 'claude-sonnet-4-6' });
const chain = prompt.pipe(llm);

const result = await chain.invoke(
  { question: 'What is observability?' },
  { callbacks: [handler] },
);
```

**Tying events to a specific run.** By default the handler creates its own
`sessionId`/`runId` UUIDs. Pass them explicitly to correlate LangChain
telemetry with a run started elsewhere:

```ts
const run = sensu.startRun({ sessionId: 'user-session-1' });
const handler = new SensuCallbackHandler({
  client: sensu,
  sessionId: 'user-session-1',
  runId: run.runId,
});
```

**What's captured.** Chain start/end → `agent.step.*`; LLM start/end/error →
`llm.request.*` (provider, model, tokens, latency, TTFT); streaming tokens →
`stream.token.received` every 10th token; tool start/end/error → `tool.call.*`
with `retry_of` when the same tool re-invokes after error, and `is_fallback`
on the next LLM after an error.

**Limitations.** LangChain's callback interface exposes aggregate token counts
only — per-role context breakdown is not surfaced through this path. For
context-window analysis, use the low-level `trackLlm()` / `recordLlm()` APIs
directly.

Requires `langchain >= 0.1.0` (declared as an optional peer dependency).

## Supported models (cost estimation)

The SDK automatically estimates cost for the following models:

- Anthropic: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-3-5-sonnet`, `claude-3-5-haiku`, `claude-3-opus`
- OpenAI: `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`
