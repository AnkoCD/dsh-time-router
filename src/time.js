/**
 * Time-zone-safe clock helpers.
 *
 * Routing must not depend on the machine's time zone, so every calendar
 * question is answered from an explicit IANA zone through `Intl`. `Date`
 * objects are still used only as instants; their local getters are avoided
 * everywhere in the plugin.
 *
 * @module dsh-time-router/time
 */

const FORMATTERS = new Map()

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

/** @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: string }} */
export function zonedParts(instant, timeZone) {
  const values = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: values.weekday,
  }
}

const pad = (value) => String(value).padStart(2, '0')

/** `YYYY-MM-DD` for one zoned instant. */
export function dateKeyOf(instant, timeZone) {
  const parts = zonedParts(instant, timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

/** Minutes since local midnight for one zoned instant. */
export function minuteOfDayOf(instant, timeZone) {
  const parts = zonedParts(instant, timeZone)
  return parts.hour * 60 + parts.minute
}

/** Parse `YYYY-MM-DD`; throws on a malformed key. */
export function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (match === null) throw new Error(`invalid date key ${JSON.stringify(dateKey)}`)
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/** 0 = Sunday … 6 = Saturday for a calendar date. */
export function weekdayOfDateKey(dateKey) {
  const { year, month, day } = parseDateKey(dateKey)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** Shift a calendar date by whole days. */
export function addDaysToDateKey(dateKey, days) {
  const { year, month, day } = parseDateKey(dateKey)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * The instant at which the wall clock in `timeZone` reads `dateKey` at
 * `minuteOfDay`. Derived by fixing the zoned reading iteratively, which is
 * correct across DST transitions for the forward direction this plugin uses.
 */
export function zonedInstant(dateKey, minuteOfDay, timeZone) {
  const { year, month, day } = parseDateKey(dateKey)
  const wanted = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0)
  let guess = wanted
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = zonedParts(guess, timeZone)
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
    const difference = wanted - actual
    if (difference === 0) break
    guess += difference
  }
  return guess
}

/** `HH:MM` from minutes since midnight. */
export function formatMinuteOfDay(minuteOfDay) {
  const normalized = ((minuteOfDay % 1440) + 1440) % 1440
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`
}

/** Parse `HH:MM` (validated by the config resolver) into minutes. */
export function parseMinuteOfDay(value) {
  const [hour, minute] = String(value).split(':').map(Number)
  return hour * 60 + minute
}

/** ISO timestamp.
 * @param {number | Date} instant
 */
export function iso(instant) {
  return new Date(instant).toISOString()
}

/** Human-readable `YYYY-MM-DD HH:MM:SS` in a zone, for logs and panels. */
export function formatZoned(instant, timeZone) {
  const parts = zonedParts(instant, timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
}
