/**
 * China holiday calendar with a local-first, online-refreshed data chain.
 *
 * Precedence: manual `overrides` > online data > shipped `data/holidays-YYYY.json`
 * > weekday-only fallback. The shipped files and the cache live outside any
 * request path, so routing never waits on the network: the first request uses
 * whatever is already known, and a background sync upgrades the calendar when
 * it succeeds. Failures keep the previous data and surface as a panel warning.
 *
 * Online sources are third-party mirrors of the official State Council
 * announcement. See `docs/holiday-sources.md` for their licenses and formats.
 *
 * @module dsh-time-router/holidays
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addDaysToDateKey, dateKeyOf, weekdayOfDateKey, zonedParts } from './time.js'

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url))
const CACHE_VERSION = 2
const FETCH_TIMEOUT_MS = 10_000

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function validateDays(list, where) {
  const out = []
  for (const value of list) {
    if (!isDateKey(value)) throw new Error(`${where} contains invalid date ${JSON.stringify(value)}`)
    out.push(value)
  }
  return out
}

/** @returns {{ days: Record<string, 'holiday'|'makeup'>, years: Record<string, number[]>, sources: Record<string, string[]> }} */
function loadBuiltinDays(logger) {
  const days = {}
  const years = {}
  const sources = {}
  let files = []
  try {
    files = readdirSync(DATA_DIR).filter((name) => /^holidays-\d{4}\.json$/.test(name))
  } catch (error) {
    logger?.warn?.(`time-router: cannot read bundled holiday data at ${DATA_DIR}: ${String(error)}`)
    return { days, years, sources }
  }
  for (const file of files.sort()) {
    try {
      const payload = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'))
      const year = Number(payload.year)
      const where = `data/${file}`
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('invalid year')
      for (const date of validateDays(payload.holidays ?? [], `${where}.holidays`)) days[date] = 'holiday'
      for (const date of validateDays(payload.makeupWorkdays ?? [], `${where}.makeupWorkdays`)) days[date] = 'makeup'
      years[year] = [year]
      sources[year] = Array.isArray(payload.source) ? payload.source : [String(payload.source ?? where)]
    } catch (error) {
      logger?.warn?.(`time-router: ignoring bundled holiday file ${file}: ${String(error)}`)
    }
  }
  return { days, years, sources }
}

/**
 * Turn an online payload into `{days: [...], source}`. Two shapes are
 * understood: `NateScarlet/holiday-cn` (`days[{date,isOffDay}]`) and
 * `timor.tech` (`holiday{MM-DD:{holiday,date}}`).
 */
export function parseHolidayPayload(payload) {
  if (payload === null || typeof payload !== 'object') throw new Error('payload is not an object')
  const days = []
  if (Array.isArray(payload.days)) {
    for (const entry of payload.days) {
      if (entry === null || typeof entry !== 'object' || !isDateKey(entry.date)) continue
      days.push({ date: entry.date, kind: entry.isOffDay === true ? 'holiday' : 'makeup' })
    }
    if (days.length === 0) throw new Error('holiday-cn payload has no usable days')
    return { days, format: 'holiday-cn' }
  }
  if (payload.holiday !== null && typeof payload.holiday === 'object') {
    for (const [key, entry] of Object.entries(payload.holiday)) {
      if (entry === null || typeof entry !== 'object') continue
      const date = isDateKey(entry.date) ? entry.date : /^\d{2}-\d{2}$/.test(key) ? `${payload.year ?? ''}-${key}` : ''
      if (!isDateKey(date)) continue
      days.push({ date, kind: entry.holiday === true ? 'holiday' : 'makeup' })
    }
    if (days.length === 0) throw new Error('timor payload has no usable days')
    return { days, format: 'timor' }
  }
  throw new Error('unrecognized holiday payload shape')
}

/**
 * @param {object} options
 * @param {string} options.cacheFile absolute path of the JSON cache.
 * @param {import('./config.js').ResolvedConfig} options.config
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @param {() => number} [options.now]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createHolidayCalendar(options) {
  const { cacheFile, config, logger } = options
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  const builtin = loadBuiltinDays(logger)
  /** @type {Record<string, 'holiday'|'makeup'>} */
  let onlineDays = {}
  /** @type {Record<string, number[]>} */
  let fetchedYears = {}
  let fetchedAt = null
  let lastError = null
  let lastSyncAt = null
  let syncing = null

  // Cache is read synchronously so calendar decisions are available to the
  // very first request after a restart.
  try {
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (cached?.version === CACHE_VERSION && cached.days !== null && typeof cached.days === 'object') {
        for (const [date, kind] of Object.entries(cached.days)) {
          if (isDateKey(date) && (kind === 'holiday' || kind === 'makeup')) onlineDays[date] = kind
        }
        fetchedYears = cached.fetchedYears ?? {}
        fetchedAt = typeof cached.fetchedAt === 'number' ? cached.fetchedAt : null
      }
    }
  } catch (error) {
    logger?.warn?.(`time-router: ignoring unreadable holiday cache at ${cacheFile}: ${String(error)}`)
  }

  function persistCache() {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const temporary = `${cacheFile}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, fetchedAt, fetchedYears, days: onlineDays }, null, 2))
      renameSync(temporary, cacheFile)
    } catch (error) {
      logger?.warn?.(`time-router: failed to write holiday cache at ${cacheFile}: ${String(error)}`)
    }
  }

  /** All override dates from configuration, as a lookup. */
  const overrides = config.holidays.overrides

  function yearOf(dateKey) {
    return Number(dateKey.slice(0, 4))
  }

  function hasYearData(year) {
    if (builtin.years[year] !== undefined) return true
    if (Array.isArray(fetchedYears[year])) return true
    return Object.keys(onlineDays).some((date) => yearOf(date) === year)
  }

  /**
   * @param {string} dateKey
   * @returns {{ kind: 'holiday'|'makeup-workday'|'workday'|'weekend', source: 'override'|'online'|'builtin'|'weekday', weekday: number }}
   */
  function dayKind(dateKey) {
    const weekday = weekdayOfDateKey(dateKey)
    const override = overrides[dateKey]
    if (override !== undefined) {
      return { kind: override === 'holiday' ? 'holiday' : 'makeup-workday', source: 'override', weekday }
    }
    const online = onlineDays[dateKey]
    if (online !== undefined) return { kind: online === 'holiday' ? 'holiday' : 'makeup-workday', source: 'online', weekday }
    const shipped = builtin.days[dateKey]
    if (shipped !== undefined) return { kind: shipped === 'holiday' ? 'holiday' : 'makeup-workday', source: 'builtin', weekday }
    if (weekday === 0 || weekday === 6) return { kind: 'weekend', source: 'weekday', weekday }
    return { kind: 'workday', source: 'weekday', weekday }
  }

  /** True when work happens on that calendar date. */
  function isWorkday(dateKey) {
    const { kind } = dayKind(dateKey)
    return kind === 'workday' || kind === 'makeup-workday'
  }

  function dayKindName(dateKey) {
    const { kind } = dayKind(dateKey)
    switch (kind) {
      case 'holiday':
        return 'statutory holiday'
      case 'makeup-workday':
        return 'makeup workday'
      case 'weekend':
        return 'weekend'
      default:
        return 'workday'
    }
  }

  /** Names plus data age, for the panel. */
  function status() {
    const at = now()
    const currentYear = Number(dateKeyOf(at, config.timezone).slice(0, 4))
    const coveredYears = new Set()
    for (const year of Object.keys(builtin.years)) coveredYears.add(Number(year))
    for (const year of Object.keys(fetchedYears)) coveredYears.add(Number(year))
    for (const date of Object.keys(onlineDays)) coveredYears.add(yearOf(date))
    return {
      sourceYears: [...coveredYears].sort((a, b) => a - b),
      years: [...coveredYears].sort((a, b) => a - b),
      currentYearCovered: hasYearData(currentYear),
      nextYearCovered: hasYearData(currentYear + 1),
      onlineEnabled: config.holidays.online,
      fetchedAt,
      lastSyncAt,
      lastError,
      overrides: Object.keys(overrides).length,
      cacheFile,
      builtinSources: builtin.sources,
    }
  }

  /** Actionable calendar warnings, worst first. */
  function warnings() {
    const at = now()
    const parts = zonedParts(at, config.timezone)
    const currentYear = parts.year
    const out = []
    if (!hasYearData(currentYear)) {
      out.push({
        level: 'error',
        code: 'calendar-missing-current-year',
        message: `No holiday data for ${currentYear}; only Monday–Friday is treated as a workday.`,
      })
    }
    const nextYearCovered = hasYearData(currentYear + 1)
    if (!nextYearCovered && (parts.month >= 12 || (parts.month === 11 && parts.day >= 1))) {
      out.push({
        level: 'warning',
        code: 'calendar-missing-next-year',
        message: `No holiday data for ${currentYear + 1} yet; ${currentYear + 1} weekends are treated as time off and weekdays as workdays until it is published.`,
      })
    }
    if (lastError !== null) {
      out.push({ level: 'warning', code: 'calendar-sync-failed', message: `Holiday sync failed: ${lastError}` })
    }
    return out
  }

  async function fetchSource(url) {
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'dsh-time-router/0.1' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fetch one calendar year from the configured sources, first success wins. */
  async function fetchYear(year) {
    const errors = []
    for (const template of config.holidays.sources) {
      const url = template.replaceAll('{year}', String(year))
      try {
        const payload = await fetchSource(url)
        const parsed = parseHolidayPayload(payload)
        return { year, url, ...parsed, errors }
      } catch (error) {
        errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(errors.join('; '))
  }

  /**
   * Refresh the calendar. Fetching the current and the following year keeps a
   * December request correct for both the tail of this year and the start of
   * the next one. Never throws; the panel renders the result.
   */
  async function sync() {
    if (syncing !== null) return syncing
    syncing = (async () => {
      const at = now()
      lastSyncAt = at
      const currentYear = Number(dateKeyOf(at, config.timezone).slice(0, 4))
      const wanted = [currentYear, currentYear + 1]
      const errors = []
      const updated = []
      for (const year of wanted) {
        if (!config.holidays.online) break
        const fresh = fetchedAt !== null && at - fetchedAt <= config.holidays.refreshDays * 86_400_000
        const known = Array.isArray(fetchedYears[year])
        if (fresh && known) continue
        try {
          const result = await fetchYear(year)
          for (const day of result.days) onlineDays[day.date] = day.kind
          fetchedYears[year] = result.days.length
          updated.push({ year, url: result.url, format: result.format, days: result.days.length })
        } catch (error) {
          errors.push(`year ${year}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (updated.length > 0) {
        fetchedAt = at
        persistCache()
      }
      lastError = errors.length > 0 ? errors.join(' | ') : null
      return { ok: errors.length === 0, fetchedAt, updated, errors, years: wanted }
    })().finally(() => {
      syncing = null
    })
    return syncing
  }

  return {
    dayKind,
    dayKindName,
    isWorkday,
    status,
    warnings,
    sync,
    /** @internal for tests */ parseHolidayPayload,
    _years: { builtin: builtin.years, fetched: fetchedYears },
  }
}
