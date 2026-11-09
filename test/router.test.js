import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { Breakers } from '../src/breakers.js'
import { TurnLocks } from '../src/locks.js'
import { Router, lastDurableUserKey, mergeCapabilities } from '../src/router.js'

const NOW = Date.parse('2026-11-09T02:30:00.000Z')

function makeRouter(overrides = {}, llmStream) {
  const { config } = resolveConfig({
    peak: { provider: 'peak-route', models: { chat: 'p-chat', reasoner: 'p-reasoner' } },
    offPeak: { provider: 'off-route', models: { chat: 'o-chat', reasoner: 'o-reasoner' } },
    ...overrides,
  })
  const events = []
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      return llmStream(options)
    },
    fileRequestText: () => '[file handle]',
  }
  const scheduler = {
    now: () => NOW,
    evaluate: () => ({ routeKey: 'peak', reason: 'peak-window', dateKey: '2026-11-09' }),
    inPeakWindow: () => true,
    describe: () => ({ routeKey: 'peak' }),
  }
  const status = { record: (event) => { events.push(event); return event } }
  const router = new Router({
    ctx: { llm },
    llm,
    config,
    scheduler,
    calendar: {},
    locks: new TurnLocks({ now: () => NOW }),
    breakers: new Breakers({ now: () => NOW }),
    status,
    logger: { warn() {}, info() {} },
    clients: new Map(),
  })
  return { router, config, events, calls, llm }
}

function userMessage(id) {
  return { role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
}

function asyncIterableOf(chunks) {
  return (async function* generate() { for (const chunk of chunks) yield chunk })()
}

test('lastDurableUserKey ignores request-only user inputs and finds the durable turn', () => {
  const durable = userMessage('u1')
  const requestOnly = { role: 'user', content: [{ type: 'text', text: 'injected note' }] }
  assert.equal(lastDurableUserKey([durable, requestOnly]), 'u1')
  assert.equal(lastDurableUserKey([requestOnly]), null)
  assert.equal(lastDurableUserKey([]), null)
})

test('mergeCapabilities takes the safe intersection and the reasoning union', () => {
  const merged = mergeCapabilities([
    { context: { contextWindow: 200_000 }, defaultMaxTokens: 32_000, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
    { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 384_000, inputModalities: ['text'], reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
  ])
  assert.deepEqual(merged.context, { contextWindow: 200_000 })
  assert.equal(merged.defaultMaxTokens, 32_000)
  assert.deepEqual(merged.inputModalities, ['text'])
  assert.deepEqual(merged.reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
  assert.equal(merged.reasoning.defaultEffort, 'high')
})

test('plan locks a new turn, reuses it for continuations and auxiliary requests', () => {
  const { router } = makeRouter()
  const first = router.plan({ provider: 'time-router', model: 'auto-flash', sessionId: 's1', messages: [userMessage('u1')] })
  assert.equal(first.kind, 'new-turn')
  assert.equal(first.routeKey, 'peak')
  assert.equal(first.crossedIntoPeak, false) // peak decision, not a DeepSeek turn crossing in
  assert.equal(router.locks.get('s1').userKey, 'u1')

  const continuation = router.plan({ provider: 'time-router', model: 'auto-flash', sessionId: 's1', messages: [userMessage('u1'), { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'result' }] }] })
  assert.equal(continuation.kind, 'continuation')
  assert.equal(continuation.routeKey, 'peak')

  const auxiliary = router.plan({ provider: 'time-router', model: 'auto-flash', sessionId: 's1', messages: [userMessage('u1')], purpose: 'session-title' })
  assert.equal(auxiliary.kind, 'auxiliary')
  assert.equal(auxiliary.routeKey, 'peak')

  const nextTurn = router.plan({ provider: 'time-router', model: 'auto-flash', sessionId: 's1', messages: [userMessage('u1'), userMessage('u2')] })
  assert.equal(nextTurn.kind, 'new-turn')
  assert.equal(router.locks.get('s1').userKey, 'u2')

  const oneOff = router.plan({ provider: 'time-router', model: 'auto-flash', messages: [userMessage('u9')] })
  assert.equal(oneOff.kind, 'one-off')
})

test('an off-peak-locked DeepSeek turn crossing into the window is marked', () => {
  const { router } = makeRouter()
  // Lock the turn while inside the peak window but pinned off-peak by manual override is
  // not the interesting case; simulate the accepted case: a lock created off-peak.
  router.locks.set('s1', { userKey: 'u1', routeKey: 'offPeak', lockedAt: NOW, reason: 'outside-peak-window', crossedIntoPeak: false, fallback: false, fallbackReason: null })
  const plan = router.plan({ provider: 'time-router', model: 'auto-flash', sessionId: 's1', messages: [userMessage('u1')] })
  assert.equal(plan.kind, 'continuation')
  assert.equal(plan.routeKey, 'offPeak')
  assert.equal(plan.crossedIntoPeak, true)
})

test('an open circuit breaker switches the turn without a failed request', () => {
  const { router, config } = makeRouter()
  router.breakers.open('peak-route', 'p-chat', 'quota', { code: 'QUOTA' }, config.fallback)
  const plan = router.plan({ provider: 'time-router', model: 'auto-flash', messages: [userMessage('u1')] })
  assert.equal(plan.routeKey, 'offPeak')
  assert.ok(plan.fallback !== null)
  assert.equal(plan.fallback.fromProvider, 'peak-route')
})

test('route retries once on the same provider, then falls back before any output', async () => {
  let peakAttempts = 0
  const { router, events } = makeRouter({}, (options) => {
    if (options.provider === 'off-route') {
      return asyncIterableOf([
        { type: 'text-delta', index: 0, text: 'from-off-peak' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    }
    peakAttempts += 1
    return asyncIterableOf([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } }])
  })
  const chunks = []
  for await (const chunk of router.route({ provider: 'time-router', model: 'auto-flash', messages: [userMessage('u1')] })) chunks.push(chunk)
  assert.equal(peakAttempts, 2) // original attempt + one same-provider retry
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'from-off-peak')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const recorded = events.at(-1)
  assert.equal(recorded.outcome, 'ok')
  assert.equal(recorded.fallback.fromProvider, 'peak-route')
  assert.equal(recorded.usage.outputTokens, 2)
})

test('after the first chunk the turn is committed and is never re-routed', async () => {
  const calls = []
  const { router, events } = makeRouter({}, (options) => {
    calls.push(options.provider)
    if (options.provider === 'peak-route') {
      return asyncIterableOf([
        { type: 'text-delta', index: 0, text: 'partial' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'died', code: 'TRANSPORT' } } },
      ])
    }
    return asyncIterableOf([{ type: 'text-delta', index: 0, text: 'never' }, { type: 'finish', reason: { kind: 'stop' } }])
  })
  const chunks = []
  for await (const chunk of router.route({ provider: 'time-router', model: 'auto-flash', messages: [userMessage('u1')] })) chunks.push(chunk)
  assert.deepEqual(calls, ['peak-route'])
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(events.at(-1).outcome, 'error')
})

test('delegated calls retarget assistant provenance so the target adapter can restore replay', async () => {
  let seen = null
  const { router } = makeRouter({}, (options) => {
    seen = options
    return asyncIterableOf([{ type: 'text-delta', index: 0, text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }])
  })
  const history = [userMessage('u1'), {
    role: 'assistant',
    source: { kind: 'model', provider: 'time-router', model: 'auto-flash', replayState: { response: 'signed' } },
    content: [{ type: 'text', text: 'previous answer' }],
  }]
  for await (const _chunk of router.route({ provider: 'time-router', model: 'auto-flash', sessionId: 's1', messages: history })) { /* drain */ }
  assert.equal(seen.provider, 'peak-route')
  assert.equal(seen.model, 'p-chat')
  assert.equal(seen.messages[1].source.provider, 'peak-route')
  assert.deepEqual(seen.messages[1].source.replayState, { response: 'signed' })
})

test('unknown virtual models fail the stream with a terminal error chunk', async () => {
  const { router } = makeRouter()
  const chunks = []
  for await (const chunk of router.route({ provider: 'time-router', model: 'nope', messages: [userMessage('u1')] })) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
})
