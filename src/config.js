/**
 * Configuration resolution for dsh-time-router.
 *
 * The plugin imports no Harness packages: this module is plain ESM over
 * `node:` builtins so a linked workspace install works without node_modules.
 * `resolveConfig()` deep-merges defaults, validates the user's section of the
 * bundle patch, and returns `{ config, warnings }`.
 *
 * A route is either **direct** (the plugin owns an OpenAI-compatible endpoint)
 * or **delegated** (an existing Harness provider route, for example
 * `deepseek-official`). A route with `baseURL` is direct; otherwise it needs a
 * `provider` route id.
 *
 * @module dsh-time-router/config
 */

/** `HH:MM` in 24-hour local time. */
export const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** `YYYY-MM-DD` calendar date. */
export const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** Default online holiday sources, tried in order. `{year}` is substituted. */
export const DEFAULT_HOLIDAY_SOURCES = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
  'https://timor.tech/api/holiday/year/{year}',
]

/** Every default the plugin knows about; the user config is merged over it. */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  timezone: 'Asia/Shanghai',
  peakWindows: [
    ['09:00', '12:00'],
    ['14:00', '18:00'],
  ],
  peak: Object.freeze({
    baseURL: 'https://opencode.ai/inference/go/openai/v1',
    apiKeyEnv: 'OPENCODE_API_KEY',
    apiKeyFile: null,
    apiKey: null,
    headers: Object.freeze({}),
    models: Object.freeze({ chat: 'deepseek-v4.1-flash', reasoner: 'deepseek-v4-pro' }),
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    inputModalities: Object.freeze(['text']),
    reasoningEfforts: Object.freeze(['low', 'high', 'max']),
    requestTimeoutMs: 600_000,
  }),
  offPeak: Object.freeze({
    provider: 'deepseek-official',
    models: Object.freeze({ chat: 'deepseek-flash', reasoner: 'deepseek-v4-pro' }),
  }),
  virtual: Object.freeze({
    provider: 'time-router',
    models: Object.freeze({ chat: 'auto-chat', reasoner: 'auto-reasoner' }),
  }),
  manual: Object.freeze({ mode: 'auto', until: null }),
  fallback: Object.freeze({
    enabled: true,
    sameProviderRetry: 1,
    quotaCooldownMinutes: 30,
    authCooldownMinutes: 0,
  }),
  holidays: Object.freeze({
    online: true,
    refreshDays: 7,
    sources: Object.freeze([...DEFAULT_HOLIDAY_SOURCES]),
    overrides: Object.freeze({}),
  }),
  status: Object.freeze({ maxEvents: 200, logFile: true, rotateBytes: 5 * 1024 * 1024, rotateFiles: 3 }),
  debug: Object.freeze({ fakeNow: null, probeTool: false }),
})

const MANUAL_MODES = new Set(['auto', 'peak', 'offPeak'])
const OVERRIDE_KINDS = new Set(['holiday', 'workday'])
const ROUTE_KEYS = ['peak', 'offPeak']
const DIRECT_KEYS = ['label', 'baseURL', 'apiKeyEnv', 'apiKeyFile', 'apiKey', 'headers', 'models', 'contextWindow', 'maxTokens', 'inputModalities', 'reasoningEfforts', 'requestTimeoutMs']
const DELEGATED_KEYS = ['provider', 'models']
const API_KEY_NAME = /^[A-Z_][A-Z0-9_]*$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, child] of Object.entries(value)) out[key] = clone(child)
    return out
  }
  return value
}

/** Merge `over` over `base` without mutating either; arrays replace wholesale. */
export function mergeConfig(base, over) {
  if (!isPlainObject(over)) return clone(base)
  const out = clone(base)
  for (const [key, value] of Object.entries(over)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value)
    else out[key] = clone(value)
  }
  return out
}

function warnUnknown(section, value, known, warnings, where) {
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) warnings.push({ key: `${where}.${key}`, message: `unknown configuration key "${where}.${key}"` })
  }
}

function requireString(value, where) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`dsh-time-router: ${where} must be a non-empty string`)
  return value.trim()
}

function requireInt(value, where, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`dsh-time-router: ${where} must be an integer from ${min} through ${max}`)
  return value
}

function parseTimeOfDay(value, where) {
  if (typeof value !== 'string' || !TIME_OF_DAY.test(value)) throw new Error(`dsh-time-router: ${where} must look like "HH:MM" (24-hour), got ${JSON.stringify(value)}`)
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function validateTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
    return timezone
  } catch {
    throw new Error(`dsh-time-router: timezone ${JSON.stringify(timezone)} is not an IANA time zone name`)
  }
}

function normalizeModalities(value, where) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`dsh-time-router: ${where} must be a non-empty list containing "text" and optionally "image"`)
  const out = []
  for (const modality of value) {
    if (modality !== 'text' && modality !== 'image') throw new Error(`dsh-time-router: ${where} contains unknown modality ${JSON.stringify(modality)}`)
    if (!out.includes(modality)) out.push(modality)
  }
  if (!out.includes('text')) out.unshift('text')
  return out
}

function resolveRoute(routeKey, value, warnings) {
  const where = routeKey
  if (!isPlainObject(value)) throw new Error(`dsh-time-router: ${where} must be an object`)
  const direct = typeof value.baseURL === 'string' && value.baseURL.trim().length > 0
  const allowed = direct ? DIRECT_KEYS : DELEGATED_KEYS
  warnUnknown(where, value, allowed, warnings, where)
  if (!isPlainObject(value.models)) throw new Error(`dsh-time-router: ${where}.models must be an object with chat and reasoner model ids`)
  warnUnknown(`${where}.models`, value.models, ['chat', 'reasoner'], warnings, `${where}.models`)
  const models = {
    chat: requireString(value.models.chat, `${where}.models.chat`),
    reasoner: requireString(value.models.reasoner, `${where}.models.reasoner`),
  }
  if (!direct) {
    return {
      mode: 'delegated',
      routeKey,
      provider: requireString(value.provider, `${where}.provider`),
      models,
      label: requireString(value.provider, `${where}.provider`),
    }
  }
  const baseURL = requireString(value.baseURL, `${where}.baseURL`)
  if (!/^https?:\/\//i.test(baseURL)) throw new Error(`dsh-time-router: ${where}.baseURL must be an http(s) URL`)
  const headers = {}
  if (value.headers !== undefined) {
    if (!isPlainObject(value.headers)) throw new Error(`dsh-time-router: ${where}.headers must be a mapping of header names to strings`)
    for (const [name, headerValue] of Object.entries(value.headers)) {
      if (typeof headerValue !== 'string') throw new Error(`dsh-time-router: ${where}.headers.${name} must be a string`)
      headers[name] = headerValue
    }
  }
  const apiKeyEnv = value.apiKeyEnv === null || value.apiKeyEnv === undefined ? null : requireString(value.apiKeyEnv, `${where}.apiKeyEnv`)
  if (apiKeyEnv !== null && !API_KEY_NAME.test(apiKeyEnv)) throw new Error(`dsh-time-router: ${where}.apiKeyEnv must be an environment variable name like OPENCODE_API_KEY`)
  const apiKeyFile = value.apiKeyFile === null || value.apiKeyFile === undefined ? null : requireString(value.apiKeyFile, `${where}.apiKeyFile`)
  const apiKey = value.apiKey === null || value.apiKey === undefined ? null : requireString(value.apiKey, `${where}.apiKey`)
  if (apiKey !== null) warnings.push({ key: `${where}.apiKey`, message: `${where}.apiKey stores a secret in the profile patch; prefer apiKeyEnv or a key file` })
  if (apiKey === null && apiKeyEnv === null && apiKeyFile === null) {
    warnings.push({ key: `${where}.apiKeyEnv`, message: `${where} has no key source; until one is configured this route fails with MISSING_CREDENTIAL and turns fall back` })
  }
  const reasoningEfforts = Array.isArray(value.reasoningEfforts) && value.reasoningEfforts.length > 0
    ? value.reasoningEfforts.map((effort, index) => requireString(effort, `${where}.reasoningEfforts[${index}]`))
    : undefined
  let label = value.label === undefined || value.label === null ? null : requireString(value.label, `${where}.label`)
  if (label === null) {
    try {
      const host = new URL(baseURL).hostname
      label = host === 'opencode.ai' ? 'OpenCode Go' : host
    } catch {
      label = `direct-${routeKey}`
    }
  }
  return {
    mode: 'direct',
    routeKey,
    label,
    baseURL,
    apiKeyEnv,
    apiKeyFile,
    apiKey,
    headers,
    models,
    contextWindow: requireInt(value.contextWindow ?? 262_144, `${where}.contextWindow`, 1, 10_000_000),
    maxTokens: requireInt(value.maxTokens ?? 32_768, `${where}.maxTokens`, 1, 10_000_000),
    inputModalities: normalizeModalities(value.inputModalities ?? ['text'], `${where}.inputModalities`),
    reasoningEfforts,
    requestTimeoutMs: requireInt(value.requestTimeoutMs ?? 600_000, `${where}.requestTimeoutMs`, 1_000, 3_600_000),
  }
}

/**
 * @typedef {object} ResolvedConfig
 * @property {boolean} enabled
 * @property {string} timezone
 * @property {{ raw: [string, string], start: number, end: number }[]} windows
 * @property {any} peak
 * @property {any} offPeak
 * @property {any} virtual
 * @property {{ mode: 'auto' | 'peak' | 'offPeak', until: string | null, untilMs: number | null }} manual
 * @property {any} fallback
 * @property {any} holidays
 * @property {any} status
 * @property {{ fakeNow: string | null, fakeNowMs: number | null, probeTool: boolean }} debug
 * @property {{ routeKey: 'peak' | 'offPeak', route: any, [key: string]: any }[]} targets
 */

/**
 * Merge and validate the row's raw `config` value.
 * @param {unknown} raw the plugin row's config (may be undefined).
 * @returns {{ config: ResolvedConfig, warnings: { key: string, message: string }[] }}
 */
export function resolveConfig(raw) {
  const warnings = []
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    throw new Error('dsh-time-router: config must be a mapping')
  }
  const merged = mergeConfig(CONFIG_DEFAULTS, raw ?? {})
  warnUnknown('config', merged, Object.keys(CONFIG_DEFAULTS), warnings, 'config')

  const config = /** @type {any} */ ({ ...merged })
  config.enabled = merged.enabled !== false
  config.timezone = validateTimeZone(requireString(merged.timezone, 'timezone'))

  if (!Array.isArray(merged.peakWindows) || merged.peakWindows.length === 0) {
    throw new Error('dsh-time-router: peakWindows must be a non-empty list of ["HH:MM", "HH:MM"] pairs')
  }
  const windows = []
  for (const [index, pair] of merged.peakWindows.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`dsh-time-router: peakWindows[${index}] must be a ["HH:MM", "HH:MM"] pair`)
    const start = parseTimeOfDay(pair[0], `peakWindows[${index}][0]`)
    const end = parseTimeOfDay(pair[1], `peakWindows[${index}][1]`)
    if (start === end) throw new Error(`dsh-time-router: peakWindows[${index}] starts and ends at the same time`)
    if (start > end) throw new Error(`dsh-time-router: peakWindows[${index}] must not wrap past midnight; split it into two windows`)
    windows.push({ raw: [pair[0], pair[1]], start, end })
  }
  windows.sort((a, b) => a.start - b.start)
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].start < windows[index - 1].end) {
      warnings.push({ key: `peakWindows[${index}]`, message: `peak windows ${JSON.stringify(windows[index - 1].raw)} and ${JSON.stringify(windows[index].raw)} overlap; the union is used` })
    }
  }
  config.windows = windows

  // Route sections do not inherit the *other* mode's defaults: an explicit
  // `provider` selects a delegated route (no inherited baseURL), while an
  // explicit `baseURL` selects a direct one.
  for (const routeKey of ROUTE_KEYS) {
    const rawRoute = isPlainObject(raw?.[routeKey]) ? raw[routeKey] : undefined
    const delegated = rawRoute !== undefined && rawRoute.provider !== undefined && rawRoute.baseURL === undefined
    const base = delegated ? { models: CONFIG_DEFAULTS[routeKey].models } : CONFIG_DEFAULTS[routeKey]
    const mergedRoute = mergeConfig(base, rawRoute ?? {})
    if (rawRoute !== undefined && rawRoute.label === undefined && mergedRoute.label !== undefined) delete mergedRoute.label
    config[routeKey] = resolveRoute(routeKey, mergedRoute, warnings)
  }
  config.virtual = (() => {
    const value = merged.virtual
    if (!isPlainObject(value)) throw new Error('dsh-time-router: virtual must be an object with provider and models')
    warnUnknown('virtual', value, ['provider', 'models'], warnings, 'virtual')
    if (!isPlainObject(value.models)) throw new Error('dsh-time-router: virtual.models must be an object with chat and reasoner model ids')
    return {
      provider: requireString(value.provider, 'virtual.provider'),
      models: {
        chat: requireString(value.models.chat, 'virtual.models.chat'),
        reasoner: requireString(value.models.reasoner, 'virtual.models.reasoner'),
      },
    }
  })()

  for (const routeKey of ROUTE_KEYS) {
    if (config[routeKey].mode === 'delegated' && config[routeKey].provider === config.virtual.provider) {
      throw new Error(`dsh-time-router: ${routeKey}.provider must differ from virtual.provider (the virtual route registers its own adapter)`)
    }
  }
  if (config.peak.mode === 'delegated' && config.offPeak.mode === 'delegated' && config.peak.provider === config.offPeak.provider) {
    warnings.push({ key: 'peak.provider', message: 'peak.provider and offPeak.provider name the same route; time routing has no effect until they differ' })
  }
  if (config.virtual.models.chat === config.virtual.models.reasoner) {
    warnings.push({ key: 'virtual.models', message: 'virtual.models.chat and virtual.models.reasoner are identical; one virtual model is enough' })
  }

  if (!isPlainObject(merged.manual)) throw new Error('dsh-time-router: manual must be an object with mode and until')
  warnUnknown('manual', merged.manual, ['mode', 'until'], warnings, 'manual')
  const mode = merged.manual.mode ?? 'auto'
  if (!MANUAL_MODES.has(mode)) throw new Error(`dsh-time-router: manual.mode must be one of ${[...MANUAL_MODES].join(', ')}`)
  const until = merged.manual.until ?? null
  let untilMs = null
  if (until !== null) {
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) throw new Error('dsh-time-router: manual.until must be null or an ISO 8601 timestamp')
    untilMs = Date.parse(until)
  }
  config.manual = { mode, until, untilMs }
  if (mode === 'auto' && until !== null) warnings.push({ key: 'manual.until', message: 'manual.until is ignored while manual.mode is "auto"' })

  const fallback = merged.fallback
  if (!isPlainObject(fallback)) throw new Error('dsh-time-router: fallback must be an object')
  warnUnknown('fallback', fallback, Object.keys(CONFIG_DEFAULTS.fallback), warnings, 'fallback')
  config.fallback = {
    enabled: fallback.enabled !== false,
    sameProviderRetry: requireInt(fallback.sameProviderRetry ?? 1, 'fallback.sameProviderRetry', 0, 3),
    quotaCooldownMinutes: requireInt(fallback.quotaCooldownMinutes ?? 30, 'fallback.quotaCooldownMinutes', 1, 24 * 60),
    authCooldownMinutes: requireInt(fallback.authCooldownMinutes ?? 0, 'fallback.authCooldownMinutes', 0, 24 * 60),
  }

  const holidays = merged.holidays
  if (!isPlainObject(holidays)) throw new Error('dsh-time-router: holidays must be an object')
  warnUnknown('holidays', holidays, Object.keys(CONFIG_DEFAULTS.holidays), warnings, 'holidays')
  if (!Array.isArray(holidays.sources) || holidays.sources.length === 0) throw new Error('dsh-time-router: holidays.sources must be a non-empty list of URL templates')
  const sources = holidays.sources.map((source, index) => {
    const url = requireString(source, `holidays.sources[${index}]`)
    if (!url.includes('{year}')) throw new Error(`dsh-time-router: holidays.sources[${index}] must contain the {year} placeholder`)
    return url
  })
  const overrides = holidays.overrides ?? {}
  if (!isPlainObject(overrides)) throw new Error('dsh-time-router: holidays.overrides must map date keys to "holiday" or "workday"')
  const resolvedOverrides = {}
  for (const [date, kind] of Object.entries(overrides)) {
    if (!DATE_KEY.test(date)) throw new Error(`dsh-time-router: holidays.overrides has invalid date key ${JSON.stringify(date)}; use YYYY-MM-DD`)
    if (!OVERRIDE_KINDS.has(kind)) throw new Error(`dsh-time-router: holidays.overrides[${date}] must be "holiday" or "workday"`)
    resolvedOverrides[date] = kind
  }
  config.holidays = {
    online: holidays.online !== false,
    refreshDays: requireInt(holidays.refreshDays ?? 7, 'holidays.refreshDays', 1, 365),
    sources,
    overrides: resolvedOverrides,
  }

  const status = merged.status
  if (!isPlainObject(status)) throw new Error('dsh-time-router: status must be an object')
  warnUnknown('status', status, Object.keys(CONFIG_DEFAULTS.status), warnings, 'status')
  config.status = {
    maxEvents: requireInt(status.maxEvents ?? 200, 'status.maxEvents', 10, 2000),
    logFile: status.logFile !== false,
    rotateBytes: requireInt(status.rotateBytes ?? 5 * 1024 * 1024, 'status.rotateBytes', 64 * 1024, 512 * 1024 * 1024),
    rotateFiles: requireInt(status.rotateFiles ?? 3, 'status.rotateFiles', 0, 9),
  }

  const debug = merged.debug
  if (!isPlainObject(debug)) throw new Error('dsh-time-router: debug must be an object')
  warnUnknown('debug', debug, Object.keys(CONFIG_DEFAULTS.debug), warnings, 'debug')
  let fakeNowMs = null
  if (debug.fakeNow !== null && debug.fakeNow !== undefined && debug.fakeNow !== '') {
    if (typeof debug.fakeNow !== 'string' || Number.isNaN(Date.parse(debug.fakeNow))) {
      throw new Error('dsh-time-router: debug.fakeNow must be null or an ISO 8601 timestamp')
    }
    fakeNowMs = Date.parse(debug.fakeNow)
  }
  config.debug = { fakeNow: debug.fakeNow ?? null, fakeNowMs, probeTool: debug.probeTool === true }
  config.targets = ROUTE_KEYS.map((routeKey) => ({ routeKey, route: config[routeKey] }))
  return { config, warnings }
}
