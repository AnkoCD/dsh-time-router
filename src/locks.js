/**
 * Per-session turn locks.
 *
 * "Strict no-interrupt" routing means the provider is chosen when a user turn
 * starts and never changes mid-turn, even when a tool loop crosses a peak
 * boundary. A lock is keyed by the session's most recent durable user message
 * id, which is a stable turn identity: new input creates a new message id,
 * while every tool-loop continuation of the same turn keeps it.
 *
 * A plugin reload loses these locks; the next request then decides from the
 * current time. That is the one accepted mid-turn switch and it is called out
 * in the README.
 *
 * @module dsh-time-router/locks
 */

const DEFAULT_MAX_SESSIONS = 200
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {object} TurnLock
 * @property {string} userKey       last durable user message id (or a content hash fallback)
 * @property {'peak' | 'offPeak'} routeKey
 * @property {number} lockedAt
 * @property {string} reason        why the route was chosen
 * @property {boolean} crossedIntoPeak
 * @property {boolean} fallback     true once a failure moved this turn to the other route
 * @property {string | null} fallbackReason
 */

/** Insertion-ordered LRU map with a hard size cap and a TTL. */
export class TurnLocks {
  /**
   * @param {{ maxSessions?: number, ttlMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
    /** @type {Map<string, TurnLock>} */
    this.map = new Map()
  }

  /** @returns {TurnLock | undefined} */
  get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const lock = this.map.get(sessionId)
    if (lock === undefined) return undefined
    if (this.now() - lock.lockedAt > this.ttlMs) {
      this.map.delete(sessionId)
      return undefined
    }
    // Refresh LRU position: delete + set moves the key to the end.
    this.map.delete(sessionId)
    this.map.set(sessionId, lock)
    return lock
  }

  /** @param {TurnLock} lock */
  set(sessionId, lock) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    this.map.delete(sessionId)
    this.map.set(sessionId, lock)
    this.prune()
  }

  delete(sessionId) {
    this.map.delete(sessionId)
  }

  prune() {
    const now = this.now()
    for (const [key, lock] of this.map) {
      if (now - lock.lockedAt > this.ttlMs) this.map.delete(key)
    }
    while (this.map.size > this.maxSessions) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  clear() {
    this.map.clear()
  }

  get size() {
    return this.map.size
  }
}
