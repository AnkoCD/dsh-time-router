import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { Scheduler } from '../src/schedule.js'
import { parseMinuteOfDay, weekdayOfDateKey, zonedInstant } from '../src/time.js'

const base = resolveConfig(undefined).config

/** Calendar stub: 2026-10-01 is a statutory holiday, 2026-09-27 a makeup workday. */
const calendar = {
  dayKind(dateKey) {
    const weekday = weekdayOfDateKey(dateKey)
    if (dateKey === '2026-10-01') return { kind: 'holiday', source: 'builtin', weekday }
    if (dateKey === '2026-09-27') return { kind: 'makeup-workday', source: 'builtin', weekday }
    if (weekday === 0 || weekday === 6) return { kind: 'weekend', source: 'weekday', weekday }
    return { kind: 'workday', source: 'weekday', weekday }
  },
}

const at = (dateKey, time) => zonedInstant(dateKey, parseMinuteOfDay(time), base.timezone)

function schedulerFor(overrides = {}) {
  const { config } = resolveConfig(overrides)
  return new Scheduler({ config, calendar, now: () => at('2026-11-09', '10:00') })
}

test('peak windows are half-open exact minutes on a weekday', () => {
  const scheduler = schedulerFor()
  const cases = [
    ['08:59', 'offPeak', 'outside-peak-window'],
    ['09:00', 'peak', 'peak-window'],
    ['11:59', 'peak', 'peak-window'],
    ['12:00', 'offPeak', 'outside-peak-window'],
    ['13:59', 'offPeak', 'outside-peak-window'],
    ['14:00', 'peak', 'peak-window'],
    ['17:59', 'peak', 'peak-window'],
    ['18:00', 'offPeak', 'outside-peak-window'],
  ]
  for (const [time, routeKey, reason] of cases) {
    const decision = scheduler.evaluate(at('2026-11-09', time))
    assert.equal(decision.routeKey, routeKey, `${time} should route ${routeKey}`)
    assert.equal(decision.reason, reason, `${time} reason`)
  }
})

test('weekends, statutory holidays and makeup workdays', () => {
  const scheduler = schedulerFor()
  assert.equal(scheduler.evaluate(at('2026-11-07', '10:00')).routeKey, 'offPeak') // Saturday
  assert.equal(scheduler.evaluate(at('2026-11-07', '10:00')).reason, 'weekend')
  const holiday = scheduler.evaluate(at('2026-10-01', '10:00'))
  assert.equal(holiday.routeKey, 'offPeak')
  assert.equal(holiday.reason, 'statutory-holiday')
  const makeup = scheduler.evaluate(at('2026-09-27', '10:00')) // Sunday, announced workday
  assert.equal(makeup.isWorkday, true)
  assert.equal(makeup.routeKey, 'peak')
})

test('nextSwitchAt reports the next minute boundary', () => {
  const scheduler = schedulerFor()
  assert.equal(scheduler.nextSwitchAt(at('2026-11-09', '08:00')), at('2026-11-09', '09:00'))
  assert.equal(scheduler.nextSwitchAt(at('2026-11-09', '09:00')), at('2026-11-09', '12:00'))
  assert.equal(scheduler.nextSwitchAt(at('2026-11-09', '12:30')), at('2026-11-09', '14:00'))
  assert.equal(scheduler.nextSwitchAt(at('2026-11-09', '18:30')), at('2026-11-10', '09:00'))
  assert.equal(scheduler.nextSwitchAt(at('2026-11-06', '18:30')), at('2026-11-09', '09:00')) // Friday evening → Monday
})

test('manual override wins, expires, and is reported', () => {
  const until = new Date(at('2026-11-09', '11:00')).toISOString()
  const scheduler = schedulerFor({ manual: { mode: 'offPeak', until } })
  const before = scheduler.evaluate(at('2026-11-09', '09:30'))
  assert.equal(before.routeKey, 'offPeak')
  assert.equal(before.reason, 'manual-offPeak')
  const after = scheduler.evaluate(at('2026-11-09', '11:30'))
  assert.equal(after.manual, 'auto') // the override expired
  assert.equal(after.routeKey, 'peak') // and the normal window rule applies again

  const pinned = schedulerFor({ manual: { mode: 'peak' } })
  assert.equal(pinned.evaluate(at('2026-11-07', '03:00')).routeKey, 'peak')
  assert.equal(pinned.nextSwitchAt(at('2026-11-07', '03:00')), null)
})

test('disabled pins the off-peak route and never switches', () => {
  const scheduler = schedulerFor({ enabled: false })
  const decision = scheduler.evaluate(at('2026-11-09', '10:00'))
  assert.equal(decision.routeKey, 'offPeak')
  assert.equal(decision.reason, 'disabled')
  assert.equal(scheduler.nextSwitchAt(at('2026-11-09', '10:00')), null)
})

test('debug.fakeNow pins the decision clock', () => {
  const { config } = resolveConfig({ debug: { fakeNow: '2026-11-09T02:30:00.000Z' } }) // 10:30 Beijing
  const scheduler = new Scheduler({ config, calendar, now: () => 0 })
  const decision = scheduler.evaluate()
  assert.equal(decision.timeOfDay, '10:30')
  assert.equal(decision.routeKey, 'peak')
  assert.equal(scheduler.describe().fakeNow, true)
})

test('system time zone does not affect the decision', () => {
  const scheduler = schedulerFor()
  const decision = scheduler.evaluate(Date.parse('2026-11-09T02:30:00.000Z'))
  assert.equal(decision.dateKey, '2026-11-09')
  assert.equal(decision.timeOfDay, '10:30')
  assert.equal(decision.routeKey, 'peak')
})

test('describe exposes the panel fields', () => {
  const described = schedulerFor().describe(at('2026-11-09', '10:00'))
  assert.equal(described.routeKey, 'peak')
  assert.equal(described.dayKind, 'workday')
  assert.equal(described.window.start, '09:00')
  assert.equal(described.weekdayName, 'Monday')
  assert.ok(described.nextSwitchZoned.endsWith('12:00:00'))
})
