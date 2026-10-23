import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  FetchedAnswer,
  ImageAsset,
  ImageFormat,
  PollResult,
  SubmitRequest,
  SubmitResult,
  Transport,
} from 'dsh-pro-core'
import { TransportError } from 'dsh-pro-core'
import { detectImageMime } from './assets.ts'

export interface OpenAIImageOptions {
  /** Base URL including its version prefix, e.g. https://api.openai.com/v1. */
  baseUrl: string
  apiKey: string
  model: string
  /** `auto` leaves `size` out of the request body. */
  size?: string
  /** `auto` leaves `quality` out of the request body. */
  quality?: string
  format?: ImageFormat
  auth?: 'bearer' | 'api-key'
  /** `auto` sends image materials to /images/edits; `off` ignores them. */
  editMode?: 'auto' | 'off'
  timeoutMs?: number
  /** Images per round when the submit request does not carry `designs`. */
  count?: number
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

const MAX_IMAGES = 6
const MAX_REFERENCES = 4
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4_096
const MIN_IMAGE_BYTES = 1_024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

interface Reference {
  name: string
  mime: string
  bytes: Buffer
}

interface Job {
  request: SubmitRequest
  count: number
  controller: AbortController
  /** Never rejects: poll decides what to surface from `result` / `error`. */
  settled: Promise<void>
  result?: FetchedAnswer
  error?: unknown
  /** Directions finished so far; the engine's stall clock keys off changes. */
  completed: number
  /** `completed` value already reported as progress to the engine. */
  reported: number
}

interface ImagePayload {
  b64_json?: unknown
  base64?: unknown
  url?: unknown
  revised_prompt?: unknown
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function clampCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.max(1, Math.min(MAX_IMAGES, Math.floor(value)))
}

function extensionFor(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  return 'png'
}

function mimeForFormat(format: ImageFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
}

/** True for the rate-limit family that deserves one backoff retry. */
function isRateLimited(error: unknown): boolean {
  return error instanceof TransportError && error.failure === 'timeout' && /429|限流/.test(error.message)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted')
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep provider bodies useful without echoing an accidental credential. */
function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/(api-key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***')
    .slice(0, 800)
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): { promise: Promise<T | 'aborted'>; dispose: () => void } {
  let listener: (() => void) | undefined
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve('aborted')
      return
    }
    listener = () => resolve('aborted')
    signal.addEventListener('abort', listener, { once: true })
  })
  return {
    promise: Promise.race([promise, aborted]),
    dispose: () => {
      if (listener !== undefined) signal?.removeEventListener('abort', listener)
    },
  }
}

function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return []
  const ids: string[] = []
  for (const item of data) {
    if (typeof item === 'string') ids.push(item)
    else if (item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      ids.push((item as { id: string }).id)
    }
  }
  return ids
}

/**
 * OpenAI-compatible image generation (`POST {baseUrl}/images/generations`, plus
 * `/images/edits` when image materials are attached). One round makes one call
 * per design direction so a provider's `n` semantics cannot collapse them into
 * a collage. Nothing here touches the ChatGPT page or its browser profile.
 */
export class OpenAIImageTransport implements Transport {
  private readonly jobs = new Map<string, Job>()
  private readonly fetchImpl: typeof fetch
  private readonly options: Required<Omit<OpenAIImageOptions, 'fetchImpl'>>

  constructor(options: OpenAIImageOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.options = {
      baseUrl: options.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: options.apiKey.trim(),
      model: options.model.trim(),
      size: (options.size ?? 'auto').trim(),
      quality: (options.quality ?? 'auto').trim(),
      format: options.format ?? 'png',
      auth: options.auth ?? 'bearer',
      editMode: options.editMode ?? 'auto',
      timeoutMs: options.timeoutMs ?? 300_000,
      count: options.count ?? 1,
    }
  }

  /** Fail fast, before anything billable, with an actionable message. */
  private assertReady(): void {
    let url: URL
    try {
      url = new URL(this.options.baseUrl)
    } catch {
      throw new TransportError('imageBaseUrl 不是合法 URL（示例：https://api.openai.com/v1）', 'config')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TransportError('imageBaseUrl 必须以 http:// 或 https:// 开头', 'config')
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      throw new TransportError('imageBaseUrl 只有本机回环地址允许 http；远程服务商请用 https', 'config')
    }
    if (this.options.apiKey === '') {
      throw new TransportError('imageApiKey 为空：在插件设置里填写，或设置环境变量 GPT_IMAGE_API_KEY', 'config')
    }
    if (this.options.model === '') throw new TransportError('imageModel 为空', 'config')
  }

  private origin(): string {
    try {
      return new URL(this.options.baseUrl).origin
    } catch {
      return 'api'
    }
  }

  private endpoint(kind: 'generations' | 'edits'): string {
    const base = this.options.baseUrl
    let url: URL
    try {
      url = new URL(base)
    } catch {
      return `${base}/images/${kind}`
    }
    if (/\/images\/(generations|edits)$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/images\/(generations|edits)$/, `/images/${kind}`)
      return url.toString()
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/images/${kind}`
    return url.toString()
  }

  private authHeaders(): Record<string, string> {
    if (this.options.apiKey === '') return {}
    return this.options.auth === 'api-key'
      ? { 'api-key': this.options.apiKey }
      : { authorization: `Bearer ${this.options.apiKey}` }
  }

  private headers(): Record<string, string> {
    return { accept: 'application/json', ...this.authHeaders() }
  }

  private signalFor(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(this.options.timeoutMs)])
  }

  private httpError(status: number, body: string): TransportError {
    const detail = body === '' ? '' : ` 响应：${redact(body)}`
    if (status === 401 || status === 403) {
      return new TransportError(`生图 API 鉴权失败（HTTP ${status}）。检查 imageApiKey / imageAuth。${detail}`, 'login')
    }
    if (status === 429) {
      return new TransportError(`生图 API 限流（HTTP 429），可稍后恢复重试。${detail}`, 'timeout')
    }
    if (status >= 500) {
      return new TransportError(`生图 API 服务端错误（HTTP ${status}），可稍后恢复重试。${detail}`, 'network')
    }
    return new TransportError(`生图 API 拒绝了请求（HTTP ${status}），检查 imageBaseUrl / imageModel / 参数。${detail}`, 'config')
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (error) {
      throw this.networkError(error)
    }
    if (!response.ok) throw this.httpError(response.status, await response.text().catch(() => ''))
    try {
      return (await response.json()) as Record<string, unknown>
    } catch {
      throw new TransportError('生图 API 返回的不是 JSON', 'config')
    }
  }

  private networkError(error: unknown): TransportError {
    if (isTimeoutLike(error)) {
      return new TransportError(`单张图片超过 ${Math.round(this.options.timeoutMs / 1000)} 秒仍未返回`, 'timeout')
    }
    if (isAbortLike(error)) throw error
    return new TransportError(`无法连接生图 API（${this.origin()}）：${messageOf(error)}`, 'network')
  }

  private modelsUrl(): string {
    const base = this.options.baseUrl
    let url: URL
    try {
      url = new URL(base)
    } catch {
      return `${base}/models`
    }
    if (/\/images\/(generations|edits)$/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/images\/(generations|edits)$/, '')}/models`
    } else {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
    }
    return url.toString()
  }

  async probe(): Promise<{ ok: boolean; loggedIn: boolean; model: string; available: string[]; reason?: string }> {
    const model = this.options.model
    if (this.options.apiKey === '') {
      return { ok: false, loggedIn: false, model, available: [], reason: '未配置 imageApiKey（或环境变量 GPT_IMAGE_API_KEY）' }
    }
    try {
      const response = await this.fetchImpl(this.modelsUrl(), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status === 401 || response.status === 403) {
        return { ok: false, loggedIn: false, model, available: [], reason: `鉴权失败（HTTP ${response.status}），检查 imageApiKey / imageAuth` }
      }
      if (response.status === 404 || response.status === 405) {
        return { ok: true, loggedIn: true, model, available: [], reason: '服务商未提供 /models，无法预检；直接生图会暴露模型名问题' }
      }
      if (!response.ok) {
        return { ok: false, loggedIn: false, model, available: [], reason: `预检失败（HTTP ${response.status}）` }
      }
      const body = await response.json().catch(() => undefined)
      const available = modelIds(body)
      const missing = available.length > 0 && !available.includes(model)
      return {
        ok: true,
        loggedIn: true,
        model,
        available,
        ...(missing ? { reason: `模型 ${model} 不在服务商列表里；若报 404 请改 imageModel` } : {}),
      }
    } catch (error) {
      if (isTimeoutLike(error)) {
        return { ok: false, loggedIn: false, model, available: [], reason: `预检超时（${this.origin()}）` }
      }
      return { ok: false, loggedIn: false, model, available: [], reason: `无法连接 ${this.origin()}：${messageOf(error)}` }
    }
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    this.assertReady()
    const count = clampCount(request.designs ?? this.options.count)
    const references = await this.referenceImages(request.files)
    const prompt = this.basePrompt(request)
    const controller = new AbortController()
    const id = randomUUID()
    const job = { request, count, controller, completed: 0, reported: 0 } as Job
    const generated = this.generate(job, prompt, references)
    job.settled = generated.then(() => undefined, () => undefined)
    void generated.then(
      result => { job.result = result },
      error => { job.error = error },
    )
    this.jobs.set(id, job)
    return {
      submissionId: id,
      fingerprint: sha256([
        this.options.baseUrl,
        this.options.model,
        this.options.size,
        this.options.quality,
        String(count),
        prompt,
        ...references.map(reference => reference.name),
      ].join('\n')),
      attachments: references.map(reference => reference.name),
      conversationUrl: `api://${this.origin()}/${encodeURIComponent(this.options.model)}`,
    }
  }

  async poll(request: { submissionId: string; timeoutMs: number; signal?: AbortSignal }): Promise<PollResult> {
    const job = this.jobs.get(request.submissionId)
    if (job === undefined) return { state: 'unknown' }
    if (request.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
    const raced = abortable(job.settled, request.signal)
    let timer: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        raced.promise,
        new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => resolve('timeout'), Math.max(1_000, request.timeoutMs))
          timer.unref?.()
        }),
      ])
      if (outcome === 'aborted') throw new DOMException('aborted', 'AbortError')
      if (outcome === 'timeout') {
        // Honest progress: only a newly finished direction resets the engine's
        // stall clock. A stuck request no longer looks alive forever.
        const progressed = job.completed > job.reported
        job.reported = job.completed
        return progressed ? { state: 'waiting', progress: true } : { state: 'waiting' }
      }
      if (job.error !== undefined) {
        // Surface a failure once, then release the job (and its payload refs).
        this.jobs.delete(request.submissionId)
        throw job.error
      }
      return { state: 'answered', answer: job.result?.answer ?? '' }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      raced.dispose()
    }
  }

  async fetch(request: { submissionId: string }): Promise<FetchedAnswer> {
    const job = this.jobs.get(request.submissionId)
    if (job === undefined) {
      throw new TransportError('API 生图任务已丢失（DSH 可能重启过）；这一轮不会自动重发', 'config')
    }
    if (job.error !== undefined) {
      this.jobs.delete(request.submissionId)
      throw job.error
    }
    if (job.result === undefined) throw new TransportError('API 图片还没生成完', 'ui')
    // Fetched once per answered round; drop the base64 payload afterwards.
    const result = job.result
    this.jobs.delete(request.submissionId)
    return result
  }

  /** Abort every in-flight request; the engine records the round as cancelled. */
  async cancelSubmission(submissionId: string): Promise<void> {
    const job = this.jobs.get(submissionId)
    if (job === undefined) return
    this.jobs.delete(submissionId)
    job.controller.abort()
  }

  async cancel(): Promise<void> {
    // Abort only: the next poll/fetch surfaces each job's AbortError (and
    // releases the job there), which keeps the engine's cancel path intact.
    for (const job of this.jobs.values()) job.controller.abort()
  }

  dispose(): void {
    void this.cancel()
    this.jobs.clear()
  }

  private basePrompt(request: SubmitRequest): string {
    return request.brief.trim()
  }

  private directionPrompt(base: string, index: number, count: number, references: number): string {
    const parts = [base]
    if (count > 1) {
      parts.push(`---\n本次只生成第 ${index + 1} 个方向（共 ${count} 个）。构图、配色与字体气质要和其他方向明显不同；只输出这一张图，不要拼图、不要九宫格。`)
    }
    if (references > 0) {
      parts.push(`随附 ${references} 张参考图：按任务约束使用其中的品牌元素与版式，不要照抄与任务无关的内容。`)
    }
    return parts.join('\n\n')
  }

  private bodyFor(prompt: string): Record<string, unknown> {
    const body: Record<string, unknown> = { model: this.options.model, prompt, n: 1 }
    if (this.options.size !== '' && this.options.size !== 'auto') body.size = this.options.size
    if (this.options.quality !== '' && this.options.quality !== 'auto') body.quality = this.options.quality
    if (this.options.format !== 'png') body.output_format = this.options.format
    // gpt-image-* always returns b64_json and rejects the field; dall-e needs it.
    if (/^dall-e/i.test(this.options.model)) body.response_format = 'b64_json'
    return body
  }

  private async generateOne(job: Job, direction: string, references: Reference[]): Promise<ImageAsset[]> {
    try {
      return references.length > 0
        ? await this.edit(direction, references, job.controller.signal)
        : await this.generation(direction, job.controller.signal)
    } catch (error) {
      // A rate-limited direction gets one backoff retry before being recorded
      // as failed; concurrency 2 doubles the instantaneous request rate, so a
      // bare retry keeps tight-RPM providers usable.
      if (!isRateLimited(error) || job.controller.signal.aborted) throw error
      await delay(2_000, job.controller.signal)
      return references.length > 0
        ? await this.edit(direction, references, job.controller.signal)
        : await this.generation(direction, job.controller.signal)
    }
  }

  private async generate(job: Job, prompt: string, references: Reference[]): Promise<FetchedAnswer> {
    const request = job.request
    // Bounded fan-out (2 at a time), order-preserving: results stay indexed by
    // direction even though directions run concurrently.
    const results: Array<ImageAsset[] | undefined> = Array.from({ length: job.count })
    const prompts: string[] = []
    const failures: string[] = []
    let firstError: unknown
    let next = 0
    const worker = async (): Promise<void> => {
      while (true) {
        if (job.controller.signal.aborted) throw new DOMException('aborted', 'AbortError')
        const index = next
        next += 1
        if (index >= job.count) return
        const direction = this.directionPrompt(prompt, index, job.count, references.length)
        prompts[index] = direction
        try {
          const produced = await this.generateOne(job, direction, references)
          results[index] = produced
          job.completed += 1
        } catch (error) {
          if (job.controller.signal.aborted || isAbortLike(error)) throw error
          if (error instanceof TransportError && (error.failure === 'login' || error.failure === 'config' || error.failure === 'worker')) {
            throw error
          }
          if (firstError === undefined) firstError = error
          failures.push(`第 ${index + 1} 个方向失败：${messageOf(error)}`)
        }
      }
    }
    const lanes = Array.from({ length: Math.min(2, job.count) }, () => worker())
    await Promise.all(lanes)
    const images = results.flatMap(result => result ?? [])
    if (images.length === 0) {
      if (firstError instanceof TransportError) throw firstError
      throw new TransportError(
        `一轮都没有生成成功：${failures.join('；') || messageOf(firstError)}`,
        'network',
      )
    }
    images.forEach((image, index) => {
      image.name = `image-${pad(index + 1)}.${extensionFor(image.mime)}`
    })
    return {
      answer: this.answerText(request, job.count, images, failures, prompts, references),
      images,
    }
  }

  private async generation(prompt: string, signal: AbortSignal): Promise<ImageAsset[]> {
    const body = await this.requestJson(this.endpoint('generations'), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(this.bodyFor(prompt)),
      signal: this.signalFor(signal),
    })
    return await this.collect(body, signal)
  }

  private async edit(prompt: string, references: Reference[], signal: AbortSignal): Promise<ImageAsset[]> {
    const form = new FormData()
    form.set('model', this.options.model)
    form.set('prompt', prompt)
    form.set('n', '1')
    if (this.options.size !== '' && this.options.size !== 'auto') form.set('size', this.options.size)
    if (this.options.quality !== '' && this.options.quality !== 'auto') form.set('quality', this.options.quality)
    if (this.options.format !== 'png') form.set('output_format', this.options.format)
    if (/^dall-e/i.test(this.options.model)) form.set('response_format', 'b64_json')
    for (const reference of references) {
      // Copy into a plain Uint8Array: Node's Buffer is backed by ArrayBufferLike,
      // which the DOM BlobPart type rejects.
      const copy = new Uint8Array(reference.bytes.byteLength)
      copy.set(reference.bytes)
      form.append('image[]', new Blob([copy], { type: reference.mime }), reference.name)
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint('edits'), {
        method: 'POST',
        headers: this.authHeaders(),
        body: form,
        signal: this.signalFor(signal),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (!response.ok) {
      const detail = redact(await response.text().catch(() => ''))
      if (response.status === 400 || response.status === 404 || response.status === 422) {
        throw new TransportError(
          `参考图接口 /images/edits 被拒（HTTP ${response.status}）：${detail}。若该服务商或模型不支持参考图，把 imageEdit 设为 off 再试。`,
          'config',
        )
      }
      throw this.httpError(response.status, detail)
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (body === undefined) throw new TransportError('生图 API 返回的不是 JSON', 'config')
    return await this.collect(body, signal)
  }

  private async collect(body: Record<string, unknown>, signal: AbortSignal): Promise<ImageAsset[]> {
    const raw = Array.isArray(body.data) ? body.data : Array.isArray(body.images) ? body.images : []
    if (raw.length === 0) {
      const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body).slice(0, 300)
      throw new TransportError(`生图 API 没有返回图片：${redact(detail)}`, 'config')
    }
    const images: ImageAsset[] = []
    for (const item of raw as Array<ImagePayload | string>) {
      if (typeof item === 'string') {
        images.push(/^https?:\/\//i.test(item) ? await this.download(item, signal) : this.decodeBase64(item))
        continue
      }
      const payload = item !== null && typeof item === 'object' ? item : {}
      const encoded = typeof payload.b64_json === 'string'
        ? payload.b64_json
        : typeof payload.base64 === 'string' ? payload.base64 : undefined
      if (encoded !== undefined) {
        const parsed = this.decodeBase64(encoded)
        images.push(parsed)
        continue
      }
      if (typeof payload.url === 'string' && payload.url !== '') {
        images.push(await this.download(payload.url, signal))
        continue
      }
      throw new TransportError('生图 API 返回了既没有 b64_json 也没有 url 的条目', 'config')
    }
    return images
  }

  private decodeBase64(value: string): ImageAsset {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(value.trim())
    const mime = match?.[1] ?? mimeForFormat(this.options.format)
    const base64 = (match?.[2] ?? value).replace(/\s+/g, '')
    if (base64.length > MAX_BASE64_CHARS) {
      throw new TransportError(`生图 API 返回的 base64 超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`, 'config')
    }
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.byteLength < MIN_IMAGE_BYTES) {
      throw new TransportError(`生图 API 返回的图片过小（${bytes.byteLength} 字节），按失败处理`, 'network')
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new TransportError(`生图 API 返回的图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`, 'config')
    }
    return { mime: detectImageMime(bytes) ?? mime, base64 }
  }

  private async readImageBody(response: Response): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new TransportError(`下载的图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`, 'config')
    }
    if (response.body === null) return Buffer.alloc(0)
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new TransportError(`下载的图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`, 'config')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks)
  }

  private async download(url: string, signal: AbortSignal): Promise<ImageAsset> {
    let target: URL
    try {
      target = new URL(url, this.options.baseUrl)
    } catch {
      // Never echo the query string: signed URLs carry credentials in it.
      throw new TransportError(`生图 API 返回了非法图片地址：${redact(url.split('?')[0] ?? '')}`, 'config')
    }
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && (isLoopbackHost(target.hostname) || target.origin === this.origin()))) {
      throw new TransportError('生图 API 返回了非 https 的图片地址；只允许 https 或本机/同源地址', 'config')
    }
    // Only attach the credential to the configured origin; signed CDN URLs reject it.
    const sameOrigin = target.origin === this.origin()
    let response: Response
    try {
      response = await this.fetchImpl(target.toString(), {
        method: 'GET',
        headers: sameOrigin ? this.authHeaders() : { accept: 'image/*' },
        signal: this.signalFor(signal),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (!response.ok) throw new TransportError(`下载生成图片失败（HTTP ${response.status}）`, 'network')
    const bytes = await this.readImageBody(response)
    if (bytes.byteLength < MIN_IMAGE_BYTES) {
      throw new TransportError(`下载到的图片过小（${bytes.byteLength} 字节），按失败处理`, 'network')
    }
    const headerMime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const mime = detectImageMime(bytes) ?? (headerMime.startsWith('image/') ? headerMime : undefined)
    if (mime === undefined) {
      throw new TransportError('生图 API 返回的图片地址内容不是图片（无 magic bytes 且 content-type 非 image/*）', 'config')
    }
    return { mime, base64: bytes.toString('base64') }
  }

  private async referenceImages(files: readonly string[]): Promise<Reference[]> {
    if (this.options.editMode === 'off') return []
    const references: Reference[] = []
    for (const file of files) {
      if (references.length >= MAX_REFERENCES) break
      if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) continue
      let bytes: Buffer
      try {
        bytes = await readFile(file)
      } catch (error) {
        throw new TransportError(`读取参考图失败：${basename(file)}（${messageOf(error)}）`, 'upload')
      }
      if (bytes.byteLength > MAX_REFERENCE_BYTES) continue
      const mime = detectImageMime(bytes)
      // A .png that is not actually an image would only confuse the provider.
      if (mime === undefined) continue
      references.push({ name: basename(file), mime, bytes })
    }
    return references
  }

  private answerText(
    request: SubmitRequest,
    count: number,
    images: ImageAsset[],
    failures: readonly string[],
    prompts: readonly string[],
    references: readonly Reference[],
  ): string {
    const ignored = request.files.length - references.length
    const lines = [
      `# API 生图 · 第 ${request.round} 轮`,
      '',
      '- 通道：api（OpenAI 兼容生图接口）',
      `- 模型：${this.options.model}`,
      `- 尺寸：${this.options.size || 'auto'} · 质量：${this.options.quality || 'auto'} · 格式：${this.options.format}`,
      `- 结果：${images.length} 张 / 请求 ${count} 个方向`,
      references.length > 0 ? `- 参考图：${references.map(reference => reference.name).join('、')}（/images/edits）` : '- 参考图：无',
      ignored > 0 && this.options.editMode === 'off' ? `- 忽略材料：${ignored} 个（imageEdit=off）` : undefined,
      ignored > 0 && this.options.editMode !== 'off'
        ? `- 忽略材料：${ignored} 个（非图片、超过 25MB、扩展名不是 png/jpg/webp，或超出 4 张参考图上限；API 通道读不了文本材料）`
        : undefined,
      '',
      '## 提示词',
      '',
      ...prompts.flatMap((prompt, index) => [`### 方向 ${index + 1}`, '', prompt, '']),
      failures.length > 0 ? '## 失败' : undefined,
      failures.length > 0 ? '' : undefined,
      ...failures.map(failure => `- ${failure}`),
      failures.length > 0 ? '' : undefined,
      '## 说明',
      '',
      'API 通道只产出图片；HTML demo 需要网页会话通道，或由 DSH agent 基于这些图另行生成。',
      '',
    ]
    return lines.filter((line): line is string => line !== undefined).join('\n')
  }
}
