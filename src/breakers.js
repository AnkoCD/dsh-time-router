/**
 * Circuit breakers for provider routes.
 *
 * A credential or balance failure must not cost one failed request per turn:
 * once a route is known to be unusable it is skipped entirely, so the next
 * turn goes straight to the other route. Quota exhaustion cools down for a
 * bounded time (the provider's `Retry-After` when it gave one); auth failures
 * stay open until a human resets them or edits the configuration.
 *
 * @module dsh-time-router/breakers
 */

/** @typedef {{ kind: 'auth'|'quota', since: number, until: number | null, reason: string }} BreakerEntry */

/** Key one route attempt; breakers are scoped to the exact provider/model pair. */
export function breakerKey(provider, model) {
  return `${provider}\u0000${model}`
}

export class Breakers {
  /** @param {{ now?: () => number }} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now
    /** @type {Map<string, BreakerEntry>} */
    this.map = new Map()
  }

  /**
   * @param {string} provider
   * @param {string} model
   * @param {'auth'|'quota'} kind
   * @param {{ retryAfterMs?: number, code?: string }} failure
   * @param {{ quotaCooldownMinutes: number, authCooldownMinutes: number }} fallbackConfig
   */
  open(provider, model, kind, failure, fallbackConfig) {
    const now = this.now()
    let until = null
    if (kind === 'quota') {
      const cooldown = Number.isFinite(failure?.retryAfterMs) && failure.retryAfterMs > 0
        ? failure.retryAfterMs
        : fallbackConfig.quotaCooldownMinutes * 60_000
      until = now + cooldown
    } else if (fallbackConfig.authCooldownMinutes > 0) {
      until = now + fallbackConfig.authCooldownMinutes * 60_000
    }
    const entry = {
      kind,
      since: now,
      until,
      reason: String(failure?.code ?? kind),
    }
    this.map.set(breakerKey(provider, model), entry)
    return entry
  }

  /** @returns {BreakerEntry | undefined} */
  check(provider, model) {
    const key = breakerKey(provider, model)
    const entry = this.map.get(key)
    if (entry === undefined) return undefined
    if (entry.until !== null && this.now() >= entry.until) {
      this.map.delete(key)
      return undefined
    }
    return entry
  }

  /** Open entries whose until is a wall-clock instant. */
  isOpen(provider, model) {
    return this.check(provider, model) !== undefined
  }

  /** Reset one route, one provider's routes, or everything. */
  reset(provider, model) {
    if (provider === undefined) {
      const count = this.map.size
      this.map.clear()
      return count
    }
    if (model !== undefined) {
      const key = breakerKey(provider, model)
      const had = this.map.delete(key)
      return had ? 1 : 0
    }
    let count = 0
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(`${provider}\u0000`)) {
        this.map.delete(key)
        count += 1
      }
    }
    return count
  }

  /** Detached snapshot for the status panel. */
  snapshot() {
    return [...this.map.entries()].map(([key, entry]) => {
      const [provider, model] = key.split('\u0000')
      return {
        provider,
        model,
        kind: entry.kind,
        since: entry.since,
        until: entry.until,
        reason: entry.reason,
        active: entry.until === null || this.now() < entry.until,
      }
    }).filter((entry) => entry.active)
  }
}
