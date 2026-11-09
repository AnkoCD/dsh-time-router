# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Virtual model ids are `auto-flash` (chat tier) and `auto-pro` (reasoner tier),
  replacing the earlier `auto-chat` / `auto-reasoner` ids. The model picker
  labels are derived from the configured ids (`auto-flash` renders as
  “Auto · flash”).

## [0.1.0] - 2026-11-09

Initial release for DeepSeek Harness 0.2.2-rc.1.

### Added

- Time-of-day routing between a peak route and an off-peak route by Beijing time
  (`Asia/Shanghai`), with half-open peak windows `09:00–12:00` and `14:00–18:00`
  on workdays and a pure, instant-based decision function.
- The virtual provider `time-router` with virtual models `auto-flash` and
  `auto-pro` (configurable), registered through the Harness `llm` service.
- `llm/stream` interception before adapter projection, so exactly one provider
  adapter sees each request and no capability projection is applied twice.
- Direct routes (an OpenAI-compatible Chat Completions endpoint owned by the
  plugin, streaming SSE with reasoning, text, tool-call, usage and finish
  mapping) and delegated routes (an already registered Harness route), freely
  combinable per side.
- Default configuration: peak is direct OpenCode Go
  (`https://opencode.ai/inference/go/openai/v1`, `deepseek-v4.1-flash` /
  `deepseek-v4-pro`), off-peak delegates to `deepseek-official`
  (`deepseek-flash` / `deepseek-v4-pro`).
- Per-turn locking keyed by the last durable user message id: tool-loop
  continuations and auxiliary requests (any `purpose`) inherit the turn's route;
  one-off requests are decided per request. Locks expire after 24 hours, cap at
  200 sessions and evict by LRU.
- First-token commit: a configurable same-provider retry (0–3) and a single
  cross-route fallback before the first chunk; after the first chunk the turn is
  never re-routed or re-sent.
- Failure classification with auth/quota circuit breakers: auth breakers stay
  open until a manual reset or credential change, quota breakers cool down for
  `Retry-After` (when given) or a bounded number of minutes, and open breakers
  are skipped at planning time.
- Explained fallback notices naming the source route, the cause, the destination,
  the pricing consequence and the recovery path; long turns that continue into a
  peak window are marked `crossedIntoPeak`.
- Built-in China holiday data for 2025, 2026 and 2027 with an online refresh
  chain (`NateScarlet/holiday-cn` MIT, `timor.tech` CC BY-NC-SA), a local cache
  written atomically, manual `holidays.overrides`, and a precedence of
  override > online > built-in > weekday-only.
- Status ring, per-day per-route token usage, and an append-only JSONL event log
  with rotation (5 MB default, 3 rotated files).
- `/time-router` slash command with `probe`, `sync` and `reset` actions.
- Web panel: a status chip and inline panel in the composer dock with route,
  next switch, breaker state, usage, warnings, quick actions (auto / force peak /
  force off-peak / enable-disable / reset cooldowns / sync holidays), key storage
  for direct routes and recent events.
- HTTP API: `GET /api/time-router/status` and `POST /api/time-router/state`,
  registered only in profiles with a web server and guarded by the Harness
  connection check.
- English and Chinese UI strings, with inline fallback dictionaries when the
  locale service is unavailable.
- Zero runtime dependencies: the plugin imports no `@deepseek-ai/*` package, so a
  `link:` or local-directory installation needs no `node_modules`.
- 43 unit tests across config, schedule, holidays, openai, router and core
  modules; CI runs them per file on Node 22 and `node --check` on every JS file.
- Documentation: Chinese and English READMEs, a configuration reference, a
  design document, a troubleshooting guide and the holiday data source record.

### Security

- Event logs and status responses never contain prompts, completions, tool
  arguments, raw session ids or API keys; sessions and turns are stored as
  12-character SHA-256 prefixes.
- A key saved from the panel is written to the plugin data directory with mode
  `0600` where the platform supports it; the panel and the HTTP API report only a
  key source tag.
- The panel API rejects requests that fail the Harness connection check.
