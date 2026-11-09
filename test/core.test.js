import test from 'node:test'
import assert from 'node:assert/strict'
import { Breakers } from '../src/breakers.js'
import { classifyFailure, describeFallback } from '../src/failure.js'
import { TurnLocks } from '../src/locks.js'
import { StatusStore } from '../src/status.js'

test('TurnLocks is an LRU with a TTL', () => {
  let now = 1_000
  const locks = new TurnLocks({ maxSessions: 2, ttlMs: 5_000, now: () => now })
  const lock = (userKey) => ({ userKey, routeKey: 'peak', lockedAt: now, reason: 'test', crossedIntoPeak: false, fallback: false, fallbackReason: null })
  locks.set('a', lock('u1'))
  locks.set('b', lock('u2'))
  locks.get('a') // a is now most-recent
  locks.set('c', lock('u3')) // b is evicted
  assert.equal(locks.get('b'), undefined)
  assert.equal(locks.get('a').userKey, 'u1')
  assert.equal(locks.get('c').userKey, 'u3')
  now += 6_000
  assert.equal(locks.get('a'), undefined) // TTL expired
})

test('StatusStore keeps a bounded ring and aggregates token usage per route', () => {
  const status = new StatusStore({ eventsFile: null, maxEvents: 3 })
  const base = { dateKey: '2026-11-09', provider: 'p', model: 'm', tier: 'chat', reason: 'peak-window', isPeak: true, crossedIntoPeak: false, outcome: 'ok', sessionId: 's1', turnKey: 't1' }
  status.record({ ...base, routeKey: 'peak', usage: { inputTokens: 10, outputTokens: 5 } })
  status.record({ ...base, routeKey: 'offPeak', usage: { inputTokens: 20, outputTokens: 7 } })
  status.record({ ...base, routeKey: 'offPeak', usage: { inputTokens: 1, outputTokens: 1 } })
  status.record({ ...base, routeKey: 'peak' }) // evicts the first entry
  assert.equal(status.recent(10).length, 3)
  assert.equal(status.recent(1)[0].route, 'peak')
  const usage = status.usage('2026-11-09')
  assert.equal(usage.today.peak.input, 10) // usage was already aggregated when the ring entry was evicted
  assert.equal(usage.today.offPeak.input, 21)
  assert.equal(usage.week.offPeak.output, 8)
  assert.equal(status.recent(1)[0].session, status.recent(1)[0].session) // hashed, stable
  assert.equal(status.recent(1)[0].session.length, 12)
  assert.equal(JSON.stringify(status.recent(1)[0]).includes('s1'), false) // raw session id never stored
})

test('failure classification covers auth, quota, rate limit, server and abort', () => {
  assert.equal(classifyFailure({ code: 'AUTH' }).kind, 'auth')
  assert.equal(classifyFailure({ code: 'MISSING_CREDENTIAL' }).circuit, 'auth')
  assert.equal(classifyFailure({ code: 'QUOTA', status: 402 }).circuit, 'quota')
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', status: 429 }).retryable, true)
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 60_000 }).retryable, false)
  assert.equal(classifyFailure({ code: 'SERVER', status: 503 }).retryable, true)
  assert.equal(classifyFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }).kind, 'context')
  assert.equal(classifyFailure({ code: 'ABORTED' }).kind, 'aborted')
})

test('describeFallback names the cause, the destination, pricing and cooldown', () => {
  const text = describeFallback({
    fromLabel: 'OpenCode Go',
    toLabel: 'deepseek-official',
    classified: classifyFailure({ code: 'QUOTA', status: 429 }),
    atPeak: true,
    cooldownUntil: '2026-11-09T04:30:00.000Z',
  })
  assert.match(text, /OpenCode Go reported exhausted quota/)
  assert.match(text, /switched to deepseek-official/)
  assert.match(text, /peak pricing/)
  assert.match(text, /cools down until/)
  const missingKey = describeFallback({
    fromLabel: 'OpenCode Go',
    toLabel: 'deepseek-official',
    classified: classifyFailure({ code: 'MISSING_CREDENTIAL' }),
    atPeak: false,
    cooldownUntil: null,
    manualReset: true,
  })
  assert.match(missingKey, /has no usable API key/)
  assert.match(missingKey, /stays disabled until you reset it/)
})

test('Breakers open on quota for a bounded time and on auth until reset', () => {
  let now = 1_000
  const breakers = new Breakers({ now: () => now })
  const fallback = { quotaCooldownMinutes: 30, authCooldownMinutes: 0 }
  breakers.open('p', 'm', 'quota', { code: 'QUOTA', retryAfterMs: 60_000 }, fallback)
  assert.equal(breakers.check('p', 'm').kind, 'quota')
  now += 59_000
  assert.ok(breakers.check('p', 'm'))
  now += 2_000
  assert.equal(breakers.check('p', 'm'), undefined)
  breakers.open('p', 'm', 'auth', { code: 'AUTH' }, fallback)
  now += 365 * 24 * 60 * 60 * 1000
  assert.equal(breakers.check('p', 'm').kind, 'auth') // no cooldown: until reset
  assert.equal(breakers.snapshot().length, 1)
  assert.equal(breakers.reset('p', 'm'), 1)
  assert.equal(breakers.check('p', 'm'), undefined)
})
