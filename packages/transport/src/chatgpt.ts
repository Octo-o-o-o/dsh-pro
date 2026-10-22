import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import type { PollResult, SubmitRequest, SubmitResult, Transport } from 'dsh-pro-core'
import { TransportError } from 'dsh-pro-core'
import { SELECTORS } from './selectors.ts'
import { advanceCompletion } from './completion.ts'

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
  private readonly submissions = new Map<string, Submission>()
  private readonly options: ChatGptTransportOptions

  constructor(options: ChatGptTransportOptions) {
    this.options = options
  }

  get appUrl(): string {
    return this.options.appUrl ?? 'https://chatgpt.com/'
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context !== undefined) return this.context
    await mkdir(this.options.profileDir, { recursive: true })
    const base = {
      headless: this.options.headless ?? false,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled'],
    }
    try {
      this.context = await chromium.launchPersistentContext(this.options.profileDir, { ...base, channel: 'chrome' })
    } catch (error) {
      throw new TransportError(
        `cannot launch Chrome with profile ${this.options.profileDir}; install Google Chrome or pass browser.headless=false plus a Playwright browser. ${error instanceof Error ? error.message : String(error)}`,
        'worker',
        { cause: error },
      )
    }
    return this.context
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
    const page = await context.newPage()
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

  async poll(request: { submissionId: string; timeoutMs: number; signal?: AbortSignal }): Promise<PollResult> {
    const submission = this.submissions.get(request.submissionId)
    if (submission === undefined) return { state: 'unknown' }
    if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
    const page = submission.page
    if (page.isClosed()) return { state: 'unknown' }

    const deadline = Date.now() + Math.max(1_000, request.timeoutMs)
    while (Date.now() < deadline) {
      if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
      if (page.isClosed()) return { state: 'unknown' }
      const streaming = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false)
      const text = streaming ? '' : await this.lastAssistantText(page)
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
  }

  async fetch(request: { submissionId: string }): Promise<{ answer: string; snapshotPath?: string }> {
    const submission = this.submissions.get(request.submissionId)
    if (submission === undefined) throw new TransportError('unknown submission', 'ui')
    if (submission.page.isClosed()) throw new TransportError('conversation page is closed', 'ui')
    const answer = await this.lastAssistantText(submission.page)
    if (answer === '') throw new TransportError('no assistant answer on the page', 'ui')
    return { answer }
  }

  async cancel(): Promise<void> {
    for (const submission of this.submissions.values()) {
      await submission.page.close().catch(() => undefined)
    }
    this.submissions.clear()
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
      const card = page.getByText(name, { exact: false }).first()
      try {
        await card.waitFor({ state: 'visible', timeout: 120_000 })
      } catch (error) {
        throw new TransportError(`attachment card missing for ${name}`, 'upload', { cause: error })
      }
    }
  }

  private async lastAssistantText(page: Page): Promise<string> {
    const messages = page.locator(SELECTORS.assistantMessage)
    const count = await messages.count().catch(() => 0)
    if (count === 0) return ''
    return (await messages.nth(count - 1).innerText().catch(() => '')).trim()
  }
}
