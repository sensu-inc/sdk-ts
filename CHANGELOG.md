# `@sensu-ai/sdk` changelog

## 0.11.0 — 2026-05-19

### Added — agent version registry for eval-gated CI/CD (§5.2)

- **`client.registerAgentVersion({ agentId, sha, config })`** — new
  run-less helper that wraps `POST /api/v1/agents/:id/versions`. Lets
  customers register the candidate config (system prompt + optional
  model) used at a given commit, then reference the returned
  versionId from the Sensu eval-gate Action instead of inlining the
  full config in every PR check.
- New exported types: `CandidateConfig`, `RegisterAgentVersionOptions`,
  `AgentVersion`.
- Owner/admin role required server-side (the registration represents
  a deploy fact); an API key with `full` scope works as expected. See
  the platform repo's `planning/EVAL_GATED_CI_PLAN.md` PR 5 for the
  matching backend.

## 0.8.0 — 2026-05-13

### Added — per-call tool I/O body capture

- **`TrackToolOptions.args?: unknown`** — new optional field on the
  step-level `step.trackTool({ … })` call. JSON-serialized into
  `input_body` on `tool.call.completed` when `captureBodies: true`.
- **`TrackToolOptions.captureBodies?: boolean`** — default `false`.
  When `true`, the call's `args` and the awaited result of `fn` are
  JSON-stringified and shipped on `tool.call.completed` as
  `input_body` + `output_body`. The Sensu API runs its shared PII
  pipeline at ingest, masks both into `_masked` columns, and surfaces
  the raw bodies only via the audited Replay unmask flow.
  Per-call opt-in (not per-client) so storage and PII exposure are
  explicit decisions. See `planning/TOOL_IO_CAPTURE_PLAN.md §5.1` in
  the platform repo.
- **Top-level `SensuClient.trackTool(toolName, fn, opts)`** — the
  convenience helper now forwards `args` + `captureBodies` from its
  `opts` argument to the underlying `step.trackTool` call. No
  positional signature change.
- **256 KB per-field cap** with the cross-SDK `' …[truncated]'` marker
  on overflow. Cross-SDK invariant: when serialization fails for
  either side (circular structure, BigInt, function-valued result,
  bare `undefined`) BOTH body fields are skipped — never half-captured.

### Changed

- No breaking changes. Default `captureBodies` is `false`, so existing
  `trackTool` calls continue to emit the v1 metadata-only
  `tool.call.completed` event.

### Semver notes

Pre-1.0 minor bump. **Fully backward compatible.** Opting in requires
passing `captureBodies: true` per call.

## 0.7.0 — 2026-05-11

### Added — opt-in message-body capture for Replay v1

- **`MessageSnapshotItem.body?: string`** — new optional field on the
  message snapshot type. Existing callers that don't set it see no
  behavior change.
- **`SensuClientOptions.captureMessageBodies?: boolean`** — default
  `false`. When `true`, raw message bodies on `messagesSnapshot` are
  forwarded to the Sensu API on each LLM call. The API masks PII via
  its shared pipeline at ingest, stores the masked form for display,
  and keeps raw bodies tenant-side for the Replay scrubber's audited
  unmask flow. See `planning/REPLAY_V1_PLAN.md §7` in the platform repo.
- **`SensuClient.sanitizeMessagesSnapshot()`** — the wire sanitizer
  used by `trackLlm()` before the snapshot is flushed. Exposed as a
  public method so test code + future producers (e.g. a streaming
  trackLlm variant) can reuse the strip + cap behavior. Strips `body`
  when `captureMessageBodies` is `false`; otherwise caps body length
  at the server schema limit of 65,536 chars.

### Changed

- Bumped `@sensu-ai/shared` dep `^0.6.0` → `^0.7.0`. The SDK still only
  imports `TelemetryEvent`, which is unchanged; the bump just keeps the
  source-of-truth in sync.

### Semver notes

Pre-1.0 minor bump. **Fully backward compatible** — the default for
`captureMessageBodies` is `false`, so existing SDK callers that never
sent `body` on `messagesSnapshot` continue to see exactly the same
wire payload they did under 0.6.x. Opting in is a deliberate
per-client config change.

## 0.6.1 and earlier

Pre-changelog. See git history.
