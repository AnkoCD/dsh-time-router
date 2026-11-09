/**
 * dsh-time-router — time-of-day LLM routing for DeepSeek Harness.
 *
 * Host half: registers the virtual provider (`time-router` / `auto-chat`,
 * `auto-reasoner`), intercepts the `llm/stream` waterfall for that provider,
 * and answers each request from the peak or off-peak route chosen for the
 * current turn. See README.zh.md for the full behaviour contract.
 *
 * The plugin imports no `@deepseek-ai/*` package. Everything the Harness needs
 * is duck-typed against published contracts (`LlmAdapter` methods, the
 * `llm/stream` waterfall, `commands`, `webServer`, `configEditor`), so a
 * `link:`-installed workspace checkout runs without node_modules.
 *
 * @module dsh-time-router
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createApi } from './src/api.js'
import { createVirtualAdapter } from './src/adapter.js'
import { Breakers } from './src/breakers.js'
import { resolveConfig } from './src/config.js'
import { createHolidayCalendar } from './src/holidays.js'
import { TurnLocks } from './src/locks.js'
import { createDirectClient } from './src/openai.js'
import { Router } from './src/router.js'
import { Scheduler } from './src/schedule.js'
import { StatusStore } from './src/status.js'

export const VERSION = '0.1.0'

/** The only hard dependency: the LLM service the virtual route registers on. */
export const inject = ['llm']

function dshHomePath() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

function describeRouteForCommand(router, config, routeKey) {
  const target = router.targetFor(routeKey, 'chat')
  const route = config[routeKey]
  const breaker = router.breakers.check(target.provider, target.model)
  const label = route.mode === 'direct'
    ? `${route.label} (${route.models.chat} / ${route.models.reasoner})`
    : `${route.provider} (${route.models.chat} / ${route.models.reasoner})`
  return breaker === undefined
    ? label
    : `${label} — cooling down (${breaker.reason})`
}

/**
 * @param {any} ctx Cordis plugin context
 * @param {unknown} rawConfig row configuration
 */
export function apply(ctx, rawConfig) {
  const dshHome = dshHomePath()
  const { config, warnings } = resolveConfig(rawConfig)
  for (const warning of warnings) ctx.logger.warn(`time-router: ${warning.message}`)

  const runtime = { serverSkewMs: null }
  const nowImpl = () => Date.now()

  /** Wrap fetch to capture the provider's Date header for clock-skew display. */
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init)
    try {
      const header = response.headers.get('date')
      if (header !== null) {
        const server = Date.parse(header)
        if (!Number.isNaN(server)) runtime.serverSkewMs = server - Date.now()
      }
    } catch {
      // Clock skew is advisory only.
    }
    return response
  }

  const calendar = createHolidayCalendar({
    cacheFile: join(dshHome, 'plugins', 'time-router', 'holidays.cache.json'),
    config,
    logger: ctx.logger,
    now: nowImpl,
    fetchImpl,
  })
  const scheduler = new Scheduler({ config, calendar, now: nowImpl })
  const locks = new TurnLocks()
  const breakers = new Breakers({ now: nowImpl })
  const status = new StatusStore({
    eventsFile: config.status.logFile ? join(dshHome, 'plugins', 'time-router', 'events.jsonl') : null,
    maxEvents: config.status.maxEvents,
    rotateBytes: config.status.rotateBytes,
    rotateFiles: config.status.rotateFiles,
    logger: ctx.logger,
  })
  const clients = new Map()
  for (const routeKey of ['peak', 'offPeak']) {
    const route = config[routeKey]
    if (route.mode === 'direct') clients.set(routeKey, createDirectClient({ routeKey, route, dshHome, logger: ctx.logger }))
  }
  const router = new Router({
    ctx,
    llm: ctx.llm,
    config,
    scheduler,
    calendar,
    locks,
    breakers,
    status,
    clients,
    dshHome,
    logger: ctx.logger,
  })

  // 1. The virtual route must exist before any session can select it.
  const adapter = createVirtualAdapter({
    router,
    provider: config.virtual.provider,
    models: config.virtual.models,
    warn: (message) => ctx.logger.warn(message),
  })
  ctx.llm.registerAdapter([config.virtual.provider], adapter)

  // 2. Dispatch is answered from the waterfall, before adapter projection runs.
  ctx.on('llm/stream', (options, next) => router.intercept(options, next))
  ctx.on('llm/adapters-updated', () => router.invalidateCapabilities())
  ctx.on('llm/models-updated', () => router.invalidateCapabilities())

  // 3. The calendar refreshes in the background; routing never waits on it.
  const syncCalendar = async () => {
    try {
      const result = await calendar.sync()
      if (!result.ok) ctx.logger.warn(`time-router: holiday sync incomplete: ${result.errors.join('; ')}`)
      else if (result.updated.length > 0) ctx.logger.info(`time-router: holiday calendar updated (${result.updated.map((entry) => entry.year).join(', ')}).`)
    } catch (error) {
      ctx.logger.warn(`time-router: holiday sync failed: ${String(error)}`)
    }
  }
  if (config.holidays.online) {
    void syncCalendar()
    const timer = setInterval(() => void syncCalendar(), 6 * 60 * 60 * 1000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'time-router holiday refresh timer')
  }

  // 4. A slash command is the lightweight, zero-token status surface.
  const renderStatus = () => {
    const described = scheduler.describe()
    const usage = status.usage(described.dateKey)
    const lines = [
      `Time router ${VERSION}${config.enabled ? '' : ' (disabled: pinned to off-peak)'}`,
      `Now: ${described.zoned} (${described.weekdayName}, ${described.dayKind})`,
      `Route: ${described.routeKey === 'peak' ? 'peak' : 'off-peak'} — ${described.reason}${described.manual === 'auto' ? '' : ` (manual ${described.manual})`}`,
      `Next switch: ${described.nextSwitchZoned ?? 'pinned'}`,
      `Peak: ${describeRouteForCommand(router, config, 'peak')}`,
      `Off-peak: ${describeRouteForCommand(router, config, 'offPeak')}`,
      `Today: peak ${usage.today?.peak.input ?? 0}↑/${usage.today?.peak.output ?? 0}↓ tokens, off-peak ${usage.today?.offPeak.input ?? 0}↑/${usage.today?.offPeak.output ?? 0}↓ tokens`,
    ]
    for (const warning of calendar.warnings()) lines.push(`${warning.level === 'error' ? '✖' : '⚠'} ${warning.message}`)
    for (const notice of router.recentNotices(3)) lines.push(`• ${notice.message}`)
    if (config.debug.fakeNowMs !== null) lines.push(`⚠ Debug fakeNow is active: ${config.debug.fakeNow}`)
    return lines.join('\n')
  }

  ctx.inject(['commands'], (child) => {
    child.effect(() => child.commands.register({
      name: 'time-router',
      description: 'Show time-routing status, or run "probe", "sync" or "reset"',
      input: { hint: '[probe|sync|reset]' },
      handler: async ({ rawInput }) => {
        const action = String(rawInput ?? '').trim().toLowerCase()
        if (action === 'reset') {
          const count = breakers.reset()
          return { kind: 'success', text: `Time router: reset ${count} circuit breaker${count === 1 ? '' : 's'}.` }
        }
        if (action === 'sync') {
          const result = await calendar.sync()
          return {
            kind: result.ok ? 'success' : 'error',
            text: result.ok
              ? `Time router: holiday calendar synced (${result.updated.length} year(s) updated).`
              : `Time router: holiday sync failed: ${result.errors.join('; ')}`,
          }
        }
        if (action === 'probe') {
          let text = ''
          let finish = null
          try {
            for await (const chunk of ctx.llm.stream({
              provider: config.virtual.provider,
              model: config.virtual.models.chat,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
              maxTokens: 16,
            })) {
              if (chunk.type === 'text-delta') text += chunk.text
              if (chunk.type === 'finish') finish = chunk.reason
            }
          } catch (error) {
            return { kind: 'error', text: `Time router probe failed: ${String(error?.message ?? error)}` }
          }
          const described = scheduler.describe()
          const reply = text.trim().length > 0 ? text.trim() : '(no text)'
          return {
            kind: finish?.kind === 'stop' ? 'success' : 'error',
            text: finish?.kind === 'stop'
              ? `Time router probe: routed to ${described.routeKey} (${described.reason}); model replied "${reply}".`
              : `Time router probe: routed to ${described.routeKey} but the call ended with ${JSON.stringify(finish)}.`,
          }
        }
        return { kind: 'success', text: renderStatus() }
      },
    }), 'time-router status command')
  })

  // 5. Panel API (optional: only in profiles with a web server).
  ctx.inject(['webServer', 'connection'], (child) => {
    child.effect(() => {
      const childApi = createApi({
        ctx: child,
        router,
        scheduler,
        calendar,
        status,
        config,
        dshHome,
        meta: { warnings, version: VERSION },
        clock: runtime,
        persistConfig: async (patch) => {
          const entry = ctx.fiber?.entry
          const editor = ctx.get('configEditor')
          if (entry === undefined || editor === undefined) throw new Error('this profile has no configuration editor; edit the bundle patch instead')
          await editor.edit(entry, (current) => ({ ...current, ...patch }))
        },
      })
      const disposers = childApi.register()
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // Best-effort route removal during unload.
          }
        }
      }
    }, 'time-router web panel routes')
  })

  ctx.logger.info(`time-router: virtual provider "${config.virtual.provider}" ready; peak → ${config.peak.label}, off-peak → ${config.offPeak.provider}`)
}
