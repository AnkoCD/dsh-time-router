/**
 * Small HTTP surface for the Web panel and for headless inspection.
 *
 * Two routes are registered on the Harness web server:
 *   GET  /api/time-router/status  → one JSON snapshot
 *   POST /api/time-router/state   → quick actions (toggle, manual override,
 *                                   breaker reset, holiday sync, key storage)
 *
 * `connection.requestRejection()` applies the Harness's own Host/Origin and
 * browser authentication checks before either handler runs, so the routes
 * behave like the rest of the application's authenticated API surface.
 *
 * Only non-secret facts are returned: key health is reported as a source tag,
 * never as the key itself.
 *
 * @module dsh-time-router/api
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BODY_BYTES = 16 * 1024

function sendJSON(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function parseBoolean(value) {
  return value === true || value === 'true'
}

/** Health snapshot for one route, without secrets. */
function describeRoute(router, routeKey, config) {
  const route = config[routeKey]
  const client = router.clients.get(routeKey)
  const target = router.targetFor(routeKey, 'chat')
  const activeBreaker = router.breakers.check(target.provider, target.model)
  let key = null
  if (route.mode === 'direct' && client !== undefined) {
    const resolved = client.resolveApiKey()
    key = resolved === null ? { present: false, source: null, hint: client.autoKeyFile } : { present: true, source: resolved.source, hint: client.autoKeyFile }
  }
  return {
    routeKey,
    mode: route.mode,
    label: route.label,
    ...(route.mode === 'delegated' ? { provider: route.provider } : { baseURL: route.baseURL, key }),
    models: route.models,
    breaker: activeBreaker === undefined ? null : {
      kind: activeBreaker.kind,
      reason: activeBreaker.reason,
      until: activeBreaker.until === null ? null : new Date(activeBreaker.until).toISOString(),
    },
  }
}

/**
 * @param {object} options
 * @param {any} options.ctx plugin context
 * @param {import('./router.js').Router} options.router
 * @param {import('./schedule.js').Scheduler} options.scheduler
 * @param {ReturnType<import('./holidays.js').createHolidayCalendar>} options.calendar
 * @param {import('./status.js').StatusStore} options.status
 * @param {any} options.config
 * @param {string} options.dshHome
 * @param {{ warnings: { key: string, message: string }[], version: string }} options.meta
 * @param {(patch: Record<string, unknown>) => Promise<void>} options.persistConfig
 */
export function createApi(options) {
  const { ctx, router, scheduler, calendar, status, config, dshHome, meta, persistConfig } = options
  const clock = options.clock ?? { serverSkewMs: null }

  function todayKey() {
    return scheduler.evaluate(scheduler.now()).dateKey
  }

  function snapshot(eventLimit = 25) {
    const described = scheduler.describe()
    const nowParts = { dateKey: described.dateKey }
    const usage = status.usage(nowParts.dateKey)
    const recentEvents = status.recent(Math.min(Math.max(eventLimit, 1), config.status.maxEvents))
    return {
      plugin: {
        name: 'dsh-time-router',
        version: meta.version,
        enabled: config.enabled,
        timezone: config.timezone,
        virtual: { provider: config.virtual.provider, models: config.virtual.models },
        peakWindows: config.windows.map((window) => window.raw),
      },
      now: described,
      calendar: { ...calendar.status(), warnings: calendar.warnings() },
      routes: {
        peak: describeRoute(router, 'peak', config),
        offPeak: describeRoute(router, 'offPeak', config),
      },
      breakers: router.breakers.snapshot().map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        kind: entry.kind,
        since: new Date(entry.since).toISOString(),
        until: entry.until === null ? null : new Date(entry.until).toISOString(),
        reason: entry.reason,
      })),
      notices: router.recentNotices(10),
      events: recentEvents,
      usage,
      configWarnings: meta.warnings,
      clockSkewMs: clock.serverSkewMs,
      fakeNow: config.debug.fakeNowMs !== null,
      cacheFiles: {
        events: status.eventsFile,
        holidays: calendar.status().cacheFile,
        keyDir: join(dshHome, 'plugins', 'time-router', 'keys'),
      },
    }
  }

  function isAllowed(req) {
    const connection = ctx.get('connection')
    if (connection === undefined) return null
    try {
      return connection.requestRejection({ headers: req.headers })
    } catch {
      return 401
    }
  }

  async function handleState(req, res) {
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch (error) {
      sendJSON(res, 400, { ok: false, error: `invalid request body: ${error?.message ?? error}` })
      return
    }
    try {
      if (typeof body.enabled === 'boolean' || typeof body.manualMode === 'string' || body.manualUntil !== undefined) {
        const patch = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.manualMode === 'string' || body.manualUntil !== undefined) {
          const mode = typeof body.manualMode === 'string' ? body.manualMode : config.manual.mode
          if (!['auto', 'peak', 'offPeak'].includes(mode)) throw new Error('manualMode must be auto, peak or offPeak')
          const until = body.manualUntil === undefined ? config.manual.until : body.manualUntil
          if (until !== null && until !== undefined && (typeof until !== 'string' || Number.isNaN(Date.parse(until)))) {
            throw new Error('manualUntil must be null or an ISO timestamp')
          }
          patch.manual = { mode, until: until ?? null }
        }
        await persistConfig(patch)
        sendJSON(res, 200, { ok: true, restarting: true, snapshot: snapshot() })
        return
      }
      if (parseBoolean(body.resetBreakers)) {
        const count = body.provider === undefined ? router.breakers.reset() : router.breakers.reset(String(body.provider))
        router.notice('info', `Circuit breakers reset (${count} entr${count === 1 ? 'y' : 'ies'}).`)
      }
      if (parseBoolean(body.syncHolidays)) {
        const result = await calendar.sync()
        router.notice(result.ok ? 'info' : 'warn', result.ok ? 'Holiday calendar synced.' : `Holiday sync finished with errors: ${result.errors.join('; ')}`)
      }
      if (typeof body.apiKey === 'string' && body.apiKey.trim().length > 0) {
        const routeKey = body.routeKey === 'offPeak' ? 'offPeak' : 'peak'
        const route = config[routeKey]
        if (route.mode !== 'direct') throw new Error(`${routeKey} is a delegated route; it has no key to store`)
        const keyDir = join(dshHome, 'plugins', 'time-router', 'keys')
        const keyPath = join(keyDir, `${routeKey}.key`)
        mkdirSync(keyDir, { recursive: true })
        writeFileSync(keyPath, `${body.apiKey.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
        try {
          chmodSync(keyPath, 0o600)
        } catch {
          // Windows ACLs do not map to POSIX modes; the file stays under the user profile.
        }
        router.clients.get(routeKey)?.invalidateKey()
        router.notice('info', `Stored a key for the ${routeKey} route.`)
      }
      sendJSON(res, 200, { ok: true, snapshot: snapshot() })
    } catch (error) {
      sendJSON(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }

  function registerRoute(method, path, handler) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return null
    return webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const rejection = isAllowed(req)
        if (rejection !== undefined) {
          sendJSON(res, rejection, { ok: false, error: 'not authorized' })
          return
        }
        if (req.method !== method) {
          res.writeHead(405, { allow: method })
          res.end()
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          sendJSON(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
  }

  return {
    clock,
    snapshot,
    register() {
      const disposers = [
        registerRoute('GET', '/api/time-router/status', async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const limit = Number(url.searchParams.get('events') ?? 25)
          sendJSON(res, 200, snapshot(Number.isFinite(limit) ? limit : 25))
        }),
        registerRoute('POST', '/api/time-router/state', handleState),
      ].filter((disposer) => disposer !== null)
      return disposers
    },
  }
}
