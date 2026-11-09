/**
 * Direct OpenAI-compatible route client.
 *
 * A "direct" route is one the plugin owns: a base URL, a key reference and a
 * model mapping, spoken over the standard Chat Completions streaming protocol.
 * The verified target for this project is **OpenCode Go**
 * (`https://opencode.ai/inference/go/openai/v1`), which serves the same
 * DeepSeek V4.1 Flash / V4 Pro family as the official route under Go
 * subscription pricing, and whose surcharge window is exactly 09:00–12:00 and
 * 14:00–18:00 Asia/Shanghai on weekdays.
 *
 * Built from `node:` primitives and `fetch` only: no Harness import, no extra
 * dependency. The virtual model advertises text only, so image and file blocks
 * are projected to deterministic placeholders, matching the Harness's own
 * text-only projection.
 *
 * @module dsh-time-router/openai
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const KEY_CACHE_MS = 30_000

function effortName(id) {
  switch (id) {
    case 'off': return 'Off'
    case 'low': return 'Low'
    case 'high': return 'High'
    case 'max': return 'Max'
    default: return id
  }
}

function expandPath(value, dshHome) {
  let path = value
  if (path.startsWith('~')) path = join(dshHome, path.slice(1).replace(/^[/\\]/, ''))
  return path.replaceAll('{dshHome}', dshHome)
}

/** Join the configured base URL and a path without doubling slashes. */
function joinURL(baseURL, path) {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

function imagePlaceholder(attachment) {
  const id = typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : 'unknown'
  return `[image omitted because the direct route accepts text only; attachment ${id}]`
}

/**
 * Convert the Harness request vocabulary into Chat Completions messages.
 * `fileText` lets the router hand over the Harness's own deterministic file
 * handle text (`ctx.llm.fileRequestText`).
 */
export function toChatMessages(options, fileText) {
  const systemParts = []
  if (typeof options.system === 'string' && options.system.trim().length > 0) systemParts.push(options.system)
  const messages = []
  for (const message of options.messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(message.content)
        if (text.trim().length > 0) systemParts.push(text)
        continue
      }
      case 'user':
        messages.push({ role: 'user', content: bodyText(message.content, fileText) })
        continue
      case 'assistant': {
        const content = textOf(message.content)
        const toolCalls = []
        for (const block of message.content ?? []) {
          if (block?.type === 'tool-call' && typeof block.id === 'string' && block.id.length > 0) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
            })
          }
        }
        messages.push({
          role: 'assistant',
          content: content.length > 0 ? content : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
        continue
      }
      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
          content: bodyText(message.content, fileText),
        })
        continue
      default:
        continue
    }
  }
  // Later system messages fold into the leading system prompt: the direct
  // protocol has no mid-conversation system update, and the virtual model does
  // not advertise `systemPromptUpdate`.
  if (systemParts.length > 0) messages.unshift({ role: 'system', content: [...new Set(systemParts)].join('\n\n') })
  return messages
}

function bodyText(blocks, fileText) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(imagePlaceholder(block.attachment))
        break
      case 'file':
        parts.push(typeof fileText === 'function' && block.attachment !== undefined
          ? fileText(block.attachment)
          : `[file ${block.attachment?.name ?? 'attachment'} was uploaded but this route cannot read it]`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/** Convert Harness tool schemas into Chat Completions function declarations. */
export function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const converted = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name.length === 0) continue
    converted.push({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    })
  }
  return converted.length > 0 ? converted : undefined
}

export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

export function toUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens)
  const cacheRead = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0)
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0)
  const safe = (value) => (Number.isFinite(value) ? value : 0)
  return {
    inputTokens: safe(inputTokens),
    outputTokens: safe(outputTokens),
    totalTokens: safe(totalTokens),
    ...(safe(cacheRead) > 0 ? { cacheReadTokens: safe(cacheRead) } : {}),
    ...(safe(reasoning) > 0 ? { reasoningTokens: safe(reasoning) } : {}),
  }
}

export function classifyHTTP(status, detail, headers) {
  const lower = String(detail).toLowerCase()
  const retryAfterHeader = headers?.get?.('retry-after') ?? null
  let retryAfterMs
  if (typeof retryAfterHeader === 'string' && retryAfterHeader.length > 0) {
    const seconds = Number(retryAfterHeader)
    if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000
    else {
      const date = Date.parse(retryAfterHeader)
      if (!Number.isNaN(date)) retryAfterMs = Math.max(0, date - Date.now())
    }
  }
  if (status === 401 || status === 403) return { code: 'AUTH' }
  if (status === 402) return { code: 'QUOTA' }
  if (status === 429) {
    if (/quota|balance|credit|usage limit|allowance/.test(lower)) return { code: 'QUOTA', retryAfterMs }
    return { code: 'RATE_LIMIT', retryAfterMs }
  }
  if (status === 400 || status === 413 || status === 422) {
    if (/context[ _-]?(length|window)|too (long|large)|maximum context|request too large/.test(lower)) {
      return { code: 'CONTEXT_WINDOW_EXCEEDED' }
    }
    return { code: 'INVALID_REQUEST' }
  }
  if (status >= 500) return { code: 'SERVER' }
  return { code: 'PROVIDER_ERROR' }
}

function failureChunk(message, code, status) {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message: String(message).slice(0, 1200), code, ...(status === undefined ? {} : { status }) } },
  }
}

/**
 * @param {object} options
 * @param {string} options.routeKey
 * @param {any} options.route resolved direct route config
 * @param {string} options.dshHome
 */
export function createDirectClient(options) {
  const { routeKey, route, dshHome } = options
  const autoKeyFile = join(dshHome, 'plugins', 'time-router', 'keys', `${routeKey}.key`)
  let keyCache = { value: null, readAt: 0, source: null }

  function readKeyFile(path) {
    try {
      if (!existsSync(path)) return null
      const value = readFileSync(path, 'utf8').trim()
      return value.length > 0 ? value : null
    } catch {
      return null
    }
  }

  /** Resolve the route's API key. The value is never logged or returned in status. */
  function resolveApiKey() {
    if (route.apiKey !== null && route.apiKey !== undefined) return { value: route.apiKey, source: 'config' }
    if (route.apiKeyEnv !== null && route.apiKeyEnv !== undefined) {
      const fromEnv = process.env[route.apiKeyEnv]
      if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return { value: fromEnv.trim(), source: `env:${route.apiKeyEnv}` }
    }
    if (Date.now() - keyCache.readAt < KEY_CACHE_MS) {
      return keyCache.value === null ? null : { value: keyCache.value, source: keyCache.source }
    }
    const configured = route.apiKeyFile === null || route.apiKeyFile === undefined ? null : expandPath(route.apiKeyFile, dshHome)
    const fromConfigured = configured === null ? null : readKeyFile(configured)
    const fromAuto = readKeyFile(autoKeyFile)
    const value = fromConfigured ?? fromAuto
    keyCache = {
      value,
      readAt: Date.now(),
      source: fromConfigured !== null ? 'file' : fromAuto !== null ? 'auto-key-file' : null,
    }
    return value === null ? null : { value, source: keyCache.source }
  }

  function invalidateKey() {
    keyCache = { value: null, readAt: 0, source: null }
  }

  function modelFor(tier) {
    return route.models[tier]
  }

  function hasKey() {
    return resolveApiKey() !== null
  }

  /** Metadata advertised to the Harness for this route. */
  function capabilities() {
    const efforts = Array.isArray(route.reasoningEfforts) && route.reasoningEfforts.length > 0
      ? route.reasoningEfforts.map((id) => ({ id, name: effortName(id) }))
      : null
    const preferred = efforts?.find((effort) => effort.id === 'high') ?? efforts?.[0]
    return {
      context: { contextWindow: route.contextWindow },
      defaultMaxTokens: route.maxTokens,
      inputModalities: ['text'],
      ...(efforts === null ? {} : { reasoning: { efforts, ...(preferred === undefined ? {} : { defaultEffort: preferred.id }) } }),
    }
  }

  function buildBody(opts, tier, fileText) {
    const body = {
      model: modelFor(tier),
      messages: toChatMessages(opts, fileText),
      stream: true,
      stream_options: { include_usage: true },
    }
    const tools = convertTools(opts.tools)
    if (tools !== undefined) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    const requested = Number.isInteger(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : route.maxTokens
    body.max_tokens = Math.min(requested, route.maxTokens)
    if (typeof opts.temperature === 'number') body.temperature = opts.temperature
    if (Array.isArray(opts.stop) && opts.stop.length > 0) body.stop = opts.stop
    const effort = opts.reasoningEffort === undefined ? undefined : String(opts.reasoningEffort)
    if (effort !== undefined && Array.isArray(route.reasoningEfforts) && route.reasoningEfforts.includes(effort)) {
      body.reasoning_effort = effort
    }
    return body
  }

  function buildHeaders(apiKey, sessionId) {
    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'dsh-time-router/0.1',
      ...(typeof sessionId === 'string' && sessionId.length > 0 ? { 'x-opencode-session': sessionId } : {}),
    }
    if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`
    for (const [name, value] of Object.entries(route.headers ?? {})) {
      const lower = name.toLowerCase()
      if (lower === 'authorization' && apiKey !== null) continue
      headers[lower] = value
    }
    return headers
  }

  /**
   * Stream one direct-route attempt as Harness `StreamChunk`s.
   * Never throws: every failure becomes a terminal `finish` chunk so the
   * router sees one uniform protocol.
   *
   * @param {any} opts Harness GenerateOptions
   * @param {'chat'|'reasoner'} tier
   * @param {{ fileText?: (ref: any) => string }} [helpers]
   */
  async function* stream(opts, tier, helpers = {}) {
    const signal = opts.signal
    const key = resolveApiKey()
    if (key === null) {
      const hint = route.apiKeyEnv === null || route.apiKeyEnv === undefined
        ? `write the key to ${autoKeyFile} or set ${routeKey}.apiKeyFile`
        : `set ${route.apiKeyEnv} in the environment or write the key to ${autoKeyFile}`
      yield failureChunk(`${route.label} has no API key; ${hint}`, 'MISSING_CREDENTIAL')
      return
    }
    let body
    try {
      body = buildBody(opts, tier, helpers.fileText)
    } catch (error) {
      yield failureChunk(`dsh-time-router: cannot build ${route.label} request: ${error?.message ?? error}`, 'INVALID_REQUEST')
      return
    }
    const signals = []
    if (signal !== undefined) signals.push(signal)
    try {
      if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(route.requestTimeoutMs))
    } catch {
      // Older runtimes without AbortSignal.timeout still work without a route deadline.
    }
    const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    let response
    try {
      response = await fetch(joinURL(route.baseURL, 'chat/completions'), {
        method: 'POST',
        headers: buildHeaders(key.value, opts.sessionId),
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      yield failureChunk(`${route.label} request failed: ${error?.message ?? error}`, signal?.aborted === true ? 'ABORTED' : 'TRANSPORT')
      return
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 600)
      } catch {
        // The body may be unreadable after a transport failure.
      }
      const classified = classifyHTTP(response.status, detail, response.headers)
      yield failureChunk(
        `${route.label} returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`,
        classified.code,
        response.status,
      )
      return
    }
    if (response.body === null) {
      yield failureChunk(`${route.label} returned an empty response body`, 'EMPTY_RESPONSE', response.status)
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let nextIndex = 0
    const state = { reasoningIndex: null, textIndex: null, toolBlocks: new Map(), finished: false, sawOutput: false }
    let usage = null
    let pendingFinish = null
    const consume = function* consume(chunks) {
      for (const chunk of chunks) {
        if (chunk.type === 'usage') {
          usage = chunk.usage
          continue
        }
        if (chunk.type === 'finish') {
          pendingFinish = chunk.reason
          continue
        }
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') state.sawOutput = true
        yield chunk
      }
    }
    try {
      reading: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const boundary = findBoundary(buffer)
          if (boundary === null) break
          const rawEvent = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary.length)
          yield* consume(parseEvent(rawEvent, route, state, () => nextIndex++))
          if (pendingFinish !== null && (pendingFinish.kind === 'error' || pendingFinish.kind === 'aborted')) break reading
        }
      }
      // Flush a trailing event that ended without a blank line.
      if (buffer.trim().length > 0) yield* consume(parseEvent(buffer, route, state, () => nextIndex++))
    } catch (error) {
      yield failureChunk(`${route.label} stream interrupted: ${error?.message ?? error}`, signal?.aborted === true ? 'ABORTED' : 'TRANSPORT')
      return
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Already released by a failed read.
      }
    }
    // Protocol ordering: usage precedes exactly one terminal finish chunk.
    if (usage !== null) yield { type: 'usage', usage }
    if (pendingFinish !== null) {
      yield { type: 'finish', reason: pendingFinish }
      return
    }
    if (!state.sawOutput) {
      yield failureChunk(`${route.label} completed without any content`, 'EMPTY_RESPONSE')
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  return {
    routeKey,
    route,
    label: route.label,
    modelFor,
    capabilities,
    stream,
    resolveApiKey,
    hasKey,
    invalidateKey,
    autoKeyFile,
  }
}

/** Two newlines (or CRLF pairs) separate SSE events. */
function findBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return null
  if (lf !== -1 && (crlf === -1 || lf < crlf)) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

/** Parse one SSE event block into Harness chunks. */
function parseEvent(raw, route, state, allocIndex) {
  const chunks = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data.length === 0) continue
    if (data === '[DONE]') {
      if (!state.finished) {
        state.finished = true
        chunks.push({ type: 'finish', reason: { kind: 'stop' } })
      }
      return chunks
    }
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (payload?.error !== undefined) {
      const message = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? 'provider error'
      if (!state.finished) {
        state.finished = true
        chunks.push({
          type: 'finish',
          reason: { kind: 'error', failure: { message: `${route.label}: ${String(message).slice(0, 800)}`, code: 'PROVIDER_ERROR' } },
        })
      }
      return chunks
    }
    if (payload?.usage !== undefined) {
      const usage = toUsage(payload.usage)
      if (usage !== null) chunks.push({ type: 'usage', usage })
    }
    const choice = payload?.choices?.[0]
    if (choice === undefined || choice === null) continue
    const delta = choice.delta ?? {}
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (state.reasoningIndex === null) state.reasoningIndex = allocIndex()
      chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: delta.reasoning_content })
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (state.textIndex === null) state.textIndex = allocIndex()
      chunks.push({ type: 'text-delta', index: state.textIndex, text: delta.content })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (call === null || typeof call !== 'object') continue
        const openaiIndex = Number.isInteger(call.index) ? call.index : 0
        let block = state.toolBlocks.get(openaiIndex)
        if (block === undefined) {
          block = { index: allocIndex(), id: '' }
          state.toolBlocks.set(openaiIndex, block)
        }
        if (typeof call.id === 'string' && call.id.length > 0) block.id = call.id
        const name = typeof call.function?.name === 'string' && call.function.name.length > 0 ? call.function.name : undefined
        const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        if (name === undefined && argumentsDelta.length === 0) continue
        if (block.id.length === 0) block.id = `call-${openaiIndex}`
        chunks.push({
          type: 'tool-call-delta',
          index: block.index,
          id: block.id,
          ...(name === undefined ? {} : { name }),
          argumentsDelta,
        })
      }
    }
    if (!state.finished && choice.finish_reason !== null && choice.finish_reason !== undefined) {
      state.finished = true
      chunks.push({ type: 'finish', reason: mapFinishReason(choice.finish_reason) })
    }
  }
  return chunks
}
