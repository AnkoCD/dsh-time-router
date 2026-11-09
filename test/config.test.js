import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, mergeConfig, DEFAULT_HOLIDAY_SOURCES } from '../src/config.js'

test('defaults produce direct peak and delegated off-peak routes', () => {
  const { config, warnings } = resolveConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.timezone, 'Asia/Shanghai')
  assert.equal(config.peak.mode, 'direct')
  assert.equal(config.peak.label, 'OpenCode Go')
  assert.equal(config.peak.baseURL, 'https://opencode.ai/inference/go/openai/v1')
  assert.equal(config.peak.models.chat, 'deepseek-v4.1-flash')
  assert.equal(config.offPeak.mode, 'delegated')
  assert.equal(config.offPeak.provider, 'deepseek-official')
  assert.equal(config.virtual.provider, 'time-router')
  assert.deepEqual(config.windows.map((window) => window.raw), [['09:00', '12:00'], ['14:00', '18:00']])
  assert.equal(config.holidays.sources.length, DEFAULT_HOLIDAY_SOURCES.length)
  assert.deepEqual(warnings, [])
})

test('a baseURL switches a route to direct and keeps key sources', () => {
  const { config, warnings } = resolveConfig({
    peak: { baseURL: 'https://proxy.example/v1', apiKeyEnv: 'MY_KEY', models: { chat: 'a', reasoner: 'b' }, contextWindow: 128000, maxTokens: 8192 },
    offPeak: { provider: 'my-route' },
  })
  assert.equal(config.peak.mode, 'direct')
  assert.equal(config.peak.label, 'proxy.example')
  assert.equal(config.peak.apiKeyEnv, 'MY_KEY')
  assert.equal(config.offPeak.provider, 'my-route')
  assert.deepEqual(warnings, [])
})

test('reversed, equal and malformed windows are rejected', () => {
  assert.throws(() => resolveConfig({ peakWindows: [['12:00', '09:00']] }), /wrap past midnight/)
  assert.throws(() => resolveConfig({ peakWindows: [['09:00', '09:00']] }), /same time/)
  assert.throws(() => resolveConfig({ peakWindows: [['9:00', '12:00']] }), /HH:MM/)
  assert.throws(() => resolveConfig({ peakWindows: [] }), /non-empty/)
  const { warnings } = resolveConfig({ peakWindows: [['09:00', '12:00'], ['11:00', '13:00']] })
  assert.ok(warnings.some((warning) => warning.key === 'peakWindows[1]'))
})

test('a delegated route that collides with the virtual provider is rejected', () => {
  assert.throws(
    () => resolveConfig({ offPeak: { provider: 'time-router', models: { chat: 'a', reasoner: 'b' } } }),
    /must differ from virtual\.provider/,
  )
})

test('bad overrides, timezone and manual values are rejected with clear errors', () => {
  assert.throws(() => resolveConfig({ timezone: 'Mars/Olympus' }), /IANA time zone/)
  assert.throws(() => resolveConfig({ holidays: { overrides: { '2026-1-1': 'holiday' } } }), /invalid date key/)
  assert.throws(() => resolveConfig({ holidays: { overrides: { '2026-01-01': 'maybe' } } }), /must be "holiday" or "workday"/)
  assert.throws(() => resolveConfig({ manual: { mode: 'sometimes' } }), /manual\.mode/)
  assert.throws(() => resolveConfig({ manual: { until: 'tomorrow' } }), /ISO 8601/)
  assert.throws(() => resolveConfig({ debug: { fakeNow: 'not-a-date' } }), /ISO 8601/)
})

test('unknown keys warn instead of failing', () => {
  const { warnings } = resolveConfig({ totallyUnknown: 1, peak: { label: 'P', baseURL: 'https://x/v1', models: { chat: 'a', reasoner: 'b' }, extra: true } })
  assert.ok(warnings.some((warning) => warning.message.includes('totallyUnknown')))
  assert.ok(warnings.some((warning) => warning.message.includes('peak.extra')))
})

test('mergeConfig replaces arrays and merges nested objects', () => {
  const merged = mergeConfig({ a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }, { nested: { y: 3 }, list: [9] })
  assert.deepEqual(merged, { a: 1, nested: { x: 1, y: 3 }, list: [9] })
})
