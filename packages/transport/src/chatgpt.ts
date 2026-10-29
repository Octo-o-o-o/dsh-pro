import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import type { ArchiveAsset, CodeBlock, FetchedAnswer, ImageAsset, PollResult, ReattachRequest, ReattachResult, SubmitRequest, SubmitResult, Transport } from 'dsh-pro-core'
import { isTransportError, TransportError } from 'dsh-pro-core'
import { SELECTORS } from './selectors.ts'
import { advanceCompletion } from './completion.ts'
import { detectImageMime, MAX_IMAGE_ASSET_BYTES, parseDataUrlImage } from './assets.ts'
import { SerialGate } from './serialize.ts'
import { firstVisible, readTurnState, readUserTurns } from './page-state.ts'

/**
 * The web channel drives the installed Google Chrome only. There is no Edge or
 * bundled-Chromium fallback: a single browser keeps one account and one profile
 * across both plugins.
 */
const CHROME_CHANNEL = 'chrome'

export interface ChatGptTransportOptions {
  profileDir: string
  headless?: boolean
  appUrl?: string
  loginTimeoutMs?: number
  /** Per-poll wait; the engine decides when the round as a whole is too old. */
  pollSliceMs?: number
  /** Bounded wait for a prior response to finish before preparing a follow-up. */
  readyTimeoutMs?: number
}

interface Submission {
  page: Page
  request: SubmitRequest
  startedAt: number
  lastText: string
  stable: number
  /** Assistant turns already on the page before this submission was clicked. */
  assistantBaseline: number
  /** User turns already on the page before this submission was clicked. */
  userBaseline: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalizePrompt(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function briefMarkers(brief: string): string[] {
  const text = normalizePrompt(brief)
  if (text === '') return []
  const sentences = text
    .split(/[。！？!?；;\n]/)
    .map(item => item.trim())
    .filter(item => item.length >= 8)
  const candidates = [...new Set([...sentences, text])]
    .sort((left, right) => right.length - left.length)
    .map(item => item.slice(0, 80))
  return candidates.slice(0, 3)
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
  /**
   * Serializes submit/reattach across every engine that shares this transport
   * (both plugins, every project root). Poll/fetch/cancel stay concurrent.
   * The worst-case wait behind one submit is bounded by its own timeouts.
   */
  private readonly gate = new SerialGate()

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
      acceptDownloads: true,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled'],
    }
    try {
      const context = await chromium.launchPersistentContext(this.options.profileDir, { ...base, channel: CHROME_CHANNEL })
      context.on('close', () => {
        if (this.context === context) this.context = undefined
      })
      this.context = context
      return context
    } catch (error) {
      throw new TransportError(
        `cannot launch Google Chrome with profile ${this.options.profileDir}; install Google Chrome (the web channel has no Edge/Chromium fallback). ${error instanceof Error ? error.message : String(error)}`,
        'worker',
        { cause: error },
      )
    }
  }

  async probe(): Promise<{ ok: boolean; loggedIn: boolean; model: string; available: string[]; reason?: string }> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    try {
      await page.goto(this.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const composer = await firstVisible(page, SELECTORS.composer, 20_000)
      if (composer === undefined) {
        // A visible login link proves the opposite of a session: reporting it
        // as loggedIn=true made the panel show "check failed · logged in".
        const login = await firstVisible(page, SELECTORS.loginLink, 2_000)
        return {
          ok: false,
          loggedIn: false,
          model: '',
          available: [],
          reason: login === undefined
            ? 'composer not found; the page may still be loading or its UI changed'
            : 'not logged in: the ChatGPT login link is visible',
        }
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

  /** Wait until the message list stops growing (old history may load after DOM ready). */
  private async settleMessages(page: Page): Promise<void> {
    let previous = -1
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const count = await page.locator(SELECTORS.assistantMessage).count().catch(() => 0)
      if (count === previous) return
      previous = count
      await page.waitForTimeout(300)
    }
  }

  /**
   * A submit is only accepted when something new appeared after the click:
   * preferably a new user turn matching the brief, otherwise a new assistant
   * turn (some DOM versions hide the user role). This is what prevents the
   * previous answer from being mistaken for the current round.
   */
  private async waitForNewTurn(
    page: Page,
    userBaseline: number,
    assistantBaseline: number,
    brief: string,
    timeoutMs = 60_000,
  ): Promise<boolean> {
    const markers = briefMarkers(brief)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const users = await readUserTurns(page)
      const userCount = users.length
      if (userCount > userBaseline) {
        const text = normalizePrompt(users[userCount - 1] ?? '')
        if (markers.length === 0 || markers.some(marker => text.includes(marker))) return true
      }
      const assistantCount = await page.locator(SELECTORS.assistantMessage).count().catch(() => 0)
      if (assistantCount > assistantBaseline) return true
      await page.waitForTimeout(500)
    }
    return false
  }

  /**
   * For a cold reattach: locate the user turn that matches this round and count
   * the assistant nodes that precede it. The after-turn assistant (if already
   * present) is included by poll/fetch, bounded by the next user turn.
   * An ambiguous prompt match (shared boilerplate across rounds) is
   * refused rather than guessed.
   */
  private async baselinesForPrompt(page: Page, brief: string): Promise<{ assistantBaseline: number; userBaseline: number } | undefined> {
    const markers = briefMarkers(brief)
    if (markers.length === 0) return undefined
    const result = await page.evaluate(({ userSelector, assistantSelector, markers }) => {
      const userNodes = [...document.querySelectorAll(userSelector)] as HTMLElement[]
      const users = userNodes.filter(node => !userNodes.some(parent => parent !== node && parent.contains(node)))
      const matches = users.filter(node => {
        // The sent prompt is Markdown source, while markers ignore formatting
        // and whitespace. Normalize both sides before matching a saved round.
        const text = (node.textContent ?? '').replace(/```[\s\S]*?```/g, ' ')
          .replace(/[#>*_`|~]/g, ' ').replace(/\s+/g, ' ').trim()
        return markers.some(marker => text.includes(marker))
      })
      if (matches.length !== 1) return undefined
      const target = matches[0] as HTMLElement
      // 4 = Node.DOCUMENT_POSITION_FOLLOWING: target follows the node.
      const assistants = [...document.querySelectorAll(assistantSelector)] as HTMLElement[]
      return {
        assistant: assistants.filter(node => (node.compareDocumentPosition(target) & 4) !== 0).length,
        user: users.indexOf(target),
      }
    }, { userSelector: SELECTORS.userMessage, assistantSelector: SELECTORS.assistantMessage, markers })
    return result === undefined
      ? undefined
      : { assistantBaseline: result.assistant, userBaseline: result.user }
  }

  async submit(request: SubmitRequest): Promise<SubmitResult> {
    if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
    return await this.gate.exec(() => this.submitNow(request))
  }

  private async submitNow(request: SubmitRequest): Promise<SubmitResult> {
    // Before the click, cancellation is clean: no message exists yet. After the
    // click we deliberately finish the submission record instead, so the
    // engine can cancel the real submission instead of losing track of it.
    if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
    let page: Page | undefined
    let sendAttempted = false
    try {
      const context = await this.ensureContext()
      const existing = this.topicPages.get(request.topicId)
      page = existing !== undefined && !existing.isClosed() ? existing : await context.newPage()
      this.topicPages.set(request.topicId, page)
      const target = request.session?.conversationUrl ?? this.appUrl
      let reused = request.session?.conversationUrl !== undefined
      // Reopening the same live conversation can interrupt a still-running
      // response and erase the very state we need to inspect.
      if (page.url() !== target) await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      let composer = await firstVisible(page, SELECTORS.composer, 30_000)
      if (composer === undefined && reused) {
        // The stored conversation is gone (deleted/another account): start a
        // fresh chat; the engine's fallback material list keeps the round whole.
        reused = false
        await page.goto(this.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        composer = await firstVisible(page, SELECTORS.composer, 30_000)
      }
      if (composer === undefined) throw new TransportError('composer not found; the session is probably logged out', 'login')

      await this.settleMessages(page)
      await this.waitForReady(page, request.signal)
      const assistantBaseline = await page.locator(SELECTORS.assistantMessage).count().catch(() => 0)
      const userBaseline = (await readUserTurns(page)).length

      if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
      const model = await this.selectModel(page, request.model)

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

      if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
      await composer.fill(request.brief)
      const send = await firstVisible(page, SELECTORS.sendButton, 15_000)
      if (send === undefined) {
        const composerText = await composer.inputValue().catch(() => composer!.innerText()).catch(() => '')
        const state = await readTurnState(page, assistantBaseline)
        // Debug output is opt-in and carries sizes only — never the brief text.
        if (process.env.DSH_PRO_DEBUG === '1') {
          console.error('dsh-pro: send button not found', JSON.stringify({ composerChars: composerText.length, streaming: state.streaming }))
        }
        throw new TransportError(`send button not found (composer ${composerText.length} chars; streaming=${state.streaming}); message was not sent; browser kept open for inspection`, 'ui')
      }
      // File cards only prove selection. Wait for the site to permit sending
      // before marking this as a potentially dispatched click.
      const enabledDeadline = Date.now() + 120_000
      while (!await send.isEnabled()) {
        if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
        if (Date.now() >= enabledDeadline) {
          throw new TransportError('send button stayed disabled; attachments or the page may still be processing; message was not sent', attachmentsToSend.length > 0 ? 'upload' : 'ui')
        }
        await page.waitForTimeout(250)
      }
      if ((await readTurnState(page, assistantBaseline)).streaming) {
        throw new TransportError('previous response is still generating; follow-up was not sent', 'ui')
      }
      // Last point where cancellation can prevent a send.
      if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
      sendAttempted = true
      await send.click()

      // A new chat first gets a local id and only later the server-assigned
      // /c/<uuid> URL. Persist the addressable one, otherwise follow-ups
      // cannot reopen the thread.
      const conversationUrl = await this.waitForConversationUrl(page, 20_000)
      const newTurn = await this.waitForNewTurn(page, userBaseline, assistantBaseline, request.brief)
      if (!newTurn) {
        throw new TransportError('send did not produce a new user/assistant turn; the click may not have been accepted', 'ui')
      }
      const attachments = attachmentsToSend.map(file => file.split(/[\\/]/).pop() ?? file)
      const submissionId = randomUUID()
      const fingerprint = sha256(`${conversationUrl}\n${request.brief}\n${attachments.join('\n')}`)
      this.submissions.set(submissionId, {
        page,
        request,
        startedAt: Date.now(),
        lastText: '',
        stable: 0,
        assistantBaseline,
        userBaseline,
      })
      return { submissionId, fingerprint, attachments, conversationUrl, model }
    } catch (error) {
      // Keep the cancellation signal intact: wrapping an AbortError as a
      // network failure would park the topic as stalled instead of cancelled.
      if (error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted')) {
        await page?.close().catch(() => undefined)
        throw error
      }
      // Preserve the tab/draft on failure so human verification remains possible.
      throw new TransportError(
        isTransportError(error) ? error.message : `submit failed: ${error instanceof Error ? error.message : String(error)}`,
        isTransportError(error) ? error.failure : 'network',
        { cause: error, submissionState: sendAttempted ? 'unknown' : 'not_sent' },
      )
    }
  }

  /**
   * Adopt an already-sent round after a restart. The prompt text is the proof:
   * if it is not in the stored conversation, this round was never submitted.
   */
  async reattach(request: ReattachRequest): Promise<ReattachResult> {
    return await this.gate.exec(() => this.reattachNow(request))
  }

  private async reattachNow(request: ReattachRequest): Promise<ReattachResult> {
    const context = await this.ensureContext()
    const existing = this.topicPages.get(request.topicId)
    const page = existing !== undefined && !existing.isClosed() ? existing : await context.newPage()
    this.topicPages.set(request.topicId, page)
    try {
      if (page.url() !== request.conversationUrl) await page.goto(request.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      const composer = await firstVisible(page, SELECTORS.composer, 30_000)
      if (composer === undefined) return { attached: false }
      await this.settleMessages(page)
      const baselines = await this.baselinesForPrompt(page, request.brief)
      if (baselines === undefined) return { attached: false }
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
        assistantBaseline: baselines.assistantBaseline,
        userBaseline: baselines.userBaseline,
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
    let progressed = false
    let diagnostic = ''
    try {
      while (Date.now() < deadline) {
        if (isAborted(request.signal)) throw new DOMException('aborted', 'AbortError')
        if (page.isClosed()) return { state: 'unknown' }
        const state = await readTurnState(page, submission.assistantBaseline, submission.userBaseline)
        diagnostic = `assistantBlocks=${state.assistantCount - submission.assistantBaseline}; answerChars=${state.text.length}; streaming=${state.streaming}; terminal=${state.terminal}`
        const streaming = state.streaming
        if (streaming) progressed = true
        const text = streaming ? '' : state.text || await this.richAnswerText(page, submission.assistantBaseline, state.messageIndex)
        const next = advanceCompletion(
          { lastText: submission.lastText, stable: submission.stable },
          text,
          streaming,
        )
        if (next.lastText !== submission.lastText) progressed = true
        submission.lastText = next.lastText
        submission.stable = next.stable
        if (next.answered && state.terminal) {
          return { state: 'answered', answer: next.lastText }
        }
        await page.waitForTimeout(3_000)
      }
      return { state: 'waiting', diagnostic, ...(progressed ? { progress: true } : {}) }
    } catch (error) {
      if (isAborted(request.signal)) throw error
      if (page.isClosed()) return { state: 'unknown' }
      if (isTransportError(error)) throw error
      throw new TransportError(
        `poll failed: ${error instanceof Error ? error.message : String(error)}`,
        'network',
        { cause: error },
      )
    }
  }

  async fetch(request: { submissionId: string }): Promise<FetchedAnswer> {
    const submission = this.submissions.get(request.submissionId)
    if (submission === undefined) throw new TransportError('unknown submission', 'ui')
    if (submission.page.isClosed()) throw new TransportError('conversation page is closed', 'ui')
    const page = submission.page
    const state = await readTurnState(page, submission.assistantBaseline, submission.userBaseline)
    if (!state.terminal) throw new TransportError('answer completion is not confirmed; keep waiting for this turn to finish', 'ui', { answerIncomplete: true })
    const answer = state.text
    const images = await this.collectImages(page, submission.assistantBaseline, state.messageIndex)
    const codeBlocks = await this.collectCodeBlocks(page, submission.assistantBaseline, state.messageIndex)
    const archives = await this.collectArchives(page, submission.assistantBaseline, state.messageIndex)
    if (answer === '' && images.length === 0 && codeBlocks.length === 0 && archives.length === 0) {
      throw new TransportError('no new assistant answer for this round', 'ui')
    }
    // Keep the submission until the round is persisted: a failed artifact
    // write makes the engine re-read this answer on resume, and dropping the
    // reference here would turn that recovery into "page state is unknown".
    return {
      answer,
      ...(images.length > 0 ? { images } : {}),
      ...(codeBlocks.length > 0 ? { codeBlocks } : {}),
      ...(archives.length > 0 ? { archives } : {}),
    }
  }

  /** Large images in the answer; blob URLs are read in-page, https through cookies. */
  private async collectImages(page: Page, baseline: number, messageIndex: number): Promise<ImageAsset[]> {
    const sources: string[] = await page.evaluate(({ selector, turnSelector, userSelector, baseline, messageIndex }) => {
      const seen = new Set<string>()
      const out: string[] = []
      const messages = [...document.querySelectorAll(selector)]
      if (messages.length <= baseline) return out
      const last = messages[messageIndex]
      const root = last?.closest(turnSelector) ?? last
      if (root === null || root === undefined) return out
      for (const image of root.querySelectorAll('img')) {
        const element = image as HTMLImageElement
        if (element.naturalWidth < 300 || element.naturalHeight < 300) continue
        if (element.closest('form') !== null || element.closest(userSelector) !== null) continue
        if (element.src !== '' && !seen.has(element.src)) {
          seen.add(element.src)
          out.push(element.src)
        }
      }
      return out
    }, { selector: SELECTORS.assistantMessage, turnSelector: SELECTORS.turn, userSelector: SELECTORS.userMessage, baseline, messageIndex })
    const images: ImageAsset[] = []
    for (const [index, source] of sources.slice(0, 8).entries()) {
      try {
        if (source.startsWith('data:')) {
          const parsed = parseDataUrlImage(source)
          if (parsed === undefined) continue
          // Tiny data URLs are page chrome/file thumbnails, not generated art;
          // an upper bound keeps a hostile payload out of host memory.
          const bytes = Buffer.from(parsed.base64, 'base64')
          if (bytes.byteLength < 20_000 || bytes.byteLength > MAX_IMAGE_ASSET_BYTES) continue
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
            if (blob.size > 50 * 1024 * 1024) return ''
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
          const base64 = (match[2] as string).replace(/\s/g, '')
          if (Buffer.from(base64, 'base64').byteLength > MAX_IMAGE_ASSET_BYTES) continue
          images.push({
            name: `image-${String(index + 1).padStart(2, '0')}.${extensionFor(mime)}`,
            mime,
            base64,
          })
        } else {
          // Playwright cannot stream a response body, so the size contract is:
          // pre-check content-length, verify after body() lands.
          const response = await page.request.get(source)
          if (!response.ok()) continue
          const declared = Number(response.headers()['content-length'] ?? '')
          if (Number.isFinite(declared) && declared > MAX_IMAGE_ASSET_BYTES) continue
          const bytes = await response.body()
          if (bytes.byteLength > MAX_IMAGE_ASSET_BYTES || bytes.byteLength < 1_024) continue
          const headerMime = (response.headers()['content-type'] ?? '').split(';')[0]?.trim() ?? ''
          const mime = detectImageMime(bytes) ?? (headerMime.startsWith('image/') ? headerMime : undefined)
          if (mime === undefined) continue
          images.push({
            name: `image-${String(index + 1).padStart(2, '0')}.${extensionFor(mime)}`,
            mime,
            base64: bytes.toString('base64'),
          })
        }
      } catch {
        // One unreadable image must not fail the whole round.
      }
    }
    return images
  }

  private async collectCodeBlocks(page: Page, baseline: number, messageIndex: number): Promise<CodeBlock[]> {
    return await page.evaluate(({ selector, turnSelector, userSelector, baseline, messageIndex }) => {
      const messages = [...document.querySelectorAll(selector)]
      if (messages.length <= baseline) return []
      const last = messages[messageIndex]
      const root = last?.closest(turnSelector) ?? last
      if (root === null || root === undefined) return []
      const filePattern = /([\w.-]+\.(?:html?|css|jsx?|tsx?|json|md|py|vue|svelte|sh|ya?ml))/i
      const nameOf = (code: HTMLElement): string => {
        const pre = code.closest('pre')
        const header = pre?.parentElement
        const candidates = [
          code.getAttribute('data-filename'),
          code.getAttribute('data-file-name'),
          pre?.getAttribute('data-filename'),
          pre?.getAttribute('data-file-name'),
          pre?.getAttribute('title'),
          header?.querySelector('[data-filename], [data-file-name], [class*="filename" i]')?.textContent ?? '',
          (pre?.previousElementSibling?.textContent ?? '').trim(),
          (code.textContent ?? '').split('\n')[0] ?? '',
        ]
        for (const candidate of candidates) {
          if (candidate == null || candidate === '') continue
          const match = filePattern.exec(candidate)
          if (match !== null) return match[1] ?? ''
        }
        return ''
      }
      return [...root.querySelectorAll('pre code')]
        .filter(code => code.closest('form') === null && code.closest(userSelector) === null)
        .slice(0, 20)
        .map(code => ({
          language: /language-([\w-]+)/.exec(code.className)?.[1] ?? '',
          name: nameOf(code as HTMLElement),
          text: code.textContent ?? '',
        }))
        .filter(block => block.text.trim() !== '')
    }, { selector: SELECTORS.assistantMessage, turnSelector: SELECTORS.turn, userSelector: SELECTORS.userMessage, baseline, messageIndex })
  }

  /** Download zip links rendered in the assistant answer (code interpreter downloads). */
  private async collectArchives(page: Page, baseline: number, messageIndex: number): Promise<ArchiveAsset[]> {
    const links = await page.evaluate(({ selector, turnSelector, userSelector, baseline, messageIndex }) => {
      const messages = [...document.querySelectorAll(selector)]
      if (messages.length <= baseline) return []
      const last = messages[messageIndex]
      const root = last?.closest(turnSelector) ?? last
      if (root === null || root === undefined) return []
      const controls = [...root.querySelectorAll('a[href], button, [role="button"]')]
        .filter(element => element.closest('form') === null && element.closest(userSelector) === null)
      const picked: Array<{ href: string; label: string; marker: string; local: boolean }> = []
      for (const control of controls) {
        const element = control as HTMLElement & { href?: string }
        const href = element instanceof HTMLAnchorElement ? element.href : ''
        const label = (element.getAttribute('download') ?? element.textContent ?? '').trim()
        const context = (element.closest('div, li, article')?.textContent ?? '').slice(0, 300)
        const downloadable = label.toLowerCase().includes('.zip')
          || href.toLowerCase().includes('.zip')
          || (/download|下载|zip/i.test(label) && context.toLowerCase().includes('.zip'))
        if (!downloadable) continue
        const marker = `[data-dsh-zip="${picked.length}"]`
        element.setAttribute('data-dsh-zip', String(picked.length))
        picked.push({
          href,
          label,
          marker,
          local: href === '' || !/^(?:https?|blob|data):/i.test(href),
        })
        if (picked.length >= 3) break
      }
      return picked
    }, { selector: SELECTORS.assistantMessage, turnSelector: SELECTORS.turn, userSelector: SELECTORS.userMessage, baseline, messageIndex })
    const archives: ArchiveAsset[] = []
    for (const link of links) {
      try {
        let encoded = ''
        let name = (link.label !== '' ? link.label : link.href.split('/').pop() ?? 'archive.zip').replace(/[^\w.-]/g, '_')
        if (link.local) {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 10_000 }),
            page.locator(link.marker).click(),
          ])
          const temp = await download.path()
          if (temp === null) throw new Error('download had no local file')
          const bytes = await readFile(temp)
          if (bytes.length > 50 * 1024 * 1024) throw new Error('zip is larger than 50 MB')
          encoded = bytes.toString('base64')
          name = download.suggestedFilename().replace(/[^\w.-]/g, '_')
        } else {
          encoded = await page.evaluate(async href => {
            const response = await fetch(href)
            if (!response.ok) throw new Error(`zip download failed: ${response.status}`)
            const bytes = new Uint8Array(await response.arrayBuffer())
            if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('zip is larger than 50 MB')
            let binary = ''
            for (let index = 0; index < bytes.length; index += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
            }
            return btoa(binary)
          }, link.href)
        }
        archives.push({ name: name.endsWith('.zip') ? name : `${name}.zip`, base64: String(encoded) })
      } catch {
        // A dead/private download link must not fail the whole answer.
      }
    }
    await page.evaluate(() => document.querySelectorAll('[data-dsh-zip]').forEach(node => node.removeAttribute('data-dsh-zip'))).catch(() => undefined)
    return archives
  }

  async cancelSubmission(submissionId: string): Promise<void> {
    const submission = this.submissions.get(submissionId)
    if (submission === undefined) return
    this.submissions.delete(submissionId)
    for (const [topicId, page] of this.topicPages) {
      if (page === submission.page) this.topicPages.delete(topicId)
    }
    await submission.page.close().catch(() => undefined)
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
    const isConversation = (value: string): boolean => {
      try {
        const url = new URL(value)
        return /^\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname)
      } catch {
        return false
      }
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const url = page.url()
      if (isConversation(url)) return url
      // The fixture/local appUrl has no /c/<uuid>; retain its URL for tests.
      if (this.options.appUrl !== undefined) return url
      await page.waitForTimeout(500)
    }
    throw new TransportError('new conversation URL was not observed; the message may not have been sent', 'ui')
  }

  private async readModel(page: Page): Promise<string> {
    const picker = await firstVisible(page, SELECTORS.modelPicker, 2_000)
    if (picker === undefined) return ''
    return (await picker.innerText().catch(() => '')).trim()
  }

  private async selectModel(page: Page, model: string): Promise<string> {
    const picker = await firstVisible(page, SELECTORS.modelPicker, 2_000)
    const wanted = model.trim()
    if (wanted === '') return await this.readModel(page)
    if (picker === undefined) throw new TransportError(`cannot verify requested ChatGPT model: ${wanted}`, 'ui')
    // The live picker lists menu items by display name (Pro, GPT-6, ...);
    // "thinking" is an effort on the same picker, so it accepts Pro.
    const pattern = /^thinking$/i.test(wanted) ? /pro|思考|thinking/i : new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    const current = (await picker.innerText()).trim()
    if (pattern.test(current)) return current
    try {
      await picker.click()
      const option = page.locator('[role="menuitem"], [role="menuitemradio"]').filter({ hasText: pattern }).filter({ visible: true }).first()
      await option.waitFor({ state: 'visible', timeout: 3_000 })
      await option.click()
    } catch {
      await page.keyboard.press('Escape').catch(() => undefined)
    }
    const selected = await this.readModel(page)
    if (!pattern.test(selected)) throw new TransportError(`requested ChatGPT model ${wanted} was not selected (observed: ${selected || 'unknown'}); message was not sent`, 'ui')
    return selected
  }

  private async waitForReady(page: Page, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60_000)
    do {
      if (isAborted(signal)) throw new DOMException('aborted', 'AbortError')
      const count = await page.locator(SELECTORS.assistantMessage).count()
      const users = (await readUserTurns(page)).length
      const state = await readTurnState(page, Math.max(0, count - 1), users - 1)
      if (!state.streaming && ((count === 0 && users === 0) || state.terminal)) return
      await page.waitForTimeout(500)
    } while (Date.now() < deadline)
    throw new TransportError('previous response is still generating or its completion cannot be verified; follow-up was not sent; wait for completion and resume', 'ui')
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

  private async richAnswerText(page: Page, baseline: number, messageIndex: number): Promise<string> {
    // Image-only answers have no text; use a short count/dimension fingerprint
    // (never the base64 payload) so a gallery response still completes.
    const fingerprint = await page.evaluate(({ selector, turnSelector, userSelector, baseline, messageIndex }) => {
      const messages = [...document.querySelectorAll(selector)]
      if (messages.length <= baseline) return { images: [] as string[], codeLength: 0 }
      const last = messages[messageIndex]
      const root = last?.closest(turnSelector) ?? last
      if (root === null || root === undefined) return { images: [] as string[], codeLength: 0 }
      const images = [...root.querySelectorAll('img')]
        .filter(image => (image as HTMLImageElement).naturalWidth >= 300 && image.closest(userSelector) === null)
        .map(image => `${(image as HTMLImageElement).naturalWidth}x${(image as HTMLImageElement).naturalHeight}`)
      const codeLength = [...root.querySelectorAll('pre code')]
        .filter(code => code.closest('form') === null && code.closest(userSelector) === null)
        .reduce((sum, code) => sum + (code.textContent?.length ?? 0), 0)
      return { images, codeLength }
    }, { selector: SELECTORS.assistantMessage, turnSelector: SELECTORS.turn, userSelector: SELECTORS.userMessage, baseline, messageIndex })
    if (fingerprint.images.length > 0) return `image:${fingerprint.images.length}:${fingerprint.images.join(',')}`
    return fingerprint.codeLength > 0 ? `code:${fingerprint.codeLength}` : ''
  }

}
