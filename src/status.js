/**
 * In-memory status ring, token accounting and the append-only event log.
 *
 * Privacy rule: an event never contains prompt or completion text. It carries
 * timestamps, a hashed session id, a hashed turn key, route/provider/model,
 * the decision reason, failure facts, duration and token usage. The panel and
 * the README both state this.
 *
 * @module dsh-time-router/status
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Short, stable, non-reversible session marker for logs. */
export function hashId(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function emptyUsage() {
  return { input: 0, output: 0, requests: 0 }
}

export class StatusStore {
  /**
   * @param {{ eventsFile: string | null, maxEvents: number, rotateBytes?: number, rotateFiles?: number, now?: () => number, logger?: { warn?: (message: string) => void } }} options
   */
  constructor(options) {
    this.eventsFile = options.eventsFile
    this.maxEvents = options.maxEvents
    this.rotateBytes = options.rotateBytes ?? 5 * 1024 * 1024
    this.rotateFiles = options.rotateFiles ?? 3
    this.now = options.now ?? Date.now
    this.logger = options.logger
    this.ring = []
    /** @type {Record<string, { peak: ReturnType<typeof emptyUsage>, offPeak: ReturnType<typeof emptyUsage> }>} */
    this.usageByDay = {}
    this.logQueue = Promise.resolve()
    this.writeError = null
    if (this.eventsFile !== null) this.loadTail()
  }

  /** Record one routed request. */
  record(event) {
    const at = typeof event.atMs === 'number' ? event.atMs : this.now()
    const entry = {
      at: new Date(at).toISOString(),
      atMs: at,
      dateKey: event.dateKey,
      session: hashId(event.sessionId),
      turn: hashId(event.turnKey),
      route: event.routeKey,
      provider: event.provider,
      model: event.model,
      tier: event.tier,
      reason: event.reason,
      isPeak: event.isPeak === true,
      crossedIntoPeak: event.crossedIntoPeak === true,
      fallback: event.fallback ?? null,
      failure: event.failure ?? null,
      durationMs: event.durationMs ?? null,
      usage: event.usage ?? null,
      outcome: event.outcome,
    }
    this.ring.push(entry)
    while (this.ring.length > this.maxEvents) this.ring.shift()
    this.addUsage(entry)
    this.append(entry)
    return entry
  }

  addUsage(entry) {
    if (entry.usage === null || entry.usage === undefined) return
    const day = entry.dateKey ?? new Date(entry.atMs).toISOString().slice(0, 10)
    const bucket = (this.usageByDay[day] ??= { peak: emptyUsage(), offPeak: emptyUsage() })
    const route = entry.route === 'peak' ? bucket.peak : bucket.offPeak
    route.input += Number(entry.usage.inputTokens ?? entry.usage.input ?? 0)
    route.output += Number(entry.usage.outputTokens ?? entry.usage.output ?? 0)
    route.requests += 1
  }

  recent(limit = 20) {
    return this.ring.slice(-Math.max(1, limit)).reverse()
  }

  /** Today and last-seven-day totals, oldest day first. */
  usage(todayKey) {
    const days = Object.keys(this.usageByDay).sort()
    const today = todayKey === undefined
      ? days.length === 0 ? null : days[days.length - 1]
      : todayKey
    const lastSeven = days.filter((day) => today !== null && day <= today).slice(-7)
    const sum = (list, route) => list.reduce((total, day) => {
      const bucket = this.usageByDay[day][route]
      total.input += bucket.input
      total.output += bucket.output
      total.requests += bucket.requests
      return total
    }, emptyUsage())
    return {
      today: today === null ? null : {
        dateKey: today,
        peak: { ...this.usageByDay[today].peak },
        offPeak: { ...this.usageByDay[today].offPeak },
      },
      week: {
        days: lastSeven,
        peak: sum(lastSeven, 'peak'),
        offPeak: sum(lastSeven, 'offPeak'),
      },
      recordedEvents: this.ring.length,
    }
  }

  append(entry) {
    if (this.eventsFile === null) return
    const line = `${JSON.stringify(entry)}\n`
    this.logQueue = this.logQueue.then(async () => {
      try {
        mkdirSync(dirname(this.eventsFile), { recursive: true })
        if (existsSync(this.eventsFile) && statSync(this.eventsFile).size + line.length > this.rotateBytes) {
          this.rotate()
        }
        await appendFile(this.eventsFile, line, 'utf8')
      } catch (error) {
        this.writeError = String(error)
        this.logger?.warn?.(`time-router: cannot append status event: ${String(error)}`)
      }
    })
  }

  rotate() {
    const base = this.eventsFile
    const files = this.rotateFiles
    try {
      if (files <= 0) {
        writeFileSync(base, '', 'utf8')
        return
      }
      for (let index = files; index > 1; index -= 1) {
        if (!existsSync(`${base}.${index - 1}`)) continue
        renameSync(`${base}.${index - 1}`, `${base}.${index}`)
      }
      if (existsSync(base)) renameSync(base, `${base}.1`)
    } catch (error) {
      this.logger?.warn?.(`time-router: cannot rotate status log: ${String(error)}`)
    }
  }

  /** Read a bounded tail so the panel has history right after a restart. */
  loadTail() {
    try {
      if (!existsSync(this.eventsFile)) return
      const text = readFileSync(this.eventsFile, 'utf8')
      const lines = text.trim().split('\n').slice(-this.maxEvents)
      for (const line of lines) {
        if (line.length === 0) continue
        try {
          this.ring.push(JSON.parse(line))
        } catch {
          // A torn final line from a crash is expected; skip it.
        }
      }
    } catch {
      // A missing or unreadable log is not fatal: the ring starts empty.
    }
  }

  async flush() {
    await this.logQueue
  }

  get error() {
    return this.writeError
  }
}
