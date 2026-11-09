/**
 * The routing engine.
 *
 * A request that names the virtual provider is answered from the `llm/stream`
 * waterfall: the router classifies the request (new turn / tool-loop
 * continuation / auxiliary / one-off), locks a route for the turn, and streams
 * the chosen real provider route instead. Because the waterfall hands the
 * router the request *before* adapter dispatch, exactly one provider adapter
 * sees the request, so no capability projection is applied twice.
 *
 * Fallback rule ("first token is the point of no return"): until a chunk has
 * been yielded the router may retry the same provider once and then switch to
 * the other route. After the first chunk the turn is committed.
 *
 * @module dsh-time-router/router
 */

import { classifyFailure, describeFallback, isTerminalFailureChunk, summarizeFailure } from './failure.js'
import { dateKeyOf } from './time.js'

const CAPABILITY_TTL_MS = 60_000

/**
 * @param {any} messages
 * @returns {string | null} the id of the last durable user message.
 */
export function lastDurableUserKey(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue
    if (typeof message.id === 'string' && message.id.length > 0 && message.source?.kind === 'user') return message.id
  }
  return null
}

/** Intersect/union the two real routes' model metadata into the virtual model. */
export function mergeCapabilities(infos) {
  const defined = infos.filter((info) => info !== undefined && info !== null)
  if (defined.length === 0) return {}
  const contextWindows = defined.map((info) => info.context?.contextWindow).filter((value) => Number.isInteger(value) && value > 0)
  const defaultMaxTokens = defined.map((info) => info.defaultMaxTokens).filter((value) => Number.isSafeInteger(value) && value > 0)
  const modalityLists = infos.map((info) => (Array.isArray(info?.inputModalities) ? info.inputModalities : undefined))
  let inputModalities
  if (modalityLists.every((list) => Array.isArray(list))) {
    inputModalities = modalityLists[0].filter((modality) => modalityLists.every((list) => list.includes(modality)))
  }
  const efforts = new Map()
  for (const info of defined) {
    for (const effort of info.reasoning?.efforts ?? []) {
      if (!efforts.has(effort.id)) efforts.set(effort.id, { ...effort })
    }
  }
  const preferredDefault = infos[1]?.reasoning?.defaultEffort ?? infos[0]?.reasoning?.defaultEffort
  const reasoning = efforts.size === 0
    ? undefined
    : {
        efforts: [...efforts.values()],
        ...(preferredDefault !== undefined && efforts.has(preferredDefault) ? { defaultEffort: preferredDefault } : {}),
      }
  return {
    ...(contextWindows.length > 0 ? { context: { contextWindow: Math.min(...contextWindows) } } : {}),
    ...(defaultMaxTokens.length > 0 ? { defaultMaxTokens: Math.min(...defaultMaxTokens) } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  }
}

export class Router {
  /**
   * @param {object} options
   * @param {any} options.ctx Cordis plugin context (needs `llm`).
   * @param {import('./config.js').ResolvedConfig} options.config
   * @param {import('./schedule.js').Scheduler} options.scheduler
   * @param {import('./holidays.js').createHolidayCalendar} options.calendar
   * @param {import('./locks.js').TurnLocks} options.locks
   * @param {import('./breakers.js').Breakers} options.breakers
   * @param {import('./status.js').StatusStore} options.status
   * @param {{ warn: (message: string, ...rest: unknown[]) => void, info: (message: string, ...rest: unknown[]) => void }} options.logger
   */
  constructor(options) {
    this.ctx = options.ctx
    this.llm = options.llm ?? options.ctx.llm
    this.config = options.config
    /** @type {Map<string, any>} direct route clients keyed by routeKey */
    this.clients = options.clients ?? new Map()
    this.dshHome = options.dshHome
    this.scheduler = options.scheduler
    this.calendar = options.calendar
    this.locks = options.locks
    this.breakers = options.breakers
    this.status = options.status
    this.logger = options.logger
    this.capabilityCache = new Map()
    this.notices = []
    this.warnedCapabilities = new Set()
    this.requestCounter = 0
  }

  get provider() {
    return this.config.virtual.provider
  }

  tierOf(model) {
    if (model === this.config.virtual.models.reasoner) return 'reasoner'
    if (model === this.config.virtual.models.chat) return 'chat'
    return null
  }

  /** @returns {{ routeKey: 'peak'|'offPeak', mode: 'direct'|'delegated', provider: string, model: string, route: any, client?: any }} */
  targetFor(routeKey, tier) {
    const route = this.config[routeKey]
    const direct = route.mode === 'direct'
    return {
      routeKey,
      mode: route.mode,
      provider: route.label,
      model: route.models[tier],
      route,
      ...(direct ? { client: this.clients.get(routeKey) } : {}),
    }
  }

  /** Metadata for one real route: configured for direct, resolved for delegated. */
  async capabilitiesForTarget(target, signal) {
    if (target.mode === 'direct') return target.client?.capabilities?.() ?? {}
    return this.resolveRouteInfo(target, signal)
  }

  /** Harness's deterministic file handle text, when the runtime exposes it. */
  fileText(ref) {
    try {
      return this.llm.fileRequestText(ref)
    } catch {
      return `[file ${ref?.name ?? 'attachment'} was uploaded but its stored copy is not reachable in this environment]`
    }
  }

  otherRouteKey(routeKey) {
    return routeKey === 'peak' ? 'offPeak' : 'peak'
  }

  /** Invalidate cached real-route metadata after the adapter topology changes. */
  invalidateCapabilities() {
    this.capabilityCache.clear()
    this.warnedCapabilities.clear()
  }

  /**
   * Best-effort metadata for one real route/model. Returns `undefined` when the
   * route is not registered yet (for example during activation ordering).
   */
  async resolveRouteInfo(target, signal) {
    const key = `${target.provider}\u0000${target.model}`
    const cached = this.capabilityCache.get(key)
    if (cached !== undefined && cached.expires > Date.now()) return cached.value
    try {
      const value = await this.llm.resolveModelInfo(target.provider, target.model, signal)
      this.capabilityCache.set(key, { value, expires: Date.now() + CAPABILITY_TTL_MS })
      return value
    } catch (error) {
      if (!this.warnedCapabilities.has(key)) {
        this.warnedCapabilities.add(key)
        this.logger.warn(`time-router: cannot resolve metadata for ${target.provider}/${target.model}: ${String(error?.message ?? error)}`)
      }
      return undefined
    }
  }

  /**
   * Capability metadata advertised for one virtual model: the intersection
   * that is safe on either route (min context, min output cap, shared input
   * modalities) and the union of reasoning efforts, reconciled per route at
   * dispatch.
   */
  async virtualCapabilities(model, signal) {
    const tier = this.tierOf(model) ?? 'chat'
    const cacheKey = `virtual:${tier}`
    const cached = this.capabilityCache.get(cacheKey)
    if (cached !== undefined && cached.expires > Date.now()) return cached.value
    const [peakInfo, offPeakInfo] = await Promise.all([
      this.capabilitiesForTarget(this.targetFor('peak', tier), signal),
      this.capabilitiesForTarget(this.targetFor('offPeak', tier), signal),
    ])
    const value = mergeCapabilities([peakInfo, offPeakInfo])
    this.capabilityCache.set(cacheKey, { value, expires: Date.now() + CAPABILITY_TTL_MS })
    return value
  }

  /** Add one panel-visible runtime notice. */
  notice(level, message) {
    const entry = { at: Date.now(), level, message }
    this.notices.push(entry)
    while (this.notices.length > 20) this.notices.shift()
    if (level === 'warn') this.logger.warn(`time-router: ${message}`)
    else this.logger.info(`time-router: ${message}`)
    return entry
  }

  recentNotices(limit = 10) {
    return this.notices.slice(-limit).reverse()
  }

  /**
   * Classify one request and pick its route. Pure aside from reading/creating
   * the turn lock. A new durable user message id starts a new turn; auxiliary
   * requests (`purpose` set) inherit the session's current lock.
   */
  plan(options) {
    const nowMs = this.scheduler.now()
    const tier = this.tierOf(options.model)
    if (tier === null) {
      const error = new Error(`dsh-time-router: unknown virtual model "${options.model}"; expected ${this.config.virtual.models.chat} or ${this.config.virtual.models.reasoner}`)
      error.code = 'UNKNOWN_MODEL'
      throw error
    }
    const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null
    const userKey = lastDurableUserKey(options.messages)
    const auxiliary = typeof options.purpose === 'string' && options.purpose.length > 0
    const decision = this.scheduler.evaluate(nowMs)
    let lock = sessionId === null ? undefined : this.locks.get(sessionId)
    let kind
    let routeKey
    let reason
    if (auxiliary || userKey === null || sessionId === null) {
      kind = auxiliary ? 'auxiliary' : 'one-off'
      routeKey = lock?.routeKey ?? decision.routeKey
      reason = lock !== undefined ? `inherit-${lock.reason}` : decision.reason
    } else if (lock !== undefined && lock.userKey === userKey) {
      kind = 'continuation'
      routeKey = lock.routeKey
      reason = lock.reason
    } else {
      kind = 'new-turn'
      routeKey = decision.routeKey
      reason = decision.reason
      lock = {
        userKey,
        routeKey,
        lockedAt: nowMs,
        reason: decision.reason,
        crossedIntoPeak: false,
        fallback: false,
        fallbackReason: null,
      }
      if (sessionId !== null) this.locks.set(sessionId, lock)
    }

    const isPeakWindow = this.scheduler.inPeakWindow(nowMs)
    if (lock !== undefined && routeKey === 'offPeak' && isPeakWindow) lock.crossedIntoPeak = true

    let target = this.targetFor(routeKey, tier)
    let fallback = null
    const blocked = this.breakers.check(target.provider, target.model)
    if (blocked !== undefined) {
      const alternate = this.targetFor(this.otherRouteKey(routeKey), tier)
      const alternateBlocked = this.breakers.check(alternate.provider, alternate.model)
      if (alternateBlocked === undefined) {
        fallback = {
          fromRouteKey: routeKey,
          fromProvider: target.provider,
          fromModel: target.model,
          toRouteKey: alternate.routeKey,
          toProvider: alternate.provider,
          toModel: alternate.model,
          kind: blocked.kind,
          code: blocked.reason,
          notice: `${target.provider} is cooling down after ${blocked.reason}; this turn uses ${alternate.provider} instead.`,
        }
        routeKey = alternate.routeKey
        target = alternate
        this.applyFallbackLock(lock, sessionId, routeKey, fallback.notice)
      }
    }

    return {
      nowMs,
      dateKey: dateKeyOf(nowMs, this.config.timezone),
      tier,
      sessionId,
      userKey,
      kind,
      auxiliary,
      routeKey,
      reason,
      isPeak: isPeakWindow,
      crossedIntoPeak: lock?.crossedIntoPeak === true,
      lock,
      decision,
      target,
      fallback,
    }
  }

  applyFallbackLock(lock, sessionId, routeKey, notice) {
    if (lock === undefined || sessionId === null) return
    lock.routeKey = routeKey
    lock.fallback = true
    lock.fallbackReason = notice
    this.locks.set(sessionId, lock)
  }

  /**
   * Rewrite assistant history attribution to the target route so the target
   * adapter can restore its own replay state (the Harness only forwards replay
   * state when one adapter instance owns both historical and target routes).
   */
  retargetMessages(messages, target) {
    let changed = false
    const next = messages.map((message) => {
      if (message === null || typeof message !== 'object' || message.role !== 'assistant') return message
      const source = message.source
      if (source === null || typeof source !== 'object' || source.kind !== 'model') return message
      if (source.provider !== this.provider) return message
      if (source.provider === target.provider && source.model === target.model) return message
      changed = true
      return {
        ...message,
        source: {
          kind: 'model',
          provider: target.provider,
          model: target.model,
          ...(source.replayState === undefined ? {} : { replayState: source.replayState }),
        },
      }
    })
    return changed ? next : messages
  }

  supportsEffort(info, effort) {
    if (info === undefined) return true
    return info.reasoning?.efforts?.some((entry) => entry.id === effort) === true
  }

  /** Build the real request for one attempt. */
  async buildInnerOptions(options, target) {
    if (target.mode === 'direct') {
      const inner = { ...options }
      const supported = target.route.reasoningEfforts
      if (options.reasoningEffort !== undefined && Array.isArray(supported) && !supported.includes(String(options.reasoningEffort))) {
        delete inner.reasoningEffort
      }
      return inner
    }
    const messages = this.retargetMessages(options.messages, target)
    const info = await this.resolveRouteInfo(target, options.signal)
    const inner = {
      ...options,
      provider: target.provider,
      model: target.model,
      ...(messages === options.messages ? {} : { messages }),
    }
    if (options.reasoningEffort !== undefined && !this.supportsEffort(info, options.reasoningEffort)) {
      delete inner.reasoningEffort
    }
    return inner
  }

  /** Open one attempt against a direct client or a delegated Harness route. */
  openAttemptStream(options, target, plan) {
    if (target.mode === 'direct') {
      const client = target.client
      if (client === undefined) {
        return (async function* noClient() {
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: `dsh-time-router: direct route "${target.provider}" is not initialized`, code: 'PROVIDER_ERROR' } },
          }
        })()
      }
      return client.stream(options, plan.tier, { fileText: (ref) => this.fileText(ref) })
    }
    return this.llm.stream(options)
  }

  /** Normalize a thrown adapter/network error into the failure vocabulary. */
  classifyThrown(error, signal) {
    const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'NETWORK'
    return classifyFailure({
      code,
      message: String(error?.message ?? error),
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      ...(Number.isFinite(error?.providerRetryAfterMs) ? { providerRetryAfterMs: error.providerRetryAfterMs } : {}),
    }, { signal })
  }

  /**
   * Waterfall entry point. Returns the original chain untouched for any other
   * provider, or a stream that answers this request from a real route.
   */
  intercept(options, next) {
    if (options === null || typeof options !== 'object' || options.provider !== this.provider) return next()
    return this.route(options)
  }

  /** One-shot status summary used by the HTTP API and the panel. */
  describeRoute(options) {
    const target = this.targetFor(this.scheduler.evaluate(this.scheduler.now()).routeKey, this.tierOf(options.model) ?? 'chat')
    return { provider: target.provider, model: target.model }
  }

  recordEvent(plan, target, startedAt, outcome, extras = {}) {
    const entry = this.status.record({
      atMs: plan.nowMs,
      dateKey: plan.dateKey,
      sessionId: plan.sessionId,
      turnKey: plan.userKey,
      routeKey: plan.routeKey,
      provider: target.provider,
      model: target.model,
      tier: plan.tier,
      reason: plan.reason,
      isPeak: plan.isPeak,
      crossedIntoPeak: plan.crossedIntoPeak,
      durationMs: Date.now() - startedAt,
      outcome,
      ...extras,
    })
    return entry
  }

  /**
   * Stream one routed call. Yields the resolved provider's chunks unchanged so
   * the session log records exactly what the model produced.
   */
  async *route(options) {
    let plan
    try {
      plan = this.plan(options)
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error?.message ?? error), code: error?.code ?? 'ROUTING_ERROR' } } }
      return
    }
    const startedAt = Date.now()
    this.requestCounter += 1
    let target = plan.target
    let fallback = plan.fallback
    let attempts = 0
    let retriesLeft = this.config.fallback.enabled ? this.config.fallback.sameProviderRetry : 0
    const attemptedRoutes = new Set([target.routeKey])
    let lastFailure = null
    let lastFailureChunk = null

    for (;;) {
      attempts += 1
      if (options.signal?.aborted === true) {
        const chunk = abortChunk('request aborted before dispatch')
        yield chunk
        this.recordEvent(plan, target, startedAt, 'aborted', { failure: { kind: 'aborted', code: 'ABORTED' } })
        return
      }
      let inner
      try {
        inner = await this.buildInnerOptions(options, target)
      } catch (error) {
        inner = { ...options, provider: target.provider, model: target.model }
      }
      let iterator
      try {
        iterator = this.openAttemptStream(inner, target, plan)[Symbol.asyncIterator]()
      } catch (error) {
        lastFailure = this.classifyThrown(error, options.signal)
        lastFailureChunk = errorChunk(lastFailure)
        const outcome = this.recover(plan, target, lastFailure, { attempts, retriesLeft, attemptedRoutes })
        if (outcome === 'retry') { retriesLeft -= 1; continue }
        if (outcome === 'switch') {
          const next = this.switchTarget(plan, target, lastFailure)
          if (next !== null) { fallback = next.fallback; target = next.target; attemptedRoutes.add(target.routeKey); retriesLeft = this.config.fallback.enabled ? this.config.fallback.sameProviderRetry : 0; continue }
        }
        yield lastFailureChunk
        this.recordEvent(plan, target, startedAt, 'error', { failure: failureFacts(lastFailure), fallback })
        return
      }

      let first
      try {
        first = await iterator.next()
      } catch (error) {
        await closeIterator(iterator)
        lastFailure = this.classifyThrown(error, options.signal)
        lastFailureChunk = errorChunk(lastFailure)
        const outcome = this.recover(plan, target, lastFailure, { attempts, retriesLeft, attemptedRoutes })
        if (outcome === 'retry') { retriesLeft -= 1; continue }
        if (outcome === 'switch') {
          const next = this.switchTarget(plan, target, lastFailure)
          if (next !== null) { fallback = next.fallback; target = next.target; attemptedRoutes.add(target.routeKey); retriesLeft = this.config.fallback.enabled ? this.config.fallback.sameProviderRetry : 0; continue }
        }
        yield lastFailureChunk
        this.recordEvent(plan, target, startedAt, 'error', { failure: failureFacts(lastFailure), fallback })
        return
      }

      if (first.done === true) {
        lastFailure = classifyFailure({ code: 'EMPTY_RESPONSE', message: 'provider stream ended without any chunk' }, { signal: options.signal })
        lastFailureChunk = errorChunk(lastFailure)
        await closeIterator(iterator)
        const outcome = this.recover(plan, target, lastFailure, { attempts, retriesLeft, attemptedRoutes })
        if (outcome === 'retry') { retriesLeft -= 1; continue }
        if (outcome === 'switch') {
          const next = this.switchTarget(plan, target, lastFailure)
          if (next !== null) { fallback = next.fallback; target = next.target; attemptedRoutes.add(target.routeKey); retriesLeft = this.config.fallback.enabled ? this.config.fallback.sameProviderRetry : 0; continue }
        }
        yield lastFailureChunk
        this.recordEvent(plan, target, startedAt, 'error', { failure: failureFacts(lastFailure), fallback })
        return
      }

      const chunk = first.value
      if (isTerminalFailureChunk(chunk)) {
        lastFailure = classifyFailure(chunk.reason.failure, { signal: options.signal })
        lastFailureChunk = chunk
        await closeIterator(iterator)
        const outcome = this.recover(plan, target, lastFailure, { attempts, retriesLeft, attemptedRoutes })
        if (outcome === 'retry') { retriesLeft -= 1; continue }
        if (outcome === 'switch') {
          const next = this.switchTarget(plan, target, lastFailure)
          if (next !== null) { fallback = next.fallback; target = next.target; attemptedRoutes.add(target.routeKey); retriesLeft = this.config.fallback.enabled ? this.config.fallback.sameProviderRetry : 0; continue }
        }
        yield chunk
        this.recordEvent(plan, target, startedAt, 'error', { failure: failureFacts(lastFailure), fallback })
        return
      }

      // First chunk arrived: the turn is committed to this provider.
      let usage = null
      let finishReason = null
      try {
        if (chunk.type === 'usage') usage = chunk.usage
        yield chunk
        for (;;) {
          const result = await iterator.next()
          if (result.done === true) break
          const nextChunk = result.value
          if (nextChunk.type === 'usage') usage = nextChunk.usage
          if (nextChunk.type === 'finish') {
            finishReason = nextChunk.reason
            yield nextChunk
            break
          }
          yield nextChunk
        }
      } catch (error) {
        const failure = this.classifyThrown(error, options.signal)
        this.recordEvent(plan, target, startedAt, 'error', { failure: failureFacts(failure), fallback, usage })
        yield errorChunk(failure)
        return
      }
      const outcome = finishReason?.kind === 'error' ? 'error' : finishReason?.kind === 'aborted' ? 'aborted' : 'ok'
      this.recordEvent(plan, target, startedAt, outcome, {
        fallback,
        usage: usage === null ? null : usage,
        ...(outcome === 'error' && finishReason?.failure !== undefined ? { failure: failureFacts(classifyFailure(finishReason.failure)) } : {}),
        ...(finishReason === null ? { failure: { kind: 'other', code: 'NO_FINISH', message: 'stream ended without a finish chunk' } } : {}),
      })
      return
    }
  }

  /**
   * Decide what one pre-output failure allows: `retry` the same provider,
   * `switch` to the other one, or `stop`.
   */
  recover(plan, target, failure, state) {
    if (!this.config.fallback.enabled) return 'stop'
    if (failure.kind === 'aborted' || failure.kind === 'context') return 'stop'
    if (failure.circuit !== null) {
      this.breakers.open(target.provider, target.model, failure.circuit, {
        retryAfterMs: failure.retryAfterMs,
        code: failure.code,
      }, this.config.fallback)
    }
    if (failure.retryable && state.retriesLeft > 0) return 'retry'
    const alternateKey = this.otherRouteKey(target.routeKey)
    if (state.attemptedRoutes.has(alternateKey)) return 'stop'
    const alternate = this.targetFor(alternateKey, plan.tier)
    if (this.breakers.check(alternate.provider, alternate.model) !== undefined) return 'stop'
    if (failure.circuit !== null) return 'switch'
    if (failure.kind === 'other' || failure.kind === 'rate-limit' || failure.kind === 'server') return 'switch'
    return 'stop'
  }

  /** Move this turn to the other route and build the user-visible notice. */
  switchTarget(plan, target, failure) {
    const alternateKey = this.otherRouteKey(target.routeKey)
    const alternate = this.targetFor(alternateKey, plan.tier)
    const atPeak = this.scheduler.inPeakWindow(this.scheduler.now())
    const cooldownUntil = this.breakers.check(target.provider, target.model)?.until
    const manualReset = failure.circuit === 'auth'
    const notice = describeFallback({
      fromLabel: target.provider,
      toLabel: alternate.provider,
      classified: failure,
      atPeak,
      cooldownUntil: cooldownUntil === undefined || cooldownUntil === null ? null : new Date(cooldownUntil).toISOString(),
      manualReset,
    })
    this.notice('warn', notice)
    this.applyFallbackLock(plan.lock, plan.sessionId, alternateKey, notice)
    return {
      target: alternate,
      fallback: {
        fromRouteKey: target.routeKey,
        fromProvider: target.provider,
        fromModel: target.model,
        toRouteKey: alternate.routeKey,
        toProvider: alternate.provider,
        toModel: alternate.model,
        kind: failure.kind,
        code: failure.code,
        notice,
      },
    }
  }
}

function failureFacts(classified) {
  return {
    kind: classified.kind,
    code: classified.code,
    ...(classified.status === undefined ? {} : { status: classified.status }),
    message: classified.message.slice(0, 300),
  }
}

function errorChunk(classified) {
  return {
    type: 'finish',
    reason: { kind: classified.kind === 'aborted' ? 'aborted' : 'error', failure: { message: classified.message, code: classified.code, ...(classified.status === undefined ? {} : { status: classified.status }) } },
  }
}

function abortChunk(message) {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
}

async function closeIterator(iterator) {
  try {
    await iterator.return?.()
  } catch {
    // Closing a failed attempt is best effort.
  }
}
