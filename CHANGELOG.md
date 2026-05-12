# `@sensu-ai/sdk` changelog

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
