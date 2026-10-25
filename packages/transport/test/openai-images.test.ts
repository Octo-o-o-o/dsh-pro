import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TransportError, type FetchedAnswer, type SubmitRequest } from '@dsh-pro/core'
import { OpenAIImageTransport } from '@dsh-pro/transport'

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

interface TestServer {
  baseUrl: string
  origin: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2_048, 7),
])

type Handler = (request: CapturedRequest, response: ServerResponse) => void | Promise<void>

async function startServer(handler: Handler, prefix = '/v1'): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const captured: CapturedRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks),
    }
    requests.push(captured)
    await handler(captured, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { baseUrl: `${origin}${prefix}`, origin, requests, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) } }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function imageBody(): { data: Array<{ b64_json: string }> } {
  return { data: [{ b64_json: PNG.toString('base64') }] }
}

async function waitAnswered(transport: OpenAIImageTransport, submissionId: string, timeoutMs = 5_000): Promise<FetchedAnswer> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const polled = await transport.poll({ submissionId, timeoutMs: 50 })
    if (polled.state === 'answered') return await transport.fetch({ submissionId })
    if (polled.state === 'unknown') throw new Error('submission vanished')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('round did not finish in time')
}

function request(overrides: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    topicId: 'topic-test',
    round: 1,
    brief: '做一个深色科技风落地页首屏，中文大标题，右侧产品界面。',
    files: [],
    model: 'gpt-image-1',
    ...overrides,
  }
}

function transportFor(baseUrl: string, overrides: Partial<ConstructorParameters<typeof OpenAIImageTransport>[0]> = {}): OpenAIImageTransport {
  return new OpenAIImageTransport({
    baseUrl,
    apiKey: 'test-key',
    model: 'gpt-image-1',
    timeoutMs: 5_000,
    ...overrides,
  })
}

describe('OpenAIImageTransport', () => {
  it.each(['disabled', 'oversize', 'corrupt', 'changed', 'missing', 'multiple', 'count'])('refuses a mandatory base edit with %s input before any API call', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-edit-base-'))
    cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
    const file = join(root, 'base.png')
    const bytes = scenario === 'oversize' ? Buffer.concat([PNG, Buffer.alloc(26 * 1024 * 1024)]) : scenario === 'corrupt' ? Buffer.from('not an image') : PNG
    if (scenario !== 'missing') await writeFile(file, bytes)
    let requests = 0
    const transport = transportFor('https://example.invalid/v1', {
      editMode: scenario === 'disabled' ? 'off' : 'auto',
      fetchImpl: async () => { requests++; throw new Error('must not send') },
    })
    await expect(transport.submit(request({
      files: scenario === 'multiple' ? [file, file] : [file],
      designs: scenario === 'count' ? 2 : 1,
      editBase: { sha256: scenario === 'changed' ? 'old-digest' : createHash('sha256').update(bytes).digest('hex') },
    }))).rejects.toThrow()
    expect(requests).toBe(0)
  })

  it('generates one image per direction with model, size and auth', async () => {
    const server = await startServer((_request, response) => json(response, 200, imageBody()))
    const transport = transportFor(server.baseUrl, { size: '1024x1024', quality: 'high' })

    const submitted = await transport.submit(request({ designs: 2 }))
    const answer = await waitAnswered(transport, submitted.submissionId)

    expect(answer.images).toHaveLength(2)
    expect(answer.images?.map(image => image.name)).toEqual(['image-01.png', 'image-02.png'])
    expect(answer.images?.[0]?.mime).toBe('image/png')
    expect(answer.answer).toContain('模型：gpt-image-1')
    expect(answer.answer).toContain('结果：2 张 / 请求 2 个方向')

    expect(server.requests).toHaveLength(2)
    const prompts = server.requests.map(entry => String(JSON.parse(entry.body.toString('utf8')).prompt))
    // Directions run concurrently now: assert on content, not arrival order.
    expect(prompts.some(prompt => prompt.includes('第 1 个方向（共 2 个）'))).toBe(true)
    expect(prompts.some(prompt => prompt.includes('第 2 个方向（共 2 个）'))).toBe(true)
    expect(prompts.every(prompt => prompt.includes('中文大标题'))).toBe(true)
    const first = JSON.parse(server.requests[0]!.body.toString('utf8')) as Record<string, unknown>
    expect(first).toMatchObject({ model: 'gpt-image-1', n: 1, size: '1024x1024', quality: 'high' })
    expect(server.requests[0]?.headers.authorization).toBe('Bearer test-key')
  })

  it('downloads url responses and keeps the key on the API origin', async () => {
    const cdn = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PNG)
    }, '')
    const api = await startServer((_request, response) => {
      json(response, 200, { data: [{ url: `${cdn.origin}/files/a.png` }] })
    })

    const transport = transportFor(api.baseUrl)
    const submitted = await transport.submit(request())
    const answer = await waitAnswered(transport, submitted.submissionId)

    expect(answer.images).toHaveLength(1)
    expect(answer.images?.[0]?.mime).toBe('image/png')
    expect(cdn.requests).toHaveLength(1)
    expect(cdn.requests[0]?.headers.authorization).toBeUndefined()
  })

  it('sends image materials to /images/edits as multipart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pro-ref-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const reference = join(dir, 'brand.png')
    await writeFile(reference, PNG)
    const server = await startServer((_request, response) => json(response, 200, imageBody()))

    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request({ files: [reference] }))
    const answer = await waitAnswered(transport, submitted.submissionId)

    expect(submitted.attachments).toEqual(['brand.png'])
    expect(answer.images).toHaveLength(1)
    expect(answer.answer).toContain('参考图：brand.png')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.url).toBe('/v1/images/edits')
    expect(String(server.requests[0]?.headers['content-type'])).toContain('multipart/form-data')
    const body = server.requests[0]!.body.toString('utf8')
    expect(body).toContain('name="model"')
    expect(body).toContain('name="prompt"')
    expect(body).toContain('name="image[]"; filename="brand.png"')
  })

  it('maps a rejected key to a login stall', async () => {
    const server = await startServer((_request, response) => json(response, 401, { error: { message: 'bad key' } }))
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request())

    const error = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 5_000 }).catch(caught => caught)
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).failure).toBe('login')
    expect((error as Error).message).toContain('401')
    expect((error as Error).message).not.toContain('test-key')
  })

  it('keeps successful directions when another one fails', async () => {
    const server = await startServer((request, response) => {
      const prompt = String(JSON.parse(request.body.toString('utf8')).prompt)
      if (prompt.includes('第 2 个方向')) json(response, 500, { error: 'boom' })
      else json(response, 200, imageBody())
    })
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request({ designs: 2 }))
    const answer = await waitAnswered(transport, submitted.submissionId)

    expect(answer.images).toHaveLength(1)
    expect(answer.answer).toContain('## 失败')
    expect(answer.answer).toContain('第 2 个方向失败')
    expect(answer.answer).toContain('结果：1 张 / 请求 2 个方向')
  })

  it('aborts an in-flight round on cancel', async () => {
    const server = await startServer(async (_request, response) => {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      json(response, 200, imageBody())
    })
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request())
    await transport.cancel()

    const error = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 5_000 }).catch(caught => caught)
    expect((error as Error).name).toBe('AbortError')
  })

  it('times out a hung provider with a timeout stall', async () => {
    const server = await startServer(() => undefined)
    const transport = transportFor(server.baseUrl, { timeoutMs: 80 })
    const submitted = await transport.submit(request())

    const error = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 5_000 }).catch(caught => caught)
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).failure).toBe('timeout')
  })

  it('reports missing images instead of an empty round', async () => {
    const server = await startServer((_request, response) => json(response, 200, { data: [] }))
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request())

    const error = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 5_000 }).catch(caught => caught)
    expect(error).toBeInstanceOf(TransportError)
    expect((error as TransportError).failure).toBe('config')
  })

  it('refuses to submit without a key', async () => {
    const server = await startServer((_request, response) => json(response, 200, imageBody()))
    const transport = transportFor(server.baseUrl, { apiKey: '' })

    await expect(transport.submit(request())).rejects.toMatchObject({ failure: 'config' })
    expect(server.requests).toHaveLength(0)
  })

  it('refuses plaintext http for a remote image endpoint', async () => {
    const transport = new OpenAIImageTransport({
      baseUrl: 'http://example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-image-1',
    })
    await expect(transport.submit(request())).rejects.toThrow(/https/)
  })

  it('accepts a full generation endpoint with query parameters', async () => {
    const server = await startServer((_request, response) => json(response, 200, imageBody()))
    const transport = transportFor(`${server.origin}/openai/deployments/d/images/generations?api-version=2024-10-21`)
    const submitted = await transport.submit(request())
    await waitAnswered(transport, submitted.submissionId)

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.url).toBe('/openai/deployments/d/images/generations?api-version=2024-10-21')
  })

  it('probes the model list and tolerates providers without /models', async () => {
    const listed = await startServer((request, response) => {
      if (request.url === '/v1/models') json(response, 200, { data: [{ id: 'gpt-image-1' }, { id: 'dall-e-3' }] })
      else json(response, 404, {})
    })
    const transport = transportFor(listed.baseUrl)
    const probe = await transport.probe()
    expect(probe.ok).toBe(true)
    expect(probe.available).toEqual(['gpt-image-1', 'dall-e-3'])
    expect(probe.reason).toBeUndefined()

    const bare = await startServer((_request, response) => json(response, 404, {}))
    const fallback = await transportFor(bare.baseUrl).probe()
    expect(fallback.ok).toBe(true)
    expect(fallback.reason).toContain('/models')
  })

  it('runs at most two directions concurrently', async () => {
    let inflight = 0
    let maxInflight = 0
    const server = await startServer(async (_request, response) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise(resolve => setTimeout(resolve, 120))
      inflight -= 1
      json(response, 200, imageBody())
    })
    const transport = transportFor(server.baseUrl)
    const startedAt = Date.now()
    const submitted = await transport.submit(request({ designs: 3 }))
    const answer = await waitAnswered(transport, submitted.submissionId)
    const elapsed = Date.now() - startedAt

    expect(answer.images).toHaveLength(3)
    expect(maxInflight).toBe(2)
    // Three sequential 120ms calls would take >= 360ms; two lanes finish sooner.
    expect(elapsed).toBeLessThan(340)
  })

  it('reports progress only when a direction actually completes', async () => {
    const server = await startServer(async (_request, response) => {
      // poll() clamps its slice to >= 1s, so the provider must outlast that.
      await new Promise(resolve => setTimeout(resolve, 1_600))
      json(response, 200, imageBody())
    })
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request({ designs: 1 }))

    const early = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 30 })
    expect(early.state).toBe('waiting')
    expect(early.progress).toBeUndefined()

    const answer = await waitAnswered(transport, submitted.submissionId, 8_000)
    expect(answer.images).toHaveLength(1)
  }, 10_000)

  it('releases a failed job after surfacing its error once', async () => {
    const server = await startServer((_request, response) => json(response, 500, { error: 'boom' }))
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request())

    const error = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 5_000 }).catch(caught => caught)
    expect(error).toBeInstanceOf(TransportError)
    const after = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 50 })
    expect(after.state).toBe('unknown')
  })

  it('retries a rate-limited direction once and still completes the round', async () => {
    let calls = 0
    const server = await startServer((_request, response) => {
      calls += 1
      if (calls === 1) json(response, 429, { error: 'slow down' })
      else json(response, 200, imageBody())
    })
    const transport = transportFor(server.baseUrl)
    const submitted = await transport.submit(request({ designs: 2 }))
    const answer = await waitAnswered(transport, submitted.submissionId, 10_000)

    expect(answer.images).toHaveLength(2)
    expect(server.requests).toHaveLength(3)
    expect(answer.answer).toContain('结果：2 张 / 请求 2 个方向')
  }, 15_000)
})
