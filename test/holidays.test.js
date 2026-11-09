import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { createHolidayCalendar, parseHolidayPayload } from '../src/holidays.js'

const { config } = resolveConfig(undefined)
const NOW = Date.parse('2026-11-09T02:30:00.000Z') // 10:30 Beijing

function calendarAt(directory, fetchImpl) {
  return createHolidayCalendar({
    cacheFile: join(directory, 'holidays.cache.json'),
    config,
    now: () => NOW,
    fetchImpl,
  })
}

test('shipped 2025-2027 data classifies holidays, weekends and makeup workdays', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-time-router-holidays-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calendar = calendarAt(directory)
  assert.equal(calendar.dayKind('2026-01-02').kind, 'holiday') // New Year span
  assert.equal(calendar.dayKind('2026-01-04').kind, 'makeup-workday') // Sunday announced as working
  assert.equal(calendar.dayKind('2026-02-17').kind, 'holiday') // Spring Festival
  assert.equal(calendar.dayKind('2026-02-14').kind, 'makeup-workday') // Saturday announced as working
  assert.equal(calendar.dayKind('2026-03-07').kind, 'weekend')
  assert.equal(calendar.dayKind('2026-03-09').kind, 'workday')
  assert.equal(calendar.dayKind('2027-10-07').kind, 'holiday')
  assert.equal(calendar.dayKind('2027-09-26').kind, 'makeup-workday')
  const status = calendar.status()
  assert.equal(status.currentYearCovered, true)
  assert.equal(status.nextYearCovered, true)
  assert.deepEqual(status.years, [2025, 2026, 2027])
  assert.deepEqual(calendar.warnings(), [])
})

test('overrides win over shipped data', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-time-router-holidays-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { config: overridden } = resolveConfig({ holidays: { overrides: { '2026-03-09': 'holiday', '2026-03-07': 'workday' } } })
  const calendar = createHolidayCalendar({ cacheFile: join(directory, 'cache.json'), config: overridden, now: () => NOW })
  assert.equal(calendar.dayKind('2026-03-09').kind, 'holiday')
  assert.equal(calendar.dayKind('2026-03-09').source, 'override')
  assert.equal(calendar.dayKind('2026-03-07').kind, 'makeup-workday')
})

test('online holiday-cn payloads are parsed, merged and cached', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-time-router-holidays-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const requests = []
  const fetchImpl = async (url) => {
    requests.push(url)
    const year = Number(/holidays-(\d{4})/.exec(url)?.[1] ?? 2026)
    const days = [{ name: 'test', date: `${year}-12-31`, isOffDay: true }]
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ year, days }) }
  }
  const calendar = calendarAt(directory, fetchImpl)
  const result = await calendar.sync()
  assert.equal(result.ok, true)
  assert.equal(result.updated.length, 2)
  assert.equal(requests.length, 2)
  assert.equal(calendar.dayKind('2026-12-31').kind, 'holiday')
  assert.equal(calendar.dayKind('2026-12-31').source, 'online')
})

test('timor payload format is understood', () => {
  const parsed = parseHolidayPayload({
    code: 0,
    holiday: {
      '01-01': { holiday: true, name: '元旦', date: '2026-01-01' },
      '01-04': { holiday: false, name: '补班', date: '2026-01-04', after: true },
    },
  })
  assert.equal(parsed.format, 'timor')
  assert.deepEqual(parsed.days, [
    { date: '2026-01-01', kind: 'holiday' },
    { date: '2026-01-04', kind: 'makeup' },
  ])
})

test('unrecognized payloads fail and keep the previous calendar', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-time-router-holidays-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ nothing: true }) })
  const calendar = calendarAt(directory, fetchImpl)
  const result = await calendar.sync()
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
  assert.equal(calendar.dayKind('2026-02-17').kind, 'holiday') // shipped data still works
  assert.ok(calendar.warnings().some((warning) => warning.code === 'calendar-sync-failed'))
})

test('a year without any data falls back to weekdays only with a warning', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-time-router-holidays-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const farFuture = Date.parse('2030-06-03T02:00:00.000Z')
  const calendar = createHolidayCalendar({ cacheFile: join(directory, 'cache.json'), config, now: () => farFuture })
  assert.equal(calendar.dayKind('2030-06-03').kind, 'workday')
  const warnings = calendar.warnings()
  assert.ok(warnings.some((warning) => warning.code === 'calendar-missing-current-year'))
})
