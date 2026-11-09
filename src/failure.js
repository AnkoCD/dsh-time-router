/**
 * Failure classification for fallback and circuit breaking.
 *
 * The LLM runtime turns every adapter failure into a terminal `finish` chunk
 * whose `reason.failure` carries provider-neutral `code`/`status` fields
 * (`@deepseek-ai/dsh-llm`, `LlmFailure`). This module is the only place that
 * reads those facts, so routing policy stays declarative: classify, then let
 * the router retry, cool a route down, or fall back.
 *
 * @module dsh-time-router/failure
 */

const AUTH_CODES = new Set([
  'AUTH',
  'AUTHENTICATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'INVALID_API_KEY',
  'ACCOUNT_UNAUTHORIZED',
])

const QUOTA_CODES = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'QUOTA_EXCEEDED',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_QUOTA',
  'BILLING',
])

const RATE_CODES = new Set(['RATE_LIMIT', 'TOO_MANY_REQUESTS', 'OVERLOADED', 'CAPACITY'])

const SERVER_CODES = new Set([
  'SERVER',
  'TRANSPORT',
  'NETWORK',
  'TIMEOUT',
  'CONNECTION',
  'SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
  'BAD_GATEWAY',
  'UPSTREAM',
  'STREAM_IDLE_TIMEOUT',
  'EMPTY_RESPONSE',
])

const CONTEXT_CODES = new Set(['CONTEXT_WINDOW_EXCEEDED', 'CONTEXT_WINDOW', 'IMAGE_OFFLOAD_REQUIRED'])

/** @typedef {{ kind: 'auth'|'quota'|'rate-limit'|'server'|'context'|'aborted'|'other', code: string, status?: number, retryAfterMs?: number, retryable: boolean, circuit: 'auth'|'quota'|null, message: string }} FailureClass */

/** Normalize whatever an adapter reported into the routing vocabulary.
 * @param {any} failure
 * @param {{ signal?: AbortSignal }} [context]
 * @returns {FailureClass}
 */
export function classifyFailure(failure, context = {}) {
  const code = String(failure?.code ?? failure?.name ?? 'UNKNOWN').toUpperCase()
  const status = Number.isInteger(failure?.status) ? failure.status : undefined
  const retryAfterMs = Number.isFinite(failure?.providerRetryAfterMs) ? failure.providerRetryAfterMs : undefined
  const message = String(failure?.message ?? failure?.error?.message ?? 'unknown failure')

  if (context.signal?.aborted || code === 'ABORTED') {
    return { kind: 'aborted', code, status, retryAfterMs, retryable: false, circuit: null, message }
  }
  if (AUTH_CODES.has(code) || status === 401 || status === 403) {
    return { kind: 'auth', code, status, retryAfterMs, retryable: false, circuit: 'auth', message }
  }
  if (QUOTA_CODES.has(code) || status === 402) {
    return { kind: 'quota', code, status, retryAfterMs, retryable: false, circuit: 'quota', message }
  }
  if (CONTEXT_CODES.has(code)) {
    return { kind: 'context', code, status, retryAfterMs, retryable: false, circuit: null, message }
  }
  if (status === 429 || RATE_CODES.has(code)) {
    const retryable = retryAfterMs === undefined || retryAfterMs <= 5000
    return { kind: 'rate-limit', code, status, retryAfterMs, retryable, circuit: null, message }
  }
  if ((status !== undefined && status >= 500) || SERVER_CODES.has(code)) {
    return { kind: 'server', code, status, retryAfterMs, retryable: true, circuit: null, message }
  }
  return { kind: 'other', code, status, retryAfterMs, retryable: false, circuit: null, message }
}

/** True when a chunk ends the attempt with a recoverable-by-someone failure. */
export function isTerminalFailureChunk(chunk) {
  return chunk?.type === 'finish' && chunk.reason?.kind === 'error'
}

/** True when a chunk ends the attempt for any reason. */
export function isTerminalChunk(chunk) {
  return chunk?.type === 'finish'
}

/** A compact one-line summary for the status panel and logs. */
export function summarizeFailure(classified) {
  const status = classified.status === undefined ? '' : ` ${classified.status}`
  return `${classified.kind.toUpperCase()}${status} (${classified.code})`
}

/**
 * Build the user-facing fallback sentence. It always names what happened,
 * where the turn went, and the pricing consequence, per the project's
 * "say why" rule.
 *
 * @param {{ fromLabel: string, toLabel: string, classified: FailureClass, atPeak: boolean, cooldownUntil?: string | null, manualReset?: boolean }} input
 */
export function describeFallback(input) {
  const { fromLabel, toLabel, classified, atPeak, cooldownUntil, manualReset } = input
  const reason = classifyReasonText(classified)
  const pricing = atPeak
    ? 'this turn is billed at peak pricing'
    : 'this turn is billed at off-peak pricing'
  const recovery = manualReset
    ? `${fromLabel} stays disabled until you reset it in the panel or change its credentials`
    : cooldownUntil === undefined || cooldownUntil === null
      ? `retrying ${fromLabel} on a later turn`
      : `${fromLabel} cools down until ${cooldownUntil}`
  return `${fromLabel} ${reason}; this turn switched to ${toLabel} — ${pricing}; ${recovery}.`
}

function classifyReasonText(classified) {
  switch (classified.kind) {
    case 'auth':
      if (classified.code === 'MISSING_CREDENTIAL') return 'has no usable API key'
      if (classified.code === 'INVALID_CREDENTIAL') return 'has an unusable API key'
      return 'rejected its credential (401/403)'
    case 'quota':
      return classified.status === undefined ? 'reported exhausted quota' : `reported exhausted quota (${classified.status})`
    case 'rate-limit':
      return 'is rate limited'
    case 'server':
      return 'failed with a server or transport error'
    case 'context':
      return 'rejected the request because it exceeds the model context window'
    default:
      return `failed (${classified.code})`
  }
}
