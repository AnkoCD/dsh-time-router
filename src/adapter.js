/**
 * The virtual adapter backing the `time-router` provider route.
 *
 * Registering an adapter is what makes the route real to the Harness: the
 * model picker, `prepareCall()` capability checks and session attribution all
 * see one stable provider/model pair (`time-router` / `auto-chat`|
 * `auto-reasoner`). Actual dispatch is short-circuited in the `llm/stream`
 * waterfall by the router, so this adapter's `stream()` is only a defensive
 * fallback for the case where interception was not installed.
 *
 * The plugin imports no Harness package here on purpose: the object below is
 * duck-typed against the published `LlmAdapter` contract instead of extending
 * it, which keeps a linked workspace install working without node_modules.
 *
 * @module dsh-time-router/adapter
 */

/**
 * @param {object} deps
 * @param {import('./router.js').Router} deps.router
 * @param {string} deps.provider virtual provider id
 * @param {{ chat: string, reasoner: string }} deps.models virtual model ids
 * @param {(message: string) => void} [deps.warn]
 */
export function createVirtualAdapter({ router, provider, models, warn }) {
  const modelIds = new Set([models.chat, models.reasoner])

  function describe(model) {
    return model === models.reasoner
      ? 'Time-routed reasoning model: peak hours use your peak route, off-peak your off-peak route.'
      : 'Time-routed chat model: peak hours use your peak route, off-peak your off-peak route.'
  }

  return {
    providerInfo(id) {
      return { id, name: 'Time router' }
    },

    /** Let the agent-level retry executor own recovery; routing already fell back. */
    providerRetryPolicy() {
      return undefined
    },

    imageRequestPricing() {
      return undefined
    },

    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    async listModels() {
      return [
        {
          provider,
          id: models.chat,
          name: 'Auto · chat (time-routed)',
          description: describe(models.chat),
          badge: { text: 'time-routed', tone: 'info' },
        },
        {
          provider,
          id: models.reasoner,
          name: 'Auto · reasoner (time-routed)',
          description: describe(models.reasoner),
          badge: { text: 'time-routed', tone: 'info' },
        },
      ]
    },

    async resolveModel(id, model, signal) {
      if (!modelIds.has(model)) {
        const error = new Error(`dsh-time-router: unknown model "${model}" for provider "${id}"; use ${[...modelIds].join(' or ')}`)
        error.code = 'UNKNOWN_MODEL'
        throw error
      }
      const capabilities = await router.virtualCapabilities(model, signal)
      return {
        provider: id,
        id: model,
        name: model === models.reasoner ? 'Auto · reasoner (time-routed)' : 'Auto · chat (time-routed)',
        description: describe(model),
        ...capabilities,
      }
    },

    async prepareCall(id, model, signal) {
      const info = await this.resolveModel(id, model, signal)
      return { model: info, stream: (options) => router.route(options) }
    },

    /**
     * Defensive path only: the waterfall listener normally never reaches
     * adapter dispatch for this provider. Delegating here still routes, so a
     * listener registration failure degrades to working-but-late routing.
     */
    stream(options) {
      warn?.('dsh-time-router: adapter dispatch was reached without the llm/stream interception; routing defensively')
      return router.route(options)
    },
  }
}
