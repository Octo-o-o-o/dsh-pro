import { describe, expect, it } from 'vitest'
import { readResponseBody, ResponseBodyLimitError } from '../src/response-body.ts'

function streamed(chunks: Uint8Array[], headers?: Record<string, string>) {
  let reads = 0
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 }), { headers })
  return { response, reads: () => reads, cancelled: () => cancelled }
}

describe('bounded response reader', () => {
  it('accepts exact-limit bytes and preserves split UTF-8', async () => {
    const text = Buffer.from('中文 fixture')
    const { response } = streamed([text.subarray(0, 1), text.subarray(1, 5), text.subarray(5)])
    expect((await readResponseBody(response, text.byteLength)).toString('utf8')).toBe('中文 fixture')
    expect(response.body?.locked).toBe(false)
  })

  it.each([undefined, '1', 'not a number'])('counts actual chunked bytes independently of declared %s', async declared => {
    const body = streamed([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)], declared === undefined ? undefined : { 'content-length': declared })
    await expect(readResponseBody(body.response, 8)).rejects.toBeInstanceOf(ResponseBodyLimitError)
    expect(body.reads()).toBe(3)
    expect(body.cancelled()).toBe(true)
    expect(body.response.body?.locked).toBe(false)
  })

  it('rejects oversized declarations without reading', async () => {
    const body = streamed([Buffer.from('never read')], { 'content-length': '100' })
    await expect(readResponseBody(body.response, 8)).rejects.toBeInstanceOf(ResponseBodyLimitError)
    expect(body.reads()).toBe(0)
    expect(body.cancelled()).toBe(true)
  })

  it('rejects an already aborted read without pulling', async () => {
    const body = streamed([Buffer.from('never read')])
    const signal = new AbortController()
    signal.abort()
    await expect(readResponseBody(body.response, 100, signal.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(body.reads()).toBe(0)
    expect(body.cancelled()).toBe(true)
  })

  it('aborts a stalled read even if the source cancel hook stalls too', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}) } }))
    const signal = new AbortController()
    const pending = readResponseBody(response, 100, signal.signal)
    signal.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
    expect(response.body?.locked).toBe(false)
  })

  it('preserves timeout reasons while cancelling the reader', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
    const signal = new AbortController()
    const pending = readResponseBody(response, 100, signal.signal)
    signal.abort(new DOMException('timed out', 'TimeoutError'))
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(cancelled).toBe(true)
  })

  it('coalesces many tiny chunks without adding trailing bytes', async () => {
    const size = 64 * 1024 + 3
    let index = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === size) controller.close()
        else controller.enqueue(Uint8Array.of(index++ % 251))
      },
    }, { highWaterMark: 0 }))
    const result = await readResponseBody(response, size)
    expect(result.byteLength).toBe(size)
    expect(result[0]).toBe(0)
    expect(result[size - 1]).toBe((size - 1) % 251)
  })
})
