import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { classifyHTTP, createDirectClient, mapFinishReason, toChatMessages, toUsage } from '../src/openai.js'

function streamResponse(events) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        const line = typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(line))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function directClient(overrides = {}) {
  const { config } = resolveConfig({
    peak: {
      label: 'Mock Go',
      baseURL: 'https://mock.example/v1',
      apiKey: 'test-key',
      apiKeyEnv: null,
      models: { chat: 'mock-chat', reasoner: 'mock-reasoner' },
      contextWindow: 100_000,
      maxTokens: 4096,
      reasoningEfforts: ['low', 'high'],
      ...overrides,
    },
    offPeak: { provider: 'off-route' },
  })
  return createDirectClient({ routeKey: 'peak', route: config.peak, dshHome: mkdtempSync(join(tmpdir(), 'dsh-time-router-keys-')) })
}

function withFetch(t, impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  t.after(() => {
    globalThis.fetch = original
  })
}

test('direct streaming maps reasoning, text, usage and finish', async (t) => {
  let seenRequest
  withFetch(t, async (url, init) => {
    seenRequest = { url, init }
    return streamResponse([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } },
      '[DONE]',
    ])
  })
  const client = directClient()
  const chunks = await collect(client.stream({
    provider: 'time-router',
    model: 'auto-flash',
    sessionId: 'session-1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 100,
    reasoningEffort: 'high',
  }, 'chat', { fileText: () => '[file]' }))
  assert.equal(seenRequest.url, 'https://mock.example/v1/chat/completions')
  assert.equal(seenRequest.init.headers.authorization, 'Bearer test-key')
  assert.equal(seenRequest.init.headers['x-opencode-session'], 'session-1')
  const body = JSON.parse(seenRequest.init.body)
  assert.equal(body.model, 'mock-chat')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.max_tokens, 100)
  assert.equal(body.reasoning_effort, 'high')
  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta')
  const text = chunks.filter((chunk) => chunk.type === 'text-delta')
  assert.equal(reasoning.map((chunk) => chunk.text).join(''), 'think')
  assert.equal(text.map((chunk) => chunk.text).join(''), 'hello world')
  assert.notEqual(reasoning[0].index, text[0].index)
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16, cacheReadTokens: 3, reasoningTokens: 2 })
  const finish = chunks.at(-1)
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('tool-call deltas keep one block per tool index and finish as tool-calls', async (t) => {
  withFetch(t, async () => streamResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_time', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Beijing"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]))
  const client = directClient()
  const chunks = await collect(client.stream({ provider: 'time-router', model: 'auto-pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'time?' }] }] }, 'reasoner'))
  const calls = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].name, 'get_time')
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls.map((chunk) => chunk.argumentsDelta).join(''), '{"city":"Beijing"}')
  assert.equal(new Set(calls.map((chunk) => chunk.index)).size, 1)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('HTTP 401 becomes an AUTH terminal chunk', async (t) => {
  withFetch(t, async () => new Response('bad key', { status: 401 }))
  const client = directClient()
  const chunks = await collect(client.stream({ provider: 'time-router', model: 'auto-flash', messages: [] }, 'chat'))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'AUTH')
  assert.equal(chunks[0].reason.failure.status, 401)
})

test('a missing key fails with MISSING_CREDENTIAL before any network call', async (t) => {
  withFetch(t, async () => {
    throw new Error('should not be called')
  })
  const client = directClient({ apiKey: null, apiKeyEnv: 'DSH_TIME_ROUTER_UNSET_KEY' })
  delete process.env.DSH_TIME_ROUTER_UNSET_KEY
  const chunks = await collect(client.stream({ provider: 'time-router', model: 'auto-flash', messages: [] }, 'chat'))
  assert.equal(chunks[0].reason.failure.code, 'MISSING_CREDENTIAL')
  assert.equal(client.hasKey(), false)
})

test('a key file under the plugin data directory is picked up', (t) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-time-router-keys-'))
  t.after(() => rmSync(dshHome, { recursive: true, force: true }))
  const keyDir = join(dshHome, 'plugins', 'time-router', 'keys')
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(join(keyDir, 'peak.key'), 'file-key\n')
  const { config } = resolveConfig({ peak: { baseURL: 'https://mock.example/v1', apiKeyEnv: null, apiKeyFile: null, models: { chat: 'a', reasoner: 'b' } } })
  const client = createDirectClient({ routeKey: 'peak', route: config.peak, dshHome })
  const resolved = client.resolveApiKey()
  assert.equal(resolved.value, 'file-key')
  assert.equal(resolved.source, 'auto-key-file')
})

test('SSE provider error events terminate the stream', async (t) => {
  withFetch(t, async () => streamResponse([{ error: { message: 'quota gone', type: 'insufficient_quota' } }]))
  const client = directClient()
  const chunks = await collect(client.stream({ provider: 'time-router', model: 'auto-flash', messages: [] }, 'chat'))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'PROVIDER_ERROR')
})

test('toChatMessages folds system text and converts tools and tool results', () => {
  const messages = toChatMessages({
    system: 'sys prompt',
    messages: [
      { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'later system' }] },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'img_1' } }, { type: 'file', attachment: { attachmentId: 'file_1', name: 'a.txt', bytes: 5 } }] },
      { role: 'assistant', source: { kind: 'model', provider: 'time-router', model: 'auto-flash' }, content: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      ] },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] },
    ],
  }, () => '[file-handle]')
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, 'sys prompt\n\nlater system')
  const user = messages[1]
  assert.ok(user.content.includes('look'))
  assert.ok(user.content.includes('image omitted'))
  assert.ok(user.content.includes('[file-handle]'))
  const assistant = messages[2]
  assert.equal(assistant.content, 'calling')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  assert.equal(assistant.tool_calls[0].function.name, 'read')
  assert.equal(messages[3].role, 'tool')
  assert.equal(messages[3].tool_call_id, 'call_1')
})

test('finish reasons, usage and HTTP classification mappings', () => {
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(toUsage({ prompt_tokens: 1, completion_tokens: 2 }), { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  assert.deepEqual(classifyHTTP(401, ''), { code: 'AUTH' })
  assert.deepEqual(classifyHTTP(429, '').code, 'RATE_LIMIT')
  assert.deepEqual(classifyHTTP(429, 'insufficient quota').code, 'QUOTA')
  assert.deepEqual(classifyHTTP(400, 'maximum context length exceeded').code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.deepEqual(classifyHTTP(503, '').code, 'SERVER')
})
