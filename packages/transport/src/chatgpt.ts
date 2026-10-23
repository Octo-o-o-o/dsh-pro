import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import type { CodeBlock, ImageAsset, PollResult, ReattachRequest, ReattachResult, SubmitRequest, SubmitResult, Transport } from 'dsh-pro-core'
import { TransportError } from 'dsh-pro-core'
import { SELECTORS } from './selectors.ts'
import { advanceCompletion } from './completion.ts'
import { parseDataUrlImage } from './assets.ts'

export interface ChatGptTransportOptions {
  profileDir: string
  headless?: boolean
  appUrl?: string
  loginTimeoutMs?: number
  /** Per-poll wait; the engine decides when the round as a whole is too old. */
  pollSliceMs?: number
}

interface Submission {
  page: Page
  request: SubmitRequest
  startedAt: number
  lastText: string
  stable: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function briefMarker(brief: string): string {
  return brief
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

function extensionFor(mime: string): string {  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('svg')) return 'svg'
  return 'png'
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

async function firstVisible(page: Page, selector: string, timeoutMs: number): Promise<Locator | undefined> {
  const locator = page.locator(selector).first()
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
    return locator
  } catch {
    return undefined
  }
}

/**
 * Drives one persistent, isolated Chrome profile against chatgpt.com.
 *
 * The class is deliberately single-flight: one page per submission, and the
 * engine queues topics, so two runs never share the composer. All failures
 * are mapped to {@link TransportError} families the engine understands.
 */
export class ChatGptWebTransport implements Transport {
  private context?: BrowserContext
  private launching?: Promise<BrowserContext>
  private readonly submissions = new Map<string, Submission>()
  /** One visible tab per topic so later rounds update the same conversation. */
  private readonly topicPages = new Map<string, Page>()
  private readonly options: ChatGptTransportOptions

  constructor(options: ChatGptTransportOptions) {
    this.options = options
  }

  get appUrl(): string {
    return this.options.appUrl ?? 'https://chatgpt.com/'
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context !== undefined) return this.context
    if (this.launching !== undefined) return this.launching
    this.launching = this.launchContext()
    try {
      return await this.launching
    } finally {
      this.launching = undefined
    }
  }

  private async launchContext(): Promise<BrowserContext> {
    await mkdir(this.options.profileDir, { recursive: true })
    const base = {
      headless: this.options.headless ?? false,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled'],
    }
    try {
      const context = await chromium.launchPersistentContext(this.options.profileDir, { ...base, channel: 'chrome' })
      context.on('close', () => {
        if (this.context === context) this.context = undefined
      })
      this.context = context
      return context
    } catch (error) {
      throw new TransportError(
        `cannot launch Chrome with profile ${this.options.profileDir}; install Google Chrome or pass browser.headless=false plus a Playwright browser. ${error instanceof Error ? error.message : String(error)}`,
        'worker',
        { cause: error },
      )
    }
  }

  async probe(): Promise<{ ok: boolean; loggedIn: boolean; model: string; available: string[] }> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    try {
      await page.goto(this.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const composer = await firstVisible(page, SELECTORS.composer, 20_000)
      if (composer === undefined) {
        const login = await firstVisible(page, SELECTORS.loginLink, 2_000)
        return { ok: false, loggedIn: login === undefined ? false : true, model: '', available: [] }
      }
      const model = await this.readModel(page)
      return { ok: true, loggedIn: true, model, available: model === '' ? [] : [model] }
    } catch (error) {
      throw new TransportError(`probe failed: ${error instanceof Error ? error.message : String(error)}`, 'network', { cause: error })
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  /** Interactive first login: opens the window and waits for the composer. */
  async login(timeoutMs = this.options.loginTimeoutMs ?? 300_000): Promise<{ ok: boolean }> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    await page.goto(this.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const composer = await firstVisible(page, SELECTORS.composer, timeoutMs)
    if (composer === undefined) {
      throw new TransportError('login was not completed before the timeout', 'login')
    }
    await page.close()
    return { ok: true }
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const context = await this.ensureContext()
    const existing = this.topicPages.get(request.topicId)
    const page = existing !== undefined && !existing.isClosed() ? existing : await context.newPage()
    this.topicPages.set(request.topicId, page)
    try {
      const target = request.session?.conversationUrl ?? this.appUrl
      let reused = request.session?.conversationUrl !== undefined
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      let composer = await firstVisible(page, SELECTORS.composer, 30_000)
      if (composer === undefined && reused) {
        // The stored conversation is gone (deleted/another account): start a
        // fresh chat; the engine's fallback material list keeps the round whole.
        reused = false
        await page.goto(this.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        composer = await firstVisible(page, SELECTORS.composer, 30_000)
      }
      if (composer === undefined) throw new TransportError('composer not found; the session is probably logged out', 'login')

      await this.trySelectModel(page, request.model)

      const attachmentsToSend = reused ? request.files : (request.fallbackFiles ?? request.files)
      if (attachmentsToSend.length > 0) {
        const input = page.locator(SELECTORS.fileInput).first()
        try {
          await input.setInputFiles(attachmentsToSend, { timeout: 60_000 })
        } catch (error) {
          throw new TransportError(`cannot attach materials: ${error instanceof Error ? error.message : String(error)}`, 'upload', { cause: error })
        }
        await this.waitForAttachmentCards(page, attachmentsToSend)
      }

      await composer.fill(request.brief)
      const send = await firstVisible(page, SELECTORS.sendButton, 15_000)
      if (send === undefined) {
        const composerText = await composer.innerText().catch(() => '')
        console.error('SEND_DEBUG', JSON.stringify({ url: page.url(), composerText }))
        throw new TransportError(`send button not found (composer ${composerText.length} chars)`, 'ui')
      }
      await send.click()

      // A new chat first gets a local id and only later the server-assigned
      // /c/<uuid> URL. Persist the addressable one, otherwise follow-ups
      // cannot reopen the thread.
      const conversationUrl = await this.waitForConversationUrl(page, 20_000)
      const attachments = attachmentsToSend.map(file => file.split(/[\\/]/).pop() ?? file)
      const submissionId = randomUUID()
      const fingerprint = sha256(`${conversationUrl}\n${request.brief}\n${attachments.join('\n')}`)
      this.submissions.set(submissionId, {
        page,
        request,
        startedAt: Date.now(),
        lastText: '',
        stable: 0,
      })
      return { submissionId, fingerprint, attachments, conversationUrl }
    } catch (error) {
      await page.close().catch(() => undefined)
      if (error instanceof TransportError) throw error
      throw new TransportError(`submit failed: ${error instanceof Error ? error.message : String(error)}`, 'network', { cause: error })
    }
  }

  /**
   * Adopt an already-sent round after a restart. The prompt text is the proof:
   * if it is not in the stored conversation, this round was never submitted.
   */
  async reattach(request: ReattachRequest): Promise<ReattachResult> {
    const context = await this.ensureContext()
    const existing = this.topicPages.get(request.topicId)
    const page = existing !== undefined && !existing.isClosed() ? existing : await context.newPage()
    this.topicPages.set(request.topicId, page)
    try {
      await page.goto(request.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const composer = await firstVisible(page, SELECTORS.composer, 30_000)
      if (composer === undefined) return { attached: false }
      const marker = briefMarker(request.brief)
      if (marker === '') return { attached: false }
      const found = await page.evaluate(text => (document.body.innerText ?? '').includes(text), marker)
      if (!found) return { attached: false }
      const submissionId = randomUUID()
      this.submissions.set(submissionId, {
        page,
        request: {
          topicId: request.topicId,
          round: request.round,
          brief: request.brief,
          files: [],
          model: '',
          session: { conversationUrl: request.conversationUrl, profileDir: this.options.profileDir },
        },
        startedAt: Date.now(),
        lastText: '',
        stable: 0,
      })
      return { attached: true, submissionId }
    } catch (error) {
      throw new TransportError(
        `reattach failed: ${error instanceof Error ? error.message : String(error)}`,
        'network',
        { cause: error },
      )
    }
  }

  async poll(request: { submissionId: string; timeoutMs: number; signal?: AbortSignal }): Promise<PollResult> {
    const submission = this.submissions.get(request.submissionId)
    if (submission === undefined) return { state: 'unknown' }
    if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
    const page = submission.page
    if (page.isClosed()) return { state: 'unknown' }

    const deadline = Date.now() + Math.max(1_000, request.timeoutMs)
    try {
      while (Date.now() < deadline) {
        if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
        if (page.isClosed()) return { state: 'unknown' }
        const streaming = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false)
        const text = streaming ? '' : await this.richAnswerText(page)
        const next = advanceCompletion(
          { lastText: submission.lastText, stable: submission.stable },
          text,
          streaming,
        )
        submission.lastText = next.lastText
        submission.stable = next.stable
        if (next.answered) return { state: 'answered', answer: next.lastText }
        await page.waitForTimeout(3_000)
      }
      return { state: 'waiting' }
    } catch (error) {
      if (isAborted(request.signal)) throw error
      if (page.isClosed()) return { state: 'unknown' }
      if (error instanceof TransportError) throw error
      throw new TransportError(
        `poll failed: ${error instanceof Error ? error.message : String(error)}`,
        'network',
        { cause: error },
      )
    }
  }

  async fetch(request: { submissionId: string }): Promise<{ answer: string; snapshotPath?: string }> {
    const submission = this.submissions.get(request.submissionId)
    if (submission === undefined) throw new TransportError('unknown submission', 'ui')
    if (submission.page.isClosed()) throw new TransportError('conversation page is closed', 'ui')
    const page = submission.page
    const answer = await this.lastAssistantText(page)
    const images = await this.collectImages(page)
    const codeBlocks = await this.collectCodeBlocks(page)
    if (answer === '' && images.length === 0 && codeBlocks.length === 0) {
      throw new TransportError('no assistant answer on the page', 'ui')
    }
    return {
      answer,
      ...(images.length > 0 ? { images } : {}),
      ...(codeBlocks.length > 0 ? { codeBlocks } : {}),
    }
  }

  /** Large images in the answer; blob URLs are read in-page, https through cookies. */
  private async collectImages(page: Page): Promise<ImageAsset[]> {
    const sources: string[] = await page.evaluate(() => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const image of document.querySelectorAll('main img')) {
        const element = image as HTMLImageElement
        if (element.naturalWidth < 300 || element.naturalHeight < 300) continue
        if (element.src !== '' && !seen.has(element.src)) {
          seen.add(element.src)
          out.push(element.src)
        }
      }
      return out
    })
    const images: ImageAsset[] = []
    for (const [index, source] of sources.slice(0, 8).entries()) {
      try {
        if (source.startsWith('data:')) {
          const parsed = parseDataUrlImage(source)
          if (parsed === undefined) continue
          // Tiny data URLs are page chrome/file thumbnails, not generated art.
          if (Buffer.from(parsed.base64, 'base64').byteLength < 20_000) continue
          images.push({
            name: `image-${String(index + 1).padStart(2, '0')}.${extensionFor(parsed.mime)}`,
            mime: parsed.mime,
            base64: parsed.base64,
          })
          continue
        }
        if (source.startsWith('blob:')) {
          const dataUrl = await page.evaluate(async (src) => {
            const response = await fetch(src)
            const blob = await response.blob()
            return await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result))
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(blob)
            })
          }, source)
          const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
          if (match === null) continue
          const mime = match[1] as string
          images.push({
            name: `image-${String(index + 1).padStart(2, '0')}.${extensionFor(mime)}`,
            mime,
            base64: (match[2] as string).replace(/\s/g, ''),
          })
        } else {
          const response = await page.request.get(source)
          if (!response.ok()) continue
          const mime = (response.headers()['content-type'] ?? 'image/png').split(';')[0]?.trim() ?? 'image/png'
          images.push({
            name: `image-${String(index + 1).padStart(2, '0')}.${extensionFor(mime)}`,
            mime,
            base64: (await response.body()).toString('base64'),
          })
        }
      } catch {
        // One unreadable image must not fail the whole round.
      }
    }
    return images
  }

  private async collectCodeBlocks(page: Page): Promise<CodeBlock[]> {
    return await page.evaluate(() => [...document.querySelectorAll('main pre code')]
      .slice(0, 20)
      .map(code => ({
        language: /language-([\w-]+)/.exec(code.className)?.[1] ?? '',
        text: code.textContent ?? '',
      }))
      .filter(block => block.text.trim() !== ''))
  }

  async cancel(): Promise<void> {
    const pages = new Set<Page>([
      ...[...this.submissions.values()].map(submission => submission.page),
      ...this.topicPages.values(),
    ])
    for (const page of pages) {
      await page.close().catch(() => undefined)
    }
    this.submissions.clear()
    this.topicPages.clear()
  }

  async close(): Promise<void> {
    await this.cancel()
    await this.context?.close().catch(() => undefined)
    this.context = undefined
  }

  private async waitForConversationUrl(page: Page, timeoutMs: number): Promise<string> {
    const pattern = /^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const url = page.url()
      if (pattern.test(url)) return url
      await page.waitForTimeout(500)
    }
    return page.url()
  }

  private async readModel(page: Page): Promise<string> {
    const picker = await firstVisible(page, SELECTORS.modelPicker, 2_000)
    if (picker === undefined) return ''
    return (await picker.innerText().catch(() => '')).trim()
  }

  private async trySelectModel(page: Page, model: string): Promise<void> {
    const picker = await firstVisible(page, SELECTORS.modelPicker, 2_000)
    if (picker === undefined) return
    const wanted = model.trim()
    if (wanted === '') return
    // The live picker lists menu items by display name (Pro, GPT-6, ...);
    // "thinking" is an effort on the same picker, so it accepts Pro.
    const pattern = /^thinking$/i.test(wanted) ? /pro|思考|thinking/i : new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    try {
      await picker.click()
      const option = page.getByRole('menuitem').filter({ hasText: pattern }).first()
      await option.waitFor({ state: 'visible', timeout: 3_000 })
      await option.click()
    } catch {
      await page.keyboard.press('Escape').catch(() => undefined)
    }
  }

  private async waitForAttachmentCards(page: Page, files: string[]): Promise<void> {
    for (const file of files) {
      const name = file.split(/[\\/]/).pop() ?? file
      // ChatGPT may append "(2)" before the extension on a name collision, so
      // match the stem inside the composer rather than the exact filename.
      const stem = name.replace(/\.[^.]+$/, '')
      const needle = stem.length >= 3 ? stem : name
      const card = page.locator('form').getByText(needle, { exact: false }).first()
      try {
        await card.waitFor({ state: 'visible', timeout: 120_000 })
      } catch (error) {
        throw new TransportError(`attachment card missing for ${name}`, 'upload', { cause: error })
      }
    }
  }

  private async richAnswerText(page: Page): Promise<string> {
    const text = await this.lastAssistantText(page)
    if (text !== '') return text
    // Image-only answers have no text; use a short count/dimension fingerprint
    // (never the base64 payload) so a gallery response still completes.
    const images: string[] = await page.evaluate(() => [...document.querySelectorAll('main img')]
      .filter(image => (image as HTMLImageElement).naturalWidth >= 300)
      .map(image => `${(image as HTMLImageElement).naturalWidth}x${(image as HTMLImageElement).naturalHeight}`))
    return images.length > 0 ? `image:${images.length}:${images.join(',')}` : ''
  }

  private async lastAssistantText(page: Page): Promise<string> {
    const messages = page.locator(SELECTORS.assistantMessage)
    const count = await messages.count().catch(() => 0)
    if (count === 0) return ''
    return (await messages.nth(count - 1).innerText().catch(() => '')).trim()
  }
}
