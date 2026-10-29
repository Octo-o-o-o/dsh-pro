/** Limits apply to decoded response bytes, including chunked/compressed bodies. */
export class ResponseBodyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds ${limit} bytes`)
    this.name = 'ResponseBodyLimitError'
  }
}

/**
 * Do not let response.json()/text() allocate an unbounded provider payload.
 * Cancellation also races a stalled read: a fetch substitute (or an already
 * returned body) need not automatically connect the request signal to a reader.
 */
export async function readResponseBody(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (signal?.aborted || (Number.isFinite(declared) && declared > limit)) {
    void response.body?.cancel().catch(() => undefined)
    signal?.throwIfAborted()
    throw new ResponseBodyLimitError(limit)
  }
  if (response.body === null) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let tail: Buffer | undefined
  let used = 0
  let total = 0
  const onAbort = (): void => {
    // cancel() closes pending reads immediately, even if the underlying
    // source's optional asynchronous cancel hook never finishes.
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new ResponseBodyLimitError(limit)
      // Coalesce tiny chunks: one Buffer per attacker-controlled chunk would
      // allow huge object overhead despite a bound on their aggregate bytes.
      for (let offset = 0; offset < value.byteLength;) {
        if (tail === undefined || used === tail.byteLength) {
          tail = Buffer.allocUnsafe(Math.min(64 * 1024, limit))
          chunks.push(tail)
          used = 0
        }
        const count = Math.min(value.byteLength - offset, tail.byteLength - used)
        tail.set(value.subarray(offset, offset + count), used)
        used += count
        offset += count
      }
    }
    if (tail !== undefined) chunks[chunks.length - 1] = tail.subarray(0, used)
    return Buffer.concat(chunks, total)
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}
