/**
 * Client half of dsh-time-router: a composer-dock chip plus an inline panel.
 *
 * Plain-JavaScript Client module loaded by the Harness module table. React
 * comes from that table; nothing else is imported. The panel talks to the Host
 * through `/api/time-router/*` and never reads another plugin's DOM.
 */
window.__ModuleLoader__.load({
  id: 'dsh-time-router',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useReducer, useState } = React

    const NS = 'dsh-time-router'

    const DICTIONARIES = {
      en: {
        chipPeak: 'peak route',
        chipOffPeak: 'off-peak route',
        chipDisabled: 'disabled',
        until: 'switches',
        pinned: 'pinned',
        open: 'Open time-router panel',
        close: 'Close',
        status: 'Status',
        now: 'Now',
        route: 'Route',
        nextSwitch: 'Next switch',
        peakRoute: 'Peak route',
        offPeakRoute: 'Off-peak route',
        todayUsage: 'Today (input / output tokens)',
        events: 'Recent events',
        noEvents: 'No routed requests yet.',
        actions: 'Quick actions',
        auto: 'Auto',
        forcePeak: 'Force peak',
        forceOffPeak: 'Force off-peak',
        enable: 'Routing on',
        disable: 'Routing off',
        resetBreakers: 'Reset cooldowns',
        syncHolidays: 'Sync holidays',
        saveKey: 'Save key',
        keyPlaceholder: 'Paste the peak-route API key',
        keySaved: 'Key stored. The next request uses it.',
        warnings: 'Warnings',
        fallback: 'fallback',
        crossed: 'billed at peak price',
        failed: 'failed',
        saving: 'Saving…',
        error: 'Update failed',
      },
      zh: {
        chipPeak: '高峰路由',
        chipOffPeak: '非高峰路由',
        chipDisabled: '已停用',
        until: '切换于',
        pinned: '已固定',
        open: '打开时段路由面板',
        close: '关闭',
        status: '状态',
        now: '当前',
        route: '路由',
        nextSwitch: '下次切换',
        peakRoute: '高峰路线',
        offPeakRoute: '非高峰路线',
        todayUsage: '今日用量（输入 / 输出 token）',
        events: '最近事件',
        noEvents: '还没有路由记录。',
        actions: '快捷操作',
        auto: '自动',
        forcePeak: '强制高峰',
        forceOffPeak: '强制非高峰',
        enable: '启用路由',
        disable: '停用路由',
        resetBreakers: '重置熔断',
        syncHolidays: '同步节假日',
        saveKey: '保存密钥',
        keyPlaceholder: '粘贴高峰路线 API Key',
        keySaved: '密钥已保存，下一次请求生效。',
        warnings: '警告',
        fallback: '已回退',
        crossed: '按高峰价计费',
        failed: '失败',
        saving: '保存中…',
        error: '更新失败',
      },
    }

    const TOKENS = {
      text: 'var(--dsw-alias-text-primary, #1f2328)',
      secondary: 'var(--dsw-alias-text-secondary, #59636e)',
      border: 'var(--dsw-alias-border-default, rgba(31, 35, 40, 0.15))',
      surface: 'var(--dsw-alias-bg-elevated, #ffffff)',
      subtle: 'var(--dsw-alias-bg-subtle, rgba(31, 35, 40, 0.06))',
      accent: 'var(--dsw-alias-accent-default, #2f6fed)',
      danger: 'var(--dsw-alias-danger-default, #cf222e)',
      warn: 'var(--dsw-alias-warning-default, #bf8700)',
      ok: 'var(--dsw-alias-success-default, #1a7f37)',
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
      return String(value)
    }

    function useLocale(ctx) {
      const t = useMemo(() => {
        try {
          return ctx.locale.bind(NS)
        } catch {
          const active = ctx.locale?.getLocale?.().active === 'zh' ? 'zh' : 'en'
          return (key) => DICTIONARIES[active][key] ?? key
        }
      }, [ctx])
      const [, force] = useReducer((value) => value + 1, 0)
      useEffect(() => {
        try {
          return ctx.locale.subscribe(() => force())
        } catch {
          return undefined
        }
      }, [ctx])
      return t
    }

    function useStatus(intervalMs = 15_000) {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const refresh = useCallback(async () => {
        try {
          const response = await fetch('/api/time-router/status?events=8', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          setStatus(next)
          setError(null)
        } catch (caught) {
          setError(String(caught?.message ?? caught))
        }
      }, [])
      useEffect(() => {
        let disposed = false
        const tick = () => { if (!disposed) void refresh() }
        tick()
        const timer = setInterval(tick, intervalMs)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [refresh, intervalMs])
      return { status, error, refresh }
    }

    function post(body) {
      return fetch('/api/time-router/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload
      })
    }

    function Dot({ color }) {
      return h('span', {
        'aria-hidden': true,
        style: { width: 8, height: 8, borderRadius: 999, background: color, display: 'inline-block', flex: '0 0 auto' },
      })
    }

    function fieldRow(label, value) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, lineHeight: '18px' } },
        h('span', { style: { color: TOKENS.secondary, flex: '0 0 auto' } }, label),
        h('span', { style: { color: TOKENS.text, textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' } }, value))
    }

    function Chip({ ctx }) {
      const t = useLocale(ctx)
      const { status, error, refresh } = useStatus()
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(null)
      const [message, setMessage] = useState(null)
      const [keyDraft, setKeyDraft] = useState('')

      const iface = status?.now
      const routeKey = iface?.routeKey ?? 'offPeak'
      const enabled = status?.plugin?.enabled !== false
      const color = enabled ? (routeKey === 'peak' ? TOKENS.warn : TOKENS.ok) : TOKENS.secondary
      const routeLabel = !enabled ? t('chipDisabled') : routeKey === 'peak' ? t('chipPeak') : t('chipOffPeak')
      const switchLabel = iface?.nextSwitchZoned ? iface.nextSwitchZoned.slice(11, 16) : t('pinned')

      const run = async (label, body, nextMessage) => {
        setBusy(label)
        setMessage(null)
        try {
          await post(body)
          if (nextMessage) setMessage({ kind: 'ok', text: nextMessage })
        } catch (caught) {
          setMessage({ kind: 'error', text: `${t('error')}: ${String(caught?.message ?? caught)}` })
        } finally {
          setBusy(null)
          // A persisted config change restarts the plugin, so give it a moment
          // before the next poll reads the new composition.
          window.setTimeout(() => void refresh(), 500)
        }
      }

      const panel = open ? h('div', {
        style: {
          marginTop: 8,
          width: '100%',
          maxWidth: 460,
          border: `1px solid ${TOKENS.border}`,
          borderRadius: 10,
          background: TOKENS.surface,
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.12)',
          padding: '10px 12px',
          fontSize: 12,
          color: TOKENS.text,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        },
      }, [
        h('div', { key: 'header', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('strong', { style: { fontSize: 13 } }, t('status')),
          h('button', {
            key: 'close',
            type: 'button',
            onClick: () => setOpen(false),
            'aria-label': t('close'),
            style: { border: 'none', background: 'transparent', color: TOKENS.secondary, cursor: 'pointer', fontSize: 14 },
          }, '×')),
        status === null ? h('div', { key: 'empty', style: { color: TOKENS.secondary } }, '…') : h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
          fieldRow(t('now'), `${iface.zoned} · ${iface.weekdayName} · ${iface.dayKind}`),
          fieldRow(t('route'), `${iface.routeKey === 'peak' ? t('chipPeak') : t('chipOffPeak')} (${iface.reason})`),
          fieldRow(t('nextSwitch'), iface.nextSwitchZoned ?? t('pinned')),
          fieldRow(t('peakRoute'), `${status.routes.peak.mode === 'direct' ? status.routes.peak.label : status.routes.peak.provider} · ${status.routes.peak.models.chat}`),
          fieldRow(t('offPeakRoute'), `${status.routes.offPeak.mode === 'delegated' ? status.routes.offPeak.provider : status.routes.offPeak.label} · ${status.routes.offPeak.models.chat}`),
          status.routes.peak.breaker === null ? null : fieldRow(t('peakRoute'), `${status.routes.peak.breaker.kind}: ${status.routes.peak.breaker.reason}`),
          status.routes.offPeak.breaker === null ? null : fieldRow(t('offPeakRoute'), `${status.routes.offPeak.breaker.kind}: ${status.routes.offPeak.breaker.reason}`),
          status.usage?.today === null || status.usage?.today === undefined ? null : fieldRow(t('todayUsage'), `peak ${formatTokens(status.usage.today.peak.input)} / ${formatTokens(status.usage.today.peak.output)} · off-peak ${formatTokens(status.usage.today.offPeak.input)} / ${formatTokens(status.usage.today.offPeak.output)}`),
        ]),
        (status?.calendar?.warnings ?? []).length > 0 ? h('div', { key: 'warn', style: { color: TOKENS.warn, display: 'flex', flexDirection: 'column', gap: 2 } },
          ...(status.calendar.warnings).map((warning, index) => h('div', { key: `${warning.code}-${index}` }, `⚠ ${warning.message}`))) : null,
        h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 } }, [
          h('button', { key: 'auto', type: 'button', disabled: busy !== null, style: buttonStyle(iface.manual === 'auto'), onClick: () => void run('auto', { manualMode: 'auto' }, '') }, t('auto')),
          h('button', { key: 'peak', type: 'button', disabled: busy !== null, style: buttonStyle(iface.manual === 'peak'), onClick: () => void run('peak', { manualMode: 'peak', manualUntil: null }, '') }, t('forcePeak')),
          h('button', { key: 'off', type: 'button', disabled: busy !== null, style: buttonStyle(iface.manual === 'offPeak'), onClick: () => void run('off', { manualMode: 'offPeak', manualUntil: null }, '') }, t('forceOffPeak')),
          h('button', { key: 'toggle', type: 'button', disabled: busy !== null, style: buttonStyle(false), onClick: () => void run('toggle', { enabled: !enabled }, '') }, enabled ? t('disable') : t('enable')),
          h('button', { key: 'reset', type: 'button', disabled: busy !== null, style: buttonStyle(false), onClick: () => void run('reset', { resetBreakers: true }, '') }, t('resetBreakers')),
          h('button', { key: 'sync', type: 'button', disabled: busy !== null, style: buttonStyle(false), onClick: () => void run('sync', { syncHolidays: true }, '') }, t('syncHolidays')),
        ]),
        status?.routes?.peak?.mode === 'direct' ? h('div', { key: 'key', style: { display: 'flex', gap: 6, marginTop: 2 } }, [
          h('input', {
            key: 'input',
            type: 'password',
            value: keyDraft,
            placeholder: t('keyPlaceholder'),
            onChange: (event) => setKeyDraft(event.target.value),
            style: { flex: '1 1 auto', minWidth: 0, border: `1px solid ${TOKENS.border}`, borderRadius: 6, padding: '4px 6px', fontSize: 12, background: TOKENS.surface, color: TOKENS.text },
          }),
          h('button', {
            key: 'save',
            type: 'button',
            disabled: busy !== null || keyDraft.trim().length === 0,
            style: buttonStyle(false),
            onClick: () => void run('key', { apiKey: keyDraft, routeKey: 'peak' }, t('keySaved')).then(() => setKeyDraft('')),
          }, busy === 'key' ? t('saving') : t('saveKey')),
        ]) : null,
        message === null ? null : h('div', { key: 'message', style: { color: message.kind === 'error' ? TOKENS.danger : TOKENS.ok } }, message.text),
        h('div', { key: 'events', style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 } }, [
          h('div', { key: 'label', style: { color: TOKENS.secondary } }, t('events')),
          ...((status?.events ?? []).length === 0
            ? [h('div', { key: 'none', style: { color: TOKENS.secondary } }, t('noEvents'))]
            : (status.events).map((event, index) => h('div', {
              key: `${event.at}-${index}`,
              style: { display: 'flex', gap: 6, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' },
            }, [
              h('span', { key: 'time', style: { color: TOKENS.secondary } }, event.at?.slice(11, 19) ?? '--:--:--'),
              h('span', { key: 'route', style: { color: event.route === 'peak' ? TOKENS.warn : TOKENS.ok } }, event.route === 'peak' ? 'peak' : 'off-peak'),
              h('span', { key: 'model', style: { color: TOKENS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, event.model ?? ''),
              event.fallback ? h('span', { key: 'fallback', style: { color: TOKENS.warn } }, `↩ ${t('fallback')}`) : null,
              event.crossedIntoPeak ? h('span', { key: 'crossed', style: { color: TOKENS.warn } }, `↑ ${t('crossed')}`) : null,
              event.outcome === 'error' ? h('span', { key: 'error', style: { color: TOKENS.danger } }, t('failed')) : null,
            ]))),
        ]),
        error === null ? null : h('div', { key: 'offline', style: { color: TOKENS.danger } }, `${t('error')}: ${error}`),
      ]) : null

      return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%' } }, [
        h('button', {
          key: 'chip',
          type: 'button',
          'aria-expanded': open,
          'aria-label': t('open'),
          title: error === null ? `dsh-time-router ${routeLabel}` : `${t('error')}: ${error}`,
          onClick: () => setOpen((value) => !value),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderRadius: 999,
            border: `1px solid ${TOKENS.border}`,
            background: TOKENS.subtle,
            color: TOKENS.secondary,
            fontSize: 11,
            lineHeight: '16px',
            cursor: 'pointer',
          },
        }, [
          h(Dot, { key: 'dot', color }),
          h('span', { key: 'label', style: { color: TOKENS.text } }, '⏱ dsh-time-router'),
          h('span', { key: 'route', style: { color } }, routeLabel),
          h('span', { key: 'switch', style: { color: TOKENS.secondary } }, `· ${switchLabel}`),
        ]),
        panel,
      ])
    }

    function buttonStyle(active) {
      return {
        padding: '3px 8px',
        borderRadius: 6,
        border: `1px solid ${active ? TOKENS.accent : TOKENS.border}`,
        background: active ? TOKENS.accent : TOKENS.surface,
        color: active ? '#ffffff' : TOKENS.text,
        fontSize: 11,
        lineHeight: '16px',
        cursor: 'pointer',
      }
    }

    /**
     * Keep a render-time defect inside this slot entry: the Harness blanks a
     * slot whose entry throws, so this boundary degrades to a one-line note
     * instead of taking the composer dock with it.
     */
    class SlotBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        // eslint-disable-next-line no-console
        console.warn('[dsh-time-router] panel render failed', error)
      }

      render() {
        if (this.state.failed) {
          return h('div', { style: { fontSize: 11, color: TOKENS.secondary, padding: '2px 8px' } }, 'dsh-time-router')
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
          try {
            ctx.locale.register(NS, locale, dictionary)
          } catch {
            // The locale service is optional; the component falls back to inline English/Chinese.
          }
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'time-router-status',
          order: 20,
        }, () => h(SlotBoundary, null, h(Chip, { ctx }))))
      },
    }
  },
})
