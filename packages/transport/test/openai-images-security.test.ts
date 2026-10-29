import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchedAnswer, SubmitRequest } from '@dsh-pro/core'
import { OpenAIImageTransport } from '../src/openai-images.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2048, 7)])
const imageJson = (): string => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
const imageResponse = (): Response => new Response(imageJson(), { headers: { 'content-type': 'application/json' } })
const request = (extra: Partial<SubmitRequest> = {}): SubmitRequest => ({ topicId: 'security-fixture', round: 1, brief: 'fixture-only-prompt', files: [], model: 'fixture-model', ...extra })
const transportFor = (extra: Partial<ConstructorParameters<typeof OpenAIImageTransport>[0]> = {}): OpenAIImageTransport => {
  const transport = new OpenAIImageTransport({ baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model', timeoutMs: 2_000, ...extra })
  cleanups.push(async () => { transport.dispose() })
  return transport
}
const tick = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }

async function answer(transport: OpenAIImageTransport, extra: Partial<SubmitRequest> = {}): Promise<FetchedAnswer> {
  const submitted = await transport.submit(request(extra))
  const polled = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 3_000 })
  if (polled.state !== 'answered') throw new Error(`unexpected state: ${polled.state}`)
  return await transport.fetch({ submissionId: submitted.submissionId })
}

async function reference(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-security-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const file = join(root, 'reference.png')
  await writeFile(file, PNG)
  return file
}

async function server(handler: (url: string, response: ServerResponse) => void): Promise<{ origin: string; requests: Array<{ url: string; apiKey?: string; body: string }> }> {
  const requests: Array<{ url: string; apiKey?: string; body: string }> = []
  const instance = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const chunk of req) parts.push(chunk as Buffer)
    const key = req.headers['api-key']
    requests.push({ url: req.url ?? '', ...(typeof key === 'string' ? { apiKey: key } : {}), body: Buffer.concat(parts).toString('utf8') })
    handler(req.url ?? '', res)
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  cleanups.push(async () => {
    instance.closeAllConnections()
    await new Promise<void>(resolve => instance.close(() => resolve()))
  })
  return { origin: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`, requests }
}

function chunkedResponse(parts: Uint8Array[], status = 200, headers?: Record<string, string>): { response: Response; reads: () => number; cancelled: () => boolean } {
  let reads = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[reads++]
      if (part === undefined) controller.close()
      else controller.enqueue(part)
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  return { response: new Response(stream, { status, headers }), reads: () => reads, cancelled: () => cancelled }
}

describe('image API request boundaries', () => {
  it.each(['http://remote-provider.invalid/v1', 'ftp://provider.invalid/v1', 'not a URL', 'https://user:password@provider.invalid/v1'])('does not probe an unsafe endpoint: %s', async baseUrl => {
    let calls = 0
    const transport = transportFor({ baseUrl, fetchImpl: async () => { calls++; return new Response('{"data":[]}') } })
    expect(await transport.probe()).toMatchObject({ ok: false })
    expect(calls).toBe(0)
  })

  it.each([
    { auth: 'basic' }, { editMode: 'always' }, { format: 'gif' }, { timeoutMs: -1 },
  ])('validates probe configuration before fetch: %j', async invalid => {
    let calls = 0
    const transport = transportFor({ ...invalid, fetchImpl: async () => { calls++; return new Response('{"data":[]}') } } as unknown as Partial<ConstructorParameters<typeof OpenAIImageTransport>[0]>)
    expect(await transport.probe()).toMatchObject({ ok: false })
    expect(calls).toBe(0)
  })

  it('keeps a probe timeout distinct from the configured image timeout', async () => {
    const transport = transportFor({ timeoutMs: 300_000, fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError') } })
    expect(await transport.probe()).toMatchObject({ ok: false, reason: expect.stringContaining('预检超时') })
  })

  it.each([302, 307])('blocks cross-origin HTTP %i on probe, generation, edit and image download', async status => {
    const sink = await server((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(imageJson())
    })
    const source = await server((url, res) => {
      if (url === '/v1/images/generations?download=1') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ url: `${source.origin}/asset.png` }] }))
      } else {
        res.writeHead(status, { location: `${sink.origin}/stolen` })
        res.end()
      }
    })
    const transport = transportFor({ baseUrl: `${source.origin}/v1`, auth: 'api-key' })
    expect(await transport.probe()).toMatchObject({ ok: false })
    await expect(answer(transport)).rejects.toBeInstanceOf(Error)
    await expect(answer(transport, { files: [await reference()] })).rejects.toBeInstanceOf(Error)
    const download = transportFor({ baseUrl: `${source.origin}/v1?download=1`, auth: 'api-key' })
    await expect(answer(download)).rejects.toBeInstanceOf(Error)
    expect(sink.requests).toEqual([])
    expect(source.requests.some(entry => entry.url === '/asset.png')).toBe(true)
  })

  it('explicitly rejects redirects even when a fetch substitute returns them', async () => {
    const modes: Array<RequestRedirect | undefined> = []
    const transport = transportFor({ fetchImpl: async (_url, init) => {
      modes.push(init?.redirect)
      return new Response(null, { status: 307, headers: { location: 'http://remote-provider.invalid/stolen' } })
    } })
    await expect(answer(transport)).rejects.toMatchObject({ failure: 'config' })
    expect(modes).toEqual(['error'])
  })
})

describe('image API worker lifecycle', () => {
  it.each([400, 401])('aborts and drains the other lane before surfacing fatal HTTP %i', async status => {
    let calls = 0
    let secondAborted = false
    let secondCleaned = false
    let releaseCleanup!: () => void
    let releaseSecond!: () => void
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    const transport = transportFor({ fetchImpl: async (_url, init) => {
      calls++
      if (calls === 1) return new Response('{"error":"fatal fixture"}', { status })
      if (calls > 2) return imageResponse()
      return await new Promise<Response>((resolve, reject) => {
        releaseSecond = () => resolve(imageResponse())
        const aborted = (): void => {
          secondAborted = true
          void cleanup.then(() => { secondCleaned = true; reject(new DOMException('aborted', 'AbortError')) })
        }
        if (init?.signal?.aborted) aborted()
        else init?.signal?.addEventListener('abort', aborted, { once: true })
      })
    } })
    const submitted = await transport.submit(request({ designs: 6 }))
    let pollFinished = false
    const polled = transport.poll({ submissionId: submitted.submissionId, timeoutMs: 3_000 }).catch(error => error).then(value => { pollFinished = true; return value })
    try {
      await tick()
      expect(secondAborted).toBe(true)
      expect(pollFinished).toBe(false)
      releaseCleanup()
      const error = await polled as { failure: string; message: string }
      expect(error.failure).toBe(status === 401 ? 'login' : 'config')
      expect(error.message).toContain(String(status))
      expect(secondCleaned).toBe(true)
      expect(calls).toBe(2)
      expect(await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 1 })).toEqual({ state: 'unknown' })
    } finally {
      releaseCleanup()
      releaseSecond()
      await tick()
    }
  })

  it('cancels a stalled response body through the request signal', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; controller.enqueue(Buffer.from('{"data":[')) },
      cancel() { cancelled = true },
    })
    const signal = new AbortController()
    const transport = transportFor({ fetchImpl: async () => new Response(body) })
    const submitted = await transport.submit(request({ signal: signal.signal }))
    try {
      await tick()
      signal.abort()
      await expect(transport.poll({ submissionId: submitted.submissionId, timeoutMs: 1 })).rejects.toMatchObject({ name: 'AbortError' })
      expect(cancelled).toBe(true)
    } finally {
      try { streamController.close() } catch { /* already cancelled */ }
    }
  })

  it.each(['cancel', 'cancelSubmission'] as const)('drains both workers and starts no further directions on %s', async action => {
    let calls = 0
    let aborted = 0
    const transport = transportFor({ fetchImpl: async (_url, init) => {
      calls++
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => { aborted++; reject(new DOMException('aborted', 'AbortError')) }
        if (init?.signal?.aborted) onAbort()
        else init?.signal?.addEventListener('abort', onAbort, { once: true })
      })
    } })
    const submitted = await transport.submit(request({ designs: 6 }))
    if (action === 'cancel') await transport.cancel()
    else await transport.cancelSubmission(submitted.submissionId)
    expect(calls).toBe(2)
    expect(aborted).toBe(2)
    if (action === 'cancel') {
      await expect(transport.poll({ submissionId: submitted.submissionId, timeoutMs: 1 })).rejects.toMatchObject({ name: 'AbortError' })
    } else expect(await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 1 })).toEqual({ state: 'unknown' })
  })

  it('classifies a late response after request timeout without reading its body', async () => {
    const body = chunkedResponse([Buffer.from(imageJson())])
    const transport = transportFor({ timeoutMs: 10, fetchImpl: async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      return body.response
    } })
    await expect(answer(transport)).rejects.toMatchObject({ failure: 'timeout' })
    expect(body.reads()).toBe(0)
    expect(body.cancelled()).toBe(true)
  })

  it.each(['generation', 'edit', 'download'] as const)('enforces the timeout while a %s response body is stalled', async kind => {
    let cancelled = false
    let calls = 0
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const transport = transportFor({ timeoutMs: 20, fetchImpl: async () => {
      calls++
      if (kind === 'download' && calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.invalid/image.png' }] }))
      return new Response(body)
    } })
    await expect(answer(transport, kind === 'edit' ? { files: [await reference()] } : {})).rejects.toMatchObject({ failure: 'timeout' })
    expect(cancelled).toBe(true)
  })
})

describe('bounded API response bodies', () => {
  it.each(['generation', 'edit'] as const)('rejects oversized declared %s JSON without pulling its body', async kind => {
    const body = chunkedResponse([Buffer.from(imageJson())], 200, { 'content-length': String(1024 * 1024 * 1024) })
    const transport = transportFor({ fetchImpl: async () => body.response })
    await expect(answer(transport, kind === 'edit' ? { files: [await reference()] } : {})).rejects.toMatchObject({ failure: 'config' })
    expect(body.reads()).toBe(0)
    expect(body.cancelled()).toBe(true)
  })

  it('caps generation JSON with no declared length before buffering the full body', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x78)
    const parts = [Buffer.from('{"data":[],"padding":"'), ...Array.from({ length: 72 }, () => chunk), Buffer.from('"}')]
    const body = chunkedResponse(parts)
    const transport = transportFor({ fetchImpl: async () => body.response })
    await expect(answer(transport)).rejects.toMatchObject({ failure: 'config', message: expect.stringMatching(/上限/) })
    expect(body.cancelled()).toBe(true)
    expect(body.reads()).toBeLessThan(parts.length)
  })

  it('caps chunked model JSON and stops its reader', async () => {
    const body = chunkedResponse([
      Buffer.from('{"data":[],"padding":"'),
      ...Array.from({ length: 18 }, () => Buffer.alloc(64 * 1024, 0x78)),
      Buffer.from('"}'),
    ])
    const transport = transportFor({ fetchImpl: async () => body.response })
    expect(await transport.probe()).toMatchObject({ ok: false })
    expect(body.cancelled()).toBe(true)
    expect(body.reads()).toBeLessThan(20)
  })

  it.each(['generation', 'edit'] as const)('caps a chunked %s error without losing its HTTP classification', async kind => {
    const body = chunkedResponse(Array.from({ length: 24 }, () => Buffer.alloc(1024, 0x78)), 400)
    const transport = transportFor({ fetchImpl: async () => body.response })
    await expect(answer(transport, kind === 'edit' ? { files: [await reference()] } : {})).rejects.toMatchObject({ failure: 'config', message: expect.stringMatching(/上限/) })
    expect(body.cancelled()).toBe(true)
    expect(body.reads()).toBeLessThan(24)
  })

  it('accepts only the single image requested per direction', async () => {
    const transport = transportFor({ fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }] })) })
    await expect(answer(transport)).rejects.toMatchObject({ failure: 'config' })
  })
})

describe('provider credential redaction', () => {
  const key = 'opaque.provider+credential/%"suffix'
  it.each(['http', 'network', 'probe', 'edit', 'download', 'abort'] as const)('redacts the exact arbitrary key and URL queries from %s failures', async kind => {
    const detail = `credential=${key}; encoded=${encodeURIComponent(key)}; escaped=${JSON.stringify(key)}; https://provider.invalid/file?signature=unrelated-signed-secret`
    let calls = 0
    const transport = transportFor({ apiKey: key, fetchImpl: async () => {
      calls++
      if (kind === 'download' && calls === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.invalid/image.png?signature=fixture' }] }))
      if (kind === 'http' || kind === 'edit') return new Response(JSON.stringify({ error: detail }), { status: 400 })
      if (kind === 'abort') throw new DOMException(detail, 'AbortError')
      throw new Error(detail)
    } })
    const message = kind === 'probe'
      ? (await transport.probe()).reason ?? ''
      : await answer(transport, kind === 'edit' ? { files: [await reference()] } : {}).then(() => '', error => (error as Error).message)
    expect(message).not.toContain(key)
    expect(message).not.toContain(encodeURIComponent(key))
    expect(message).not.toContain(JSON.stringify(key).slice(1, -1))
    expect(message).not.toContain('unrelated-signed-secret')
  })
})
