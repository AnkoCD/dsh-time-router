# dsh-time-router

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2ea44f?logo=github)](https://github.com/topics/dsh-plugin) [![CI](https://github.com/AnkoCD/dsh-time-router/actions/workflows/ci.yml/badge.svg)](https://github.com/AnkoCD/dsh-time-router/actions/workflows/ci.yml) [![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)](https://github.com/topics/dsh-plugin)

[中文](README.zh.md) · English

`dsh-time-router` is a plugin (bundle) for DeepSeek Harness (dsh) 0.2.2-rc.1 that routes model calls by Beijing time: workdays `09:00–12:00` and `14:00–18:00` go to a **peak** route, every other time (including weekends and statutory holidays) goes to an **off-peak** route. It registers a virtual provider `time-router` (virtual models `auto-flash` / `auto-pro`), intercepts the Harness `llm/stream` waterfall for that provider, locks each turn to one real route and streams from it. It ships built-in China holiday data for 2025–2027 with optional online refresh, per-turn locking, circuit breakers with an explained fallback, a status/usage ring with a JSONL event log, a `/time-router` command, an HTTP status API, and a status chip in the composer dock.

## Contents

- [Features](#features)
- [How it routes](#how-it-routes)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Command and panel](#command-and-panel)
- [Fallback and pricing semantics](#fallback-and-pricing-semantics)
- [Holidays](#holidays)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Development and testing](#development-and-testing)
- [License](#license)

## Features

- **Time-of-day routing in Beijing time**: peak windows default to workdays `09:00–12:00` and `14:00–18:00` (`Asia/Shanghai`), treated as half-open `[start, end)` intervals; everything outside them uses off-peak.
- **Holiday aware**: weekends and statutory holidays stay off-peak all day; State Council make-up workdays count as workdays and are judged against the peak windows as usual.
- **Virtual provider + virtual models**: `time-router` / `auto-flash`, `auto-pro` (all renamable). The model picker, capability checks and session attribution see one stable provider/model pair.
- **Each route is direct or delegated**: a route with `baseURL` is *direct* (the plugin owns an OpenAI Chat Completions endpoint); a route with only `provider:` is *delegated* (it reuses an already registered Harness route). The two routes are chosen independently.
- **Per-turn locking, never a mid-turn switch**: one turn (identified by that turn's last durable user message id) keeps its route; tool-loop continuations and auxiliary requests (session title, compaction) inherit the lock.
- **First-token commit**: before the first chunk the router may retry the same route once (configurable) and then switch to the other route; after the first chunk the turn is committed.
- **Circuit breakers**: authentication failures (including a missing key) open an auth breaker that stays until a reset or a credential change; quota failures cool down for a bounded time (`Retry-After` when given, otherwise `quotaCooldownMinutes`). A route with an open breaker is skipped on the next turn instead of costing another failed request.
- **Explained fallback**: the notice names the route, the reason, the destination, and the pricing consequence for this turn; long turns that continue into a peak window are marked `crossedIntoPeak` in the event log.
- **Built-in holiday data + optional online refresh**: `data/holidays-2025.json`, `holidays-2026.json`, `holidays-2027.json`; online sources are `NateScarlet/holiday-cn` (MIT) and `timor.tech` (CC BY-NC-SA), tried in precedence order and never blocking a request.
- **Status and usage**: an in-memory status ring, per-day per-route token usage, and a JSONL event log (5 MB × 3 rotations).
- **Command and panel**: `/time-router [probe|sync|reset]`; a status chip plus inline panel in the composer dock; `GET /api/time-router/status` and `POST /api/time-router/state`.
- **Zero runtime dependencies**: the plugin imports no `@deepseek-ai/*` package, so a `link:` / local-directory install needs no `node_modules`.

## How it routes

A request first passes the `llm/stream` waterfall, then adapter projection and dispatch. The plugin makes its decision in that waterfall, before projection:

```text
                     ┌────────────────────────────────────────────────────┐
  GenerateOptions ──▶│ llm/stream waterfall                               │
  provider: ?        │  provider != "time-router"  ──▶ next() (untouched)  │
                     └───────────────────────┬────────────────────────────┘
                                             │ provider == "time-router"
                                 ┌───────────▼───────────┐
                                 │ decide this turn       │ manual > enabled > holidays > window
                                 └───────────┬───────────┘
              inside a peak window on        │        any other time / weekend / holiday
                       a workday             │
                 ┌───────────────────────────┴───────────────────────────┐
        ┌────────▼─────────┐                                  ┌──────────▼──────────┐
        │ peak route        │                                  │ off-peak route      │
        │ direct: own       │                                  │ delegated to an     │
        │ endpoint, or      │                                  │ existing Harness    │
        │ delegated         │                                  │ route               │
        └────────┬─────────┘                                  └──────────┬──────────┘
                 └───────────────────────┬───────────────────────────────┘
                        before first token: retry / fall back; after: committed
```

**Decision order** (`Scheduler.evaluate()`, a pure function of the instant, the config and the holiday calendar):

1. `manual.mode` is `peak` / `offPeak` and not expired → force that route (**takes precedence over `enabled: false`**).
2. `enabled: false` → pinned to off-peak, reason `disabled`, no further switching.
3. The date is a workday (plain workday or make-up workday) and the instant falls inside one of `peakWindows` → peak, reason `peak-window`.
4. Otherwise → off-peak, with a calendar-driven reason: `statutory-holiday`, `makeup-workday-outside-window`, `weekend`, or `outside-peak-window`.

**Route shape** (`src/config.js`): the resolver decides from `baseURL` — with one, the route is direct and must supply `models.chat` / `models.reasoner`; the plugin streams from it over the OpenAI Chat Completions protocol. With only `provider:`, the route is delegated: the request is rewritten to that registered route's provider/model and handed to the Harness adapter. Both shapes combine freely (the default is direct peak + delegated off-peak).

**Default routes and verification** (measured 2026-11-09):

- **peak (direct)**: OpenCode Go, `https://opencode.ai/inference/go/openai/v1`, models `deepseek-v4.1-flash` (chat) / `deepseek-v4-pro` (reasoner), `contextWindow: 1000000`, `maxTokens: 384000`, reasoning efforts `low/high/max`, text only. The endpoint streams OpenAI chat-completion SSE with `reasoning_content` deltas and usage in the final chunk; its DeepSeek surcharge window is exactly Mon–Fri `01:00–04:00` and `06:00–10:00` UTC = `09:00–12:00` / `14:00–18:00` Asia/Shanghai, matching the default peak windows — which is why the defaults are what they are.
- **off-peak (delegated)**: delegated to the registered `deepseek-official` route with models `deepseek-flash` (chat) / `deepseek-v4-pro` (reasoner).

**Virtual-model capabilities** (`Router.virtualCapabilities()`): the virtual model advertises the safe intersection of the two real routes — smallest `contextWindow`, smallest `defaultMaxTokens`, input modalities both routes support, and the union of reasoning efforts (defaulting to the off-peak route's preferred effort, then peak's). Each dispatch then trims to the target route's actual capabilities (for example it drops a `reasoningEffort` the target does not support).

**Turn lock** (`src/locks.js`): the route is chosen when a new turn starts, keyed by the session's last *durable* user message id (a message with `source.kind === 'user'` and an `id`). Tool-loop continuations keep that same message id, so they inherit the lock; auxiliary requests (any call with a `purpose`, such as session title or compaction) inherit it too. Requests without a session or without a durable user message id (a one-off probe, for example) are decided per request and never locked. Locks are in-memory: they expire after 24 hours, cap at 200 sessions and evict by LRU. **A plugin reload loses them**, and the next request decides from the current time — the only accepted mid-turn switch (see [Fallback and pricing semantics](#fallback-and-pricing-semantics)).

## Quick start

**Requirements**

- DeepSeek Harness **0.2.2-rc.1** (Desktop or Web; the web panel needs a profile with a web server).
- Node **≥ 22** (tests only; the plugin itself has zero runtime dependencies and a `link:` / local-directory install needs no `node_modules`).

**1. Install the plugin**

Get the code first (the public repo lives on GitHub):

```bash
git clone https://github.com/AnkoCD/dsh-time-router.git
```

Three equivalent options:

- The Harness **Plugins page**: install from a local directory, pointing at the absolute path of this repository.
- The agent tool `plugin_manager`: use the absolute package directory as the install target.
- The CLI (`dsh` forwards its arguments to pnpm inside the profile directory):

```bash
dsh plugin --profile desktop add C:\path\to\dsh-time-router
```

`dsh plugin` forwards to pnpm, so installing a local directory creates a `link:` dependency. **Before uninstalling, switch the Harness default model back to a real route, then remove the bundle**: the virtual route disappears when the plugin unloads, and a default model still pointing at it breaks model selection. Uninstall with `dsh plugin --profile desktop remove dsh-time-router`, or remove the bundle from the Plugins page.

**2. Configure the routes and a key**

The defaults already work: peak is direct OpenCode Go, off-peak is delegated to the registered `deepseek-official` route. A direct route needs an API key, resolved in this order (`src/openai.js`):

1. `peak.apiKey` from the config (discouraged — it stores a plaintext secret in the profile patch, and the loader warns).
2. The environment variable named by `peak.apiKeyEnv` (default `OPENCODE_API_KEY`).
3. The file named by `peak.apiKeyFile` (supports `{dshHome}`; note `~` expands to **DSH_HOME**, not the OS home directory).
4. The plugin data file `%DSH_HOME%/plugins/time-router/keys/peak.key` (the panel's "Save key" writes this file).

Put the configuration in the profile's `cordis.patch.yml`, overriding the bundle row by `id: time-router` (a profile patch **replaces the row's `config` wholesale rather than deep-merging**, but the plugin merges its own defaults, so writing only the fields you want to change is enough):

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: time-router
  name: dsh-time-router
  config:
    enabled: true
    timezone: Asia/Shanghai
    peakWindows:
      - ['09:00', '12:00']
      - ['14:00', '18:00']
    peak:
      label: OpenCode Go
      baseURL: https://opencode.ai/inference/go/openai/v1
      apiKeyEnv: OPENCODE_API_KEY
      models:
        chat: deepseek-v4.1-flash
        reasoner: deepseek-v4-pro
      contextWindow: 1000000
      maxTokens: 384000
      inputModalities: ['text']
      reasoningEfforts: ['low', 'high', 'max']
      requestTimeoutMs: 600000
    offPeak:
      provider: deepseek-official
      models:
        chat: deepseek-flash
        reasoner: deepseek-v4-pro
    fallback:
      enabled: true
      sameProviderRetry: 1
      quotaCooldownMinutes: 30
      authCooldownMinutes: 0
```

For a `link:` checkout of this repository you can equally edit [`cordis.patch.yml`](cordis.patch.yml) in the repo; the two are equivalent.

**Delegated-only configuration** (both routes reuse providers already registered in the Harness):

```yaml
- id: time-router
  name: dsh-time-router
  config:
    peak:
      provider: my-peak-gateway
      models:
        chat: deepseek-v4.1-flash
        reasoner: deepseek-v4-pro
    offPeak:
      provider: deepseek-official
      models:
        chat: deepseek-flash
        reasoner: deepseek-v4-pro
```

> Write `models` explicitly on delegated routes: when omitted, peak inherits the default `deepseek-v4.1-flash` / `deepseek-v4-pro` and off-peak inherits `deepseek-flash` / `deepseek-v4-pro`, which may not be real model ids on the target gateway. Two delegated routes naming the same provider load with a warning that time routing has no effect until they differ.

**3. Point the Harness default model at the virtual route**

Traffic only reaches the router when the default model is `time-router` / `auto-flash` (or `auto-pro` for reasoning work); otherwise the plugin stays idle. Two equivalent ways:

- **Settings → Models**: choose provider `time-router`, model `auto-flash`.
- Override the default-model row in the profile patch:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: time-router
    model: auto-flash
    reasoningEffort: high
```

**4. Verify**

Run `/time-router probe` in a session: it sends a minimal 16-token request through the virtual route ("Reply with the single word: pong"), reports which route the turn was routed to, the reason, and the model's reply. You can also read the `/time-router` status output or `GET /api/time-router/status`.

## Configuration reference

The exhaustive field table (type, default, range, validation), key storage, warnings and three full examples live in **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**. Summary:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` pins off-peak (reason `disabled`) |
| `timezone` | `Asia/Shanghai` | IANA zone name; every calendar decision is converted explicitly into it |
| `peakWindows` | `[['09:00','12:00'], ['14:00','18:00']]` | Half-open intervals; no midnight wrap, no equal start/end; overlaps warn |
| `peak` | direct OpenCode Go | A `baseURL` makes it direct; otherwise it needs `provider:` |
| `offPeak` | delegated `deepseek-official` | Same rule |
| `virtual` | `time-router` / `auto-flash` + `auto-pro` | Virtual provider and model ids |
| `manual` | `{ mode: auto, until: null }` | `auto` / `peak` / `offPeak`, optionally with an ISO expiry |
| `fallback` | `{ enabled: true, sameProviderRetry: 1, quotaCooldownMinutes: 30, authCooldownMinutes: 0 }` | Retry and breaker cooldowns |
| `holidays` | `{ online: true, refreshDays: 7, sources, overrides: {} }` | Online refresh and manual overrides (`YYYY-MM-DD → holiday\|workday`) |
| `status` | `{ maxEvents: 200, logFile: true, rotateBytes: 5 MB, rotateFiles: 3 }` | Status ring and event log |
| `debug` | `{ fakeNow: null, probeTool: false }` | `fakeNow` pins the clock for demos and tests |

Invalid values throw at load time (the plugin does not load and the error is logged); unknown keys only warn.

## Command and panel

### Slash command

```text
/time-router           # status (zero tokens, no model request)
/time-router probe     # send a minimal probe through the virtual route and check the reply
/time-router sync      # sync the holiday data now
/time-router reset     # clear every circuit breaker
```

Sample `/time-router` output (values depend on the current instant):

```text
Time router 0.1.0
Now: 2026-11-09 22:35:51 (Monday, workday)
Route: off-peak — outside-peak-window
Next switch: 2026-11-10 09:00:00
Peak: OpenCode Go (deepseek-v4.1-flash / deepseek-v4-pro)
Off-peak: deepseek-official (deepseek-flash / deepseek-v4-pro)
Today: peak 0↑/0↓ tokens, off-peak 0↑/0↓ tokens
```

The `peak` / `offPeak` lines append `— cooling down (<code>)` while that route's breaker is open; the last three fallback notices, holiday warnings, and whether `debug.fakeNow` is active are appended to the output too.

### Web panel

The client half ([`client.js`](client.js)) registers a chip in the **`conversation.composer.dock`** slot (id `time-router-status`, `order: 20`): the dot colour shows the current route (peak / off-peak / disabled), the label shows the route and the next switch time, and clicking expands an inline panel. The panel shows the current time/weekday/day kind, the route and reason, the next switch, both routes' labels and models, breaker state, today's peak/off-peak input and output tokens, holiday warnings, quick actions (auto / force peak / force off-peak / enable-disable routing / reset cooldowns / sync holidays), a key save box for a direct route, and recent events (with `↩ fallback`, `↑ billed at peak price` and failure markers). It polls the status endpoint every 15 seconds.

> Note: the plugin renders a chip and panel in the Harness page; treat what the Harness page actually shows as the source of truth. The project's verification only covered the host-side API and configuration; the browser UI was **not visually reviewed**.

### HTTP API

Registered only when the profile provides both a `webServer` and a `connection` service; every request first passes the Harness `connection.requestRejection()` check (Host/Origin and browser authentication). Profiles without a web server skip this API; nothing else depends on it.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/time-router/status?events=25` | One full snapshot: plugin/virtual route, current decision, calendar and warnings, routes and breakers, notices, recent events, usage, `clockSkewMs`, cache file paths |
| `POST` | `/api/time-router/state` | Quick actions (below) |

Supported `POST` bodies:

- `{"enabled": false}` or `{"manualMode": "auto"|"peak"|"offPeak", "manualUntil": null|ISO}`: writes the config and **restarts the plugin** (responds `{"ok":true,"restarting":true}`); without a configuration editor it returns an error, in which case edit the bundle patch directly.
- `{"resetBreakers": true, "provider": "<optional>"}`: reset all breakers or one provider's.
- `{"syncHolidays": true}`: sync the holiday calendar now.
- `{"apiKey": "...", "routeKey": "peak"}`: write the key to `%DSH_HOME%/plugins/time-router/keys/peak.key` (direct routes only; file mode 0600 where the OS supports it, ACLs on Windows).

A status snapshot never returns the key itself, only `{present, source, hint}`.

## Fallback and pricing semantics

**The first token is the point of no return.** The plugin retries or switches routes only while no chunk has been handed to the Harness yet. Once the first chunk is out, the turn is committed to the current provider; a later stream failure is not re-sent (no double billing, no duplicated tool calls, no corrupted session log).

Pre-first-token failures are handled by class (`Router.recover()`):

| Failure | Handling |
|---|---|
| Authentication (401/403, missing credential, invalid key) | Opens an **auth breaker** (until a manual reset or a credential change), then switches this turn to the other route |
| Quota (402, or 429 whose body mentions quota/balance/credit/usage limit) | Opens a **quota breaker** (`Retry-After` when present, otherwise `quotaCooldownMinutes`), then switches this turn to the other route |
| Rate limit (429 without quota semantics) | Retries the same route when there is no `Retry-After` or it is ≤ 5 s (bounded by `sameProviderRetry`); otherwise switches routes |
| Server/transport (5xx, network, timeout, empty response) | Retryable; once retries run out, switch routes |
| Context overflow (400/413/422 mentioning context length etc.) | **No fallback**; the error goes to the user (another route would not shorten the request and a retry is pointless) |
| Abort | Ends immediately, no fallback |
| `fallback.enabled: false` | Retries and runtime cross-route fallback are off: a failure ends the request and no new breaker is recorded |

Two more constraints: one request switches routes at most once (`attemptedRoutes` prevents ping-pong), and if the other route also has an open breaker the error is returned directly.

**Fallback notices** are produced by `describeFallback()`: who, why, where the turn went, the pricing consequence, and when the route recovers. For example:

```text
OpenCode Go reported exhausted quota (429); this turn switched to deepseek-official —
this turn is billed at peak pricing; OpenCode Go cools down until 2026-11-09T04:30:00.000Z.
```

Notices appear in the last three lines of `/time-router` status output, in the Harness log (warn) and in the status API's `notices` field; the panel's event rows mark fallbacks with `↩ fallback` and cross-window turns with `↑ billed at peak price`. The pricing sentence reflects whether the instant of the switch is inside a peak window — matching OpenCode Go's DeepSeek surcharge window — and not the destination route's name.

**Turns that cross a window are billed as they happen.** Because a turn is never interrupted, a long turn started at 08:50 and still streaming at 09:30 stays on the route it started on; if it is still producing tokens inside the peak window, the upstream bills peak pricing. Such turns are marked `crossedIntoPeak: true` in the status event, and the panel shows `↑ billed at peak price`. This is deliberate: paying slightly more is preferable to interrupting a conversation or duplicating a tool call.

**A plugin reload/restart** is the only accepted mid-turn switch: locks are in memory, so the next turn after a reload re-decides from the current time; a request already streaming is finished by the Harness side and keeps its route for this stream. Changing `enabled` / `manual` from the panel writes the config and restarts the plugin, which loses locks too.

## Holidays

- **Built-in data**: `data/holidays-2025.json`, `data/holidays-2026.json`, `data/holidays-2027.json` (fields `year`, `source`, `verifiedAt`, `holidays`, `makeupWorkdays`). 2025 has 28 holidays + 5 make-up workdays, 2026 has 33 + 6, 2027 has 29 + 5; the verification record is in [docs/holiday-sources.md](docs/holiday-sources.md).
- **Precedence**: `holidays.overrides` (manual) > online data > built-in data > weekday-only fallback.
- **Online refresh**: with `holidays.online: true`, one sync runs asynchronously after activation and then every 6 hours; each sync fetches the current year and the next year, with freshness governed by `refreshDays`. A failed sync keeps the previous data and only produces a panel warning — it **never blocks a routing request**.
- **Online sources** (tried in order, first success wins, 10 s timeout per source):
  1. `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json` (MIT)
  2. `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json` (MIT, jsDelivr fallback)
  3. `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json` (MIT; not directly reachable from some networks)
  4. `https://timor.tech/api/holiday/year/{year}` (CC BY-NC-SA 4.0, non-commercial; 10,000 requests per IP per 24 h)
- **Cache**: `%DSH_HOME%/plugins/time-router/holidays.cache.json` (written to a temp file then renamed; read synchronously at startup so the first request after a restart already has the calendar).
- **Year coverage**: the State Council publishes the next year's schedule around November, so from November the plugin warns when the following year has no data. As of the 2026-11-09 verification point the 2028 schedule is not published (online sources return 404 / an empty object for 2028); 2027 data is built in.
- **Caveat**: `timor.tech` has no 2027 data yet; an empty online object does not mean "no holidays all year", and the built-in data keeps the calendar correct.
- **Note**: data for a year is re-probed from November onward (the plugin warns while the following year is missing).

## Privacy

- **The event log records routing facts, not content.** Each JSONL line is one JSON object with: `at`/`atMs`, `dateKey`, `session` (12-char sha256 prefix), `turn` (12-char sha256 prefix), `route`, `provider`, `model`, `tier`, `reason`, `isPeak`, `crossedIntoPeak`, `fallback` (fallback details), `failure` (failure facts), `durationMs`, `usage` (input/output/cache/reasoning tokens), and `outcome`.
- **Never written**: prompts, completions, tool arguments or results, raw session ids, raw turn ids. Sessions and turns appear only as non-reversible hash prefixes.
- **Keys**: no log, status output or HTTP response contains the key itself; status reports a `source` tag (`config`, `env:NAME`, `file`, `auto-key-file`) and whether a key exists. A key saved in the panel lands in `%DSH_HOME%/plugins/time-router/keys/peak.key` (0600 where supported).
- **Log rotation**: 5 MB per file by default, then `events.jsonl.1`, `.2`, `.3`; `logFile: false` disables the on-disk log entirely (the in-memory status ring is unaffected). Usage totals live in memory and restart from zero after a reload.

## Troubleshooting

Full step-by-step fixes are in **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**. Quick reference:

| Symptom | First check |
|---|---|
| A direct route fails with `MISSING_CREDENTIAL` | The key source: the `apiKeyEnv` variable, `apiKeyFile`, or `%DSH_HOME%/plugins/time-router/keys/peak.key` (`~` expands to DSH_HOME) |
| 401/403 and the route cools down | Fix the key or credentials, then `/time-router reset` (auth breakers do not expire on their own) |
| 402/429 quota errors | Wait for the quota to recover or switch routes; quota breakers cool down for a bounded time, preferring `Retry-After` |
| `↩ fallback` / fallback notices | The notice states the cause and the pricing consequence; the status API's `notices`/`events` and the event log hold the full record |
| Time decisions look wrong | Check `timezone`, the half-open `peakWindows`, a `manual` override, and `debug.fakeNow`; the panel shows Asia/Shanghai time |
| Holiday data stale or missing | `/time-router sync`; check `fetchedAt` in `%DSH_HOME%/plugins/time-router/holidays.cache.json` and the panel warnings |
| `auto-flash` missing from the model picker | Is the plugin row enabled and the virtual provider registered? Look for `time-router: virtual provider ... ready` in the log |
| Panel requests return 401 | The panel goes through the Harness `connection` check; use it from inside the Harness page, not by opening the API URL directly |
| Where are the logs? | The Harness log (provider start, sync and fallback warnings); `%DSH_HOME%/plugins/time-router/events.jsonl` (routed events); `holidays.cache.json` (holiday cache) |

## Development and testing

Code layout:

```text
index.js              Host half: virtual provider, waterfall interception, command, panel API
client.js             Client half: composer-dock chip and inline panel
src/config.js         Config merge, validation, direct/delegated resolution
src/schedule.js       Pure route decision for one instant, next switch
src/holidays.js       Holiday data chain: built-in, online, cache, overrides
src/router.js         llm/stream interception, turn locks, capability projection, fallback state machine
src/openai.js         SSE client for a direct OpenAI-compatible route
src/adapter.js        The virtual provider's LlmAdapter
src/locks.js          Per-turn locks (LRU + TTL)
src/breakers.js       Auth/quota circuit breakers
src/failure.js        Failure classification and fallback wording
src/status.js         Status ring, usage accounting, JSONL event log and rotation
src/time.js           Time-zone-safe calendar helpers
data/                 Built-in 2025–2027 holiday data
locale/               en/zh strings
test/                 config / schedule / holidays / router / openai / core test files
```

Node ≥ 22 is required and **there is nothing to install**:

```bash
# Recommended: run each file directly (node --test test/ may be unavailable in a sandboxed environment)
for f in test/*.test.js; do node "$f"; done

# Or
node --test test/*.test.js
```

There are **43 unit tests** (config 7, schedule 8, holidays 6, openai 8, router 9, core 5) and all pass; CI runs the same per-file loop on Node 22 and `node --check` on every JS file.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the contribution flow, code invariants and the PR checklist, and **[docs/DESIGN.md](docs/DESIGN.md)** for the architecture and design trade-offs.

**Verification status** (2026-11-09, `Asia/Shanghai`):

- All 43 unit tests pass (each `test/<file>.test.js` run directly).
- The plugin is installed into the Desktop profile via `link:`, the bundle list and the `id: time-router` row are active, and `agent-default-model` points at `time-router` / `auto-flash`.
- **End-to-end routing was exercised live**: new sessions on the `time-router` / `auto-flash` default model covered all three paths — off-peak delegation to `deepseek-official` (`deepseek-flash`), forced peak-hour direct OpenCode Go (`deepseek-v4.1-flash`, with reasoning-token usage), and an auth fallback after removing the key (`MISSING_CREDENTIAL` → the turn switched to `deepseek-official` and recorded the fallback notice). Every real request is written to `%DSH_HOME%/plugins/time-router/events.jsonl`, and the session log's `request/header` records the virtual route `time-router` / `auto-flash`.
- Holiday sync ran live: `%DSH_HOME%/plugins/time-router/holidays.cache.json` records the 2026 and 2027 fetch results.
- The HTTP status endpoint is registered in the running Harness: requesting `GET /api/time-router/status` outside a browser session returns 401, i.e. the Harness `connection` check is in force.
- The chip/panel rendering was not automatically verified; treat the Harness page as the source of truth.

## License

MIT, see [LICENSE](LICENSE). Holiday data derives from public government notices and the third-party mirrors above; `timor.tech` data is CC BY-NC-SA 4.0 (non-commercial), so commercial distribution should rely on `NateScarlet/holiday-cn` (MIT) and the built-in data.
