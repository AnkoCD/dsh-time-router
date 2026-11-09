/**
 * Route decisions for one instant, and when the next decision flips.
 *
 * The decision is a pure function of the instant, the resolved config and the
 * holiday calendar, so a sleeping machine that wakes after a boundary still
 * routes correctly. `nextSwitchAt()` scans future minute boundaries (windows
 * are minute-aligned) and also considers an expiring manual override.
 *
 * @module dsh-time-router/schedule
 */

import { dateKeyOf, formatMinuteOfDay, formatZoned, minuteOfDayOf, zonedInstant, zonedParts } from './time.js'

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MINUTE = 60_000
const SCAN_DAYS = 8

export class Scheduler {
  /**
   * @param {{ config: import('./config.js').ResolvedConfig, calendar: ReturnType<import('./holidays.js').createHolidayCalendar>, now?: () => number }} options
   */
  constructor(options) {
    this.config = options.config
    this.calendar = options.calendar
    this.nowImpl = options.now ?? Date.now
  }

  /** Current instant; `debug.fakeNow` pins it for demos and tests. */
  now() {
    return this.config.debug.fakeNowMs ?? this.nowImpl()
  }

  /** Whether the manual override is currently governing routing. */
  manualMode(atMs) {
    const manual = this.config.manual
    if (manual.mode === 'auto') return 'auto'
    if (manual.untilMs !== null && atMs >= manual.untilMs) return 'auto'
    return manual.mode
  }

  /**
   * @param {number} [atMs]
   * @returns {{ atMs: number, at: string, dateKey: string, weekday: string, weekdayName: string, minuteOfDay: number, dayKind: string, daySource: string, isWorkday: boolean, window: { raw: [string, string], start: number, end: number } | null, routeKey: 'peak'|'offPeak', isPeak: boolean, reason: string, manual: 'auto'|'peak'|'offPeak' }}
   */
  evaluate(atMs = this.now()) {
    const config = this.config
    const parts = zonedParts(atMs, config.timezone)
    const dateKey = dateKeyOf(atMs, config.timezone)
    const minuteOfDay = minuteOfDayOf(atMs, config.timezone)
    const day = this.calendar.dayKind(dateKey)
    const isWorkday = day.kind === 'workday' || day.kind === 'makeup-workday'
    const window = isWorkday ? (config.windows.find((entry) => minuteOfDay >= entry.start && minuteOfDay < entry.end) ?? null) : null
    const base = {
      atMs,
      at: new Date(atMs).toISOString(),
      dateKey,
      weekday: parts.weekday,
      weekdayName: WEEKDAY_NAMES[day.weekday],
      minuteOfDay,
      timeOfDay: formatMinuteOfDay(minuteOfDay),
      dayKind: day.kind,
      daySource: day.source,
      isWorkday,
      window,
      manual: 'auto',
    }
    const manual = this.manualMode(atMs)
    if (manual !== 'auto') {
      return { ...base, manual, routeKey: manual, isPeak: manual === 'peak', reason: `manual-${manual}` }
    }
    if (!config.enabled) {
      return { ...base, routeKey: 'offPeak', isPeak: false, reason: 'disabled' }
    }
    if (window !== null) {
      return { ...base, routeKey: 'peak', isPeak: true, reason: 'peak-window' }
    }
    const reason = day.kind === 'holiday'
      ? 'statutory-holiday'
      : day.kind === 'makeup-workday'
        ? 'makeup-workday-outside-window'
        : day.kind === 'weekend'
          ? 'weekend'
          : 'outside-peak-window'
    return { ...base, routeKey: 'offPeak', isPeak: false, reason }
  }

  /**
   * First instant after `atMs` at which `evaluate()` would return a different
   * route, or `null` when the route is pinned (disabled, or an unexpiring
   * manual override). Windows are minute-aligned, so a minute scan is exact.
   */
  nextSwitchAt(atMs = this.now()) {
    const current = this.evaluate(atMs).routeKey
    const manual = this.manualMode(atMs)
    const untilMs = this.config.manual.untilMs
    if (manual !== 'auto' && untilMs !== null && untilMs > atMs) {
      if (this.evaluate(untilMs).routeKey !== current) return untilMs
    }
    if (manual !== 'auto' && (untilMs === null || untilMs <= atMs)) return null
    const first = Math.floor(atMs / MINUTE) * MINUTE + MINUTE
    const limit = atMs + SCAN_DAYS * 86_400_000
    for (let instant = first; instant <= limit; instant += MINUTE) {
      if (this.evaluate(instant).routeKey !== current) return instant
    }
    return null
  }

  /** Normalized description used by the API and the panel. */
  describe(atMs = this.now()) {
    const decision = this.evaluate(atMs)
    const next = this.nextSwitchAt(atMs)
    return {
      atMs: decision.atMs,
      at: decision.at,
      zoned: formatZoned(atMs, this.config.timezone),
      dateKey: decision.dateKey,
      weekday: decision.weekday,
      weekdayName: decision.weekdayName,
      minuteOfDay: decision.minuteOfDay,
      timeOfDay: formatMinuteOfDay(decision.minuteOfDay),
      dayKind: decision.dayKind,
      daySource: decision.daySource,
      isWorkday: decision.isWorkday,
      window: decision.window === null ? null : { start: decision.window.raw[0], end: decision.window.raw[1] },
      routeKey: decision.routeKey,
      isPeak: decision.isPeak,
      reason: decision.reason,
      manual: decision.manual,
      nextSwitchAtMs: next,
      nextSwitchAt: next === null ? null : new Date(next).toISOString(),
      nextSwitchZoned: next === null ? null : formatZoned(next, this.config.timezone),
      fakeNow: this.config.debug.fakeNowMs !== null,
    }
  }

  /** Instant at which a manual override would expire, if one is active. */
  manualExpiresAt(atMs = this.now()) {
    if (this.manualMode(atMs) === 'auto') return null
    return this.config.manual.untilMs
  }

  /** Milliseconds until the next switch, or null when pinned. */
  millisToNextSwitch(atMs = this.now()) {
    const next = this.nextSwitchAt(atMs)
    return next === null ? null : Math.max(0, next - atMs)
  }

  /** Convenience: is `atMs` inside a configured peak window on a workday? */
  inPeakWindow(atMs = this.now()) {
    const decision = this.evaluate(atMs)
    return decision.window !== null
  }

  /** Compute the instant for a future (or past) local wall-clock reading. */
  instantAt(dateKey, minuteOfDay) {
    return zonedInstant(dateKey, minuteOfDay, this.config.timezone)
  }
}
