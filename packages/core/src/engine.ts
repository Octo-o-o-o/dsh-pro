import { createHash, randomUUID } from 'node:crypto'
import type {
  DispatchIntent,
  EngineEvent,
  FetchedAnswer,
  Judge,
  MaterialRef,
  PollResult,
  ResearchCard,
  RoundRecord,
  Status,
  SubmitResult,
  Topic,
  Transport,
} from './types.ts'
import type { ResearchStore } from './store.ts'
import type { ProConfig } from './config.ts'
import { cardRounds } from './config.ts'
import { assertTransition } from './state.ts'
import { TransportError } from './types.ts'

export interface EngineOptions {
  store: ResearchStore
  transport: Transport
  judge: Judge
  config: ProConfig
  onEvent?: (event: EngineEvent) => void
  now?: () => number
  pollIntervalMs?: number
}

interface ActiveRun {
  controller: AbortController
  promise: Promise<void>
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted')
}

/** Stable identity for one submit attempt; never includes file contents. */
function requestHash(input: {
  brief: string
  files: readonly string[]
  model: string
  designs?: number
}): string {
  return createHash('sha256').update(JSON.stringify({
    brief: input.brief,
    files: [...input.files],
    model: input.model,
    designs: input.designs ?? null,
  })).digest('hex')
}

function latestDispatchedRound(topic: Topic): RoundRecord | undefined {
  return [...topic.rounds].reverse().find(round => round.submissionId !== undefined || round.dispatch !== undefined)
}

function hasUnobservedDispatch(round: RoundRecord | undefined): boolean {
  return round?.dispatch !== undefined && round.submissionId === undefined
}

export class ResearchEngine {
  private queue: string[] = []
  private active?: ActiveRun
  private runs = new Map<string, ActiveRun>()
  private nextBrief = new Map<string, string | undefined>()
  private readonly options: EngineOptions
  private readonly now: () => number

  constructor(options: EngineOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  async start(card: ResearchCard): Promise<Topic> {
    this.validateCard(card)
    const rounds = cardRounds(this.options.config, card)
    const { topic } = await this.options.store.create(
      card,
      rounds,
      card.model ?? this.options.config.model,
      this.options.config.channel,
    )
    await this.transition(topic, 'queued')
    this.enqueue(topic.id)
    return topic
  }

  async list(): Promise<Topic[]> {
    return this.options.store.list()
  }

  async status(id: string): Promise<Topic> {
    return this.options.store.load(id)
  }

  async cancel(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    if (topic.status === 'completed' || topic.status === 'cancelled') return topic
    const run = this.runs.get(id)
    if (run !== undefined) {
      const last = [...topic.rounds].reverse().find(round => round.submissionId !== undefined)
      run.controller.abort()
      if (last?.submissionId !== undefined) {
        void this.options.transport.cancelSubmission?.(last.submissionId)
      }
      return topic
    }
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    delete topic.stopReason
    await this.transition(topic, 'cancelled')
    return topic
  }

  private assertChannel(topic: Topic): void {
    const topicChannel = topic.channel === 'api' ? 'api' : 'web'
    if (topicChannel !== this.options.config.channel) {
      throw new Error(`主题属于 ${topicChannel} 通道，当前设置为 ${this.options.config.channel}；请切回原通道或新建主题`)
    }
  }

  async resume(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    this.assertChannel(topic)
    if (topic.status !== 'stalled' && topic.status !== 'failed') {
      throw new Error(`topic ${id} is ${topic.status}, not stalled or failed`)
    }
    const round = latestDispatchedRound(topic)
    if (topic.channel === 'api' && round !== undefined && round.submissionId !== undefined) {
      throw new Error('API 生图请求在重启后已丢失，无法接管；请接受已有产物、重新生成或取消')
    }
    if (hasUnobservedDispatch(round)) {
      // The click may already have happened. Reattach is the only safe way
      // forward; without it a human must decide between "not submitted" and
      // accepting the existing artifacts.
      if (this.options.transport.reattach === undefined) {
        throw new Error('上一轮可能已经提交，但当前通道无法重新附着；请人工核对后用“未提交”重开，避免重复发送')
      }
      const attached = await this.tryAttach(topic)
      if (!attached) {
        throw new Error('无法确认上一轮是否已经提交；请人工核对后用“未提交”重开，避免重复发送')
      }
      await this.transition(topic, 'waiting')
      if (!this.runs.has(id)) this.enqueue(id)
      return topic
    }
    if (round !== undefined && this.options.transport.reattach !== undefined) {
      const attached = await this.tryAttach(topic)
      if (!attached) {
        throw new Error('无法确认上一轮是否已经提交；请人工核对后用“未提交”重开，避免重复发送')
      }
      await this.transition(topic, 'waiting')
      if (!this.runs.has(id)) this.enqueue(id)
      return topic
    }
    await this.transition(topic, 'queued')
    this.enqueue(id)
    return topic
  }

  /**
   * Re-open the stored conversation and verify the prompt is present. Returns
   * false when the round was never sent, so callers can ask for human review
   * instead of duplicating it.
   */
  private async tryAttach(topic: Topic): Promise<boolean> {
    const round = latestDispatchedRound(topic)
    if (round === undefined) return false
    const locator = await this.options.store.readLocator(topic.id)
    if (locator === undefined) return false
    const transport = this.options.transport
    if (transport.reattach === undefined) return false
    const brief = (await this.options.store.readQuestion(topic, round.n)) ?? ''
    const result = await transport.reattach({
      topicId: topic.id,
      round: round.n,
      conversationUrl: locator.conversationUrl,
      brief,
    })
    if (!result.attached || result.submissionId === undefined) return false
    round.submissionId = result.submissionId
    if (round.dispatch !== undefined) round.dispatch.observedAt = new Date().toISOString()
    await this.options.store.save(topic)
    return true
  }

  /**
   * After a host restart the browser map is empty but the topic still carries
   * the round's submission id. Re-open the stored conversation, verify the
   * prompt is really there, and adopt it instead of blindly resubmitting.
   */
  async reattach(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    this.assertChannel(topic)
    if (topic.status !== 'waiting' && topic.status !== 'submitted') {
      throw new Error(`topic ${id} is ${topic.status}, not waiting`)
    }
    const attached = await this.tryAttach(topic)
    if (!attached) {
      await this.transition(topic, 'stalled', {
        stallReason: 'unknown_submission',
        stopReason: 'DSH 重启后无法确认这一轮是否已提交；请核对会话后再恢复',
      })
      return topic
    }
    if (topic.status !== 'waiting') await this.transition(topic, 'waiting')
    if (!this.runs.has(id)) this.enqueue(id)
    return topic
  }

  /** Human accepts a capped/reviewing or artifact-bearing failed/stalled result. */
  async accept(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    if (topic.status === 'completed') return topic
    const withArtifacts = (topic.status === 'failed' || topic.status === 'stalled') && topic.artifacts.length > 0
    const reviewingFrom = topic.status === 'reviewing' ? topic.reviewFrom ?? 'capped' : undefined
    const reviewingAcceptable = reviewingFrom !== undefined
      && (reviewingFrom === 'capped' || topic.artifacts.length > 0)
    if (topic.status !== 'capped' && !reviewingAcceptable && !withArtifacts) {
      throw new Error(`topic ${id} is ${topic.status}; only capped/reviewing or failed/stalled with artifacts can be accepted`)
    }
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    const existing = await this.options.store.readFinal(topic)
    const text = existing === undefined
      ? this.finalDocument(topic, undefined, '人工接受结果', 'completed')
      : `${existing.replace(/^- 状态：.*$/m, '- 状态：completed').trimEnd()}\n- 人工接受：${new Date().toISOString()}\n`
    await this.options.store.writeFinal(topic, text)
    await this.transition(topic, 'completed', { stopReason: '人工接受结果' })
    this.emit({ type: 'finished', topicId: topic.id, status: 'completed' })
    return topic
  }

  /** Move a capped/failed/stalled topic to "waiting for the originating agent to judge". */  async markReviewing(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    if (topic.status === 'reviewing') return topic
    if (topic.status !== 'capped' && topic.status !== 'failed' && topic.status !== 'stalled') {
      throw new Error(`topic ${id} is ${topic.status}; only capped/failed/stalled can be handed to review`)
    }
    topic.reviewFrom = topic.status
    topic.reviewStopReason = topic.stopReason
    topic.reviewStallReason = topic.stallReason
    await this.transition(topic, 'reviewing', { stopReason: '等待原会话判断；接受、继续或重新生成后结束' })
    return topic
  }

  /** Return a reviewing topic to the queue it came from. */
  async cancelReview(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    if (topic.status === 'capped') return topic
    if (topic.status !== 'reviewing') throw new Error(`topic ${id} is ${topic.status}; only reviewing can return to its previous state`)
    const target = topic.reviewFrom ?? 'capped'
    const previousReason = topic.reviewStopReason
    const previousStall = topic.reviewStallReason
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    await this.transition(topic, target, {
      ...(previousStall !== undefined ? { stallReason: previousStall } : {}),
      stopReason: previousReason ?? '原会话判断请求已撤回；等待人工处理',
    })
    return topic
  }

  /** Mark an interrupted active topic for human review without resubmitting. */
  async interrupt(id: string, reason: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    if (topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing' || topic.status === 'cancelled') return topic
    if (topic.status === 'stalled') return topic
    await this.transition(topic, 'stalled', { stallReason: 'unknown_submission', stopReason: reason })
    return topic
  }

  /**
   * Start a new retained generation (a "version") rather than appending a
   * round to the current one. Failed rounds without an answer are retried in
   * place; finished topics get a fresh generation.
   */
  /**
   * Each version gets its own round budget, so a regeneration can run as many
   * rounds as the initial task did instead of stopping after a single round.
   */
  private generationBudget(topic: Topic): number {
    const configured = topic.generations?.[0]?.rounds ?? this.options.config.rounds
    return Number.isInteger(configured) && configured >= 1 ? configured : 1
  }

  async regenerate(id: string, brief: string, reason: string, materials?: MaterialRef[]): Promise<Topic> {
    const topic = await this.options.store.load(id)
    this.assertChannel(topic)
    if (brief.trim() === '') throw new Error('brief is required')
    const recoverable = topic.status === 'failed' || topic.status === 'stalled'
    const last = topic.rounds[topic.rounds.length - 1]
    if (recoverable && last !== undefined && last.answeredAt === undefined) {
      return await this.continue(id, brief, materials)
    }
    const finished = topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing' || recoverable
    if (!finished) throw new Error(`topic ${id} is ${topic.status}; regenerate needs a terminal topic`)

    if (topic.generations === undefined) {
      topic.generations = [{ n: 1, createdAt: topic.created, rounds: this.generationBudget(topic), reason: '初始任务' }]
    }
    // Older topics finished before generations existed: archive their current
    // final as generation 1 before starting generation 2.
    if (topic.generations.length === 1 && topic.generations[0]?.final === undefined) {
      const previous = await this.options.store.readFinal(topic)
      if (previous !== undefined) await this.options.store.writeFinal(topic, previous)
    }
    const budget = this.generationBudget(topic)
    const generation = (topic.generations.at(-1)?.n ?? 1) + 1
    topic.generations.push({
      n: generation,
      createdAt: new Date().toISOString(),
      rounds: budget,
      reason: reason.trim() || '用户重新生成',
    })
    const next = topic.rounds.length + 1
    topic.roundsCap = Math.max(topic.roundsCap, next + budget - 1)
    delete topic.nextBrief
    await this.options.store.writeQuestion(topic, next, brief)
    const staged = await this.options.store.addMaterials(topic, materials ?? [])
    await this.options.store.writeRoundMaterials(topic, next, staged)
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    delete topic.stopReason
    await this.transition(topic, 'queued')
    this.enqueue(id)
    return topic
  }

  /**
   * Explicit follow-up on a finished topic: one more round with a new brief.
   * The round limit grows when the follow-up would exceed it, because this is
   * the user-confirmed "+1 round" the design requires.
   */
  async continue(id: string, brief: string, materials?: MaterialRef[]): Promise<Topic> {
    const topic = await this.options.store.load(id)
    this.assertChannel(topic)
    if (brief.trim() === '') throw new Error('brief is required')
    const finished = topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing'
    const recoverable = topic.status === 'failed' || topic.status === 'stalled'
    if (!finished && !recoverable) {
      throw new Error(`topic ${id} is ${topic.status}; only completed/capped/reviewing or failed/stalled topics accept a follow-up`)
    }
    const last = topic.rounds[topic.rounds.length - 1]
    const retryCurrent = recoverable && last !== undefined && last.answeredAt === undefined
    if (retryCurrent && hasUnobservedDispatch(last)) {
      throw new Error('上一轮可能已经发送；请先人工核对，确认“未提交”后再继续，避免重复发送')
    }
    const next = retryCurrent ? last.n : topic.rounds.length + 1
    if (retryCurrent) {
      // The previous attempt never produced an answer: replace it with the
      // user's feedback instead of appending a round that runTopic would skip.
      const current = topic.generations?.find(item => item.n === (last.generation ?? 1))
      const budget = current?.rounds ?? this.generationBudget(topic)
      topic.roundsCap = Math.max(topic.roundsCap, last.n + budget - 1)
      delete last.submissionId
      delete last.fingerprint
      delete last.submittedAt
      delete last.verdict
      delete last.done
      delete last.dispatch
    } else if (next > topic.roundsCap) {
      topic.roundsCap = next
    }
    delete topic.nextBrief
    await this.options.store.writeQuestion(topic, next, brief)
    const staged = await this.options.store.addMaterials(topic, materials ?? [])
    await this.options.store.writeRoundMaterials(topic, next, staged)
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    delete topic.stopReason
    await this.transition(topic, 'queued')
    this.enqueue(id)
    return topic
  }

  async humanCheck(
    id: string,
    conclusion: 'submitted' | 'not_submitted' | 'reopen',
    note: string,
  ): Promise<Topic> {
    const topic = await this.options.store.load(id)
    this.assertChannel(topic)
    if (topic.status !== 'stalled') throw new Error(`topic ${id} is ${topic.status}, not stalled`)
    const check = { at: new Date().toISOString(), conclusion, note }
    topic.humanCheck = check
    await this.options.store.writeHumanCheck(topic, check)
    if (conclusion === 'submitted') {
      if (hasUnobservedDispatch(topic.rounds[topic.rounds.length - 1]) && this.options.transport.reattach === undefined) {
        throw new Error('这个通道无法确认已发送的消息；请保留现场，使用“未提交”重开或接受已有产物')
      }
      if (this.options.transport.reattach !== undefined) {
        const attached = await this.tryAttach(topic)
        if (!attached) {
          throw new Error('无法在原会话里确认这一轮的 prompt；请核对后用“未提交”重开，避免重复发送')
        }
      }
      await this.transition(topic, 'waiting')
      this.enqueue(id)
    } else if (conclusion === 'not_submitted') {
      const last = topic.rounds[topic.rounds.length - 1]
      if (last !== undefined) {
        delete last.submissionId
        delete last.fingerprint
        delete last.submittedAt
        delete last.dispatch
      }
      await this.transition(topic, 'queued')
      this.enqueue(id)
    } else {
      await this.transition(topic, 'failed', { stopReason: '人工核对判定需要重开；请重新生成或继续' })
    }
    return topic
  }

  /** Wait until the queue and the active run are both empty (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.active !== undefined || this.queue.length > 0) {
      if (this.active !== undefined) {
        await this.active.promise
      } else {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
  }

  private validateCard(card: ResearchCard): void {
    if (card.title.trim() === '') throw new Error('title is required')
    if (card.question.trim() === '') throw new Error('question is required')
    if (card.successCriteria.length === 0) throw new Error('successCriteria is required')
    if (card.brief.trim() === '') throw new Error('brief is required')
    if (card.materials.length > this.options.config.maxFiles) {
      throw new Error(`too many materials: ${card.materials.length} > ${this.options.config.maxFiles}`)
    }
  }

  private enqueue(id: string): void {
    if (this.runs.has(id) || this.queue.includes(id)) return
    this.queue.push(id)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.active !== undefined) return
    const id = this.queue.shift()
    if (id === undefined) return
    const controller = new AbortController()
    const promise = this.runTopic(id, controller.signal).finally(() => {
      this.runs.delete(id)
      if (this.active?.controller === controller) this.active = undefined
      void this.pump()
    })
    this.active = { controller, promise }
    this.runs.set(id, this.active)
  }

  private async runTopic(id: string, signal: AbortSignal): Promise<void> {
    try {
      let topic = await this.options.store.load(id)
      while (true) {
        if (signal.aborted) return
        if (topic.status === 'cancelled' || topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing') return

        // An answered round whose verdict is missing is adjudicated first.
        const last = topic.rounds[topic.rounds.length - 1]
        if (last !== undefined && last.answeredAt !== undefined && last.verdict === undefined) {
          await this.adjudicate(topic, last)
          if (signal.aborted) return
          topic = await this.options.store.load(id)
          if (topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing') return
          continue
        }

        const pending = last !== undefined && last.answeredAt === undefined ? last : undefined
        const n = pending !== undefined ? pending.n : topic.rounds.length + 1
        if (pending === undefined && n > topic.roundsCap) {
          await this.finishCapped(topic, '达到轮次上限')
          return
        }

        let round = pending ?? topic.rounds.find(item => item.n === n)
        if (round === undefined) {
          round = { n, files: 0, attempts: 0, generation: topic.generations?.at(-1)?.n ?? 1 }
          topic.rounds.push(round)
          const stored = n === 1
            ? await this.options.store.readQuestion(topic, 0)
            : await this.options.store.readQuestion(topic, n)
          const brief = stored ?? this.followUpBrief(topic)
          if (n === 1 || stored === undefined) await this.options.store.writeQuestion(topic, n, brief)
          await this.transition(topic, 'uploading')
        }

        if (round.submissionId === undefined) {
          if (round.generation === undefined) round.generation = topic.generations?.at(-1)?.n ?? 1
          if (topic.status !== 'uploading') await this.transition(topic, 'uploading')
          await this.submitRound(topic, round, signal)
        } else if (topic.status === 'queued') {
          await this.transition(topic, 'uploading')
          await this.transition(topic, 'submitted')
        }
        if (topic.status !== 'waiting') await this.transition(topic, 'waiting')

        const fetched = await this.waitAnswer(round, signal)
        if (fetched === undefined) return
        await this.options.store.writeAnswer(topic, n, fetched.answer)
        const written = await this.options.store.writeArtifacts(topic, n, fetched)
        if (written.length > 0) {
          round.artifacts = [...new Set([...(round.artifacts ?? []), ...written])]
        }
        round.answeredAt = new Date().toISOString()
        await this.transition(topic, 'answered')
        this.emit({ type: 'answered', topicId: topic.id, round: n })
        topic = await this.options.store.load(id)
      }
    } catch (error) {
      await this.handleFailure(id, error, signal)
    }
  }

  private async submitRound(topic: Topic, round: RoundRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (round.dispatch !== undefined && round.submissionId === undefined) {
      throw new TransportError('previous dispatch was never observed; human check is required before any resend', 'ui')
    }
    const brief = (await this.options.store.readQuestion(topic, round.n)) ?? ''
    const locator = await this.options.store.readLocator(topic.id)
    const allFiles = await this.options.store.readMaterialPaths(topic)
    let files = allFiles
    let fallbackFiles: string[] | undefined
    if (locator !== undefined && round.n > 1) {
      // Inside the same conversation only the new materials go up; if the
      // transport has to start a fresh chat it falls back to the full list.
      const delta = await this.options.store.readRoundMaterials(topic, round.n)
      files = (delta ?? []).map(item => item.path)
      fallbackFiles = allFiles
    }
    round.files = files.length
    round.attempts = (round.attempts ?? 0) + 1
    const intent: DispatchIntent = {
      attemptId: randomUUID(),
      at: new Date().toISOString(),
      requestHash: requestHash({
        brief,
        files,
        model: topic.model,
        ...(topic.designs !== undefined ? { designs: topic.designs } : {}),
      }),
    }
    round.dispatch = intent
    // This is the line that makes a crash after the click conservative: the
    // intent is on disk before the transport can press send.
    await this.options.store.save(topic)
    const result: SubmitResult = await this.options.transport.submit({
      topicId: topic.id,
      round: round.n,
      brief,
      files,
      ...(fallbackFiles !== undefined ? { fallbackFiles } : {}),
      model: topic.model,
      ...(topic.designs !== undefined ? { designs: topic.designs } : {}),
      session: locator ?? null,
    })
    round.dispatch = { ...intent, observedAt: new Date().toISOString() }
    round.files = result.attachments.length
    await this.options.store.writeLocator(topic.id, {
      conversationUrl: result.conversationUrl,
      profileDir: this.options.config.browser.profileDir,
      lastFingerprint: result.fingerprint,
    })
    round.submissionId = result.submissionId
    round.fingerprint = result.fingerprint
    round.submittedAt = new Date().toISOString()
    await this.options.store.writeReceipt(topic, round.n, {
      n: round.n,
      submissionId: result.submissionId,
      fingerprint: result.fingerprint,
      conversationUrl: result.conversationUrl,
      attachments: result.attachments,
      submittedAt: round.submittedAt,
    })
    await this.transition(topic, 'submitted')
  }

  private async waitAnswer(round: RoundRecord, signal: AbortSignal): Promise<FetchedAnswer | undefined> {
    const submissionId = round.submissionId
    if (submissionId === undefined) throw new Error('round has no submission')
    const deadline = this.now() + this.options.config.maxRoundMinutes * 60_000
    let stallDeadline = this.now() + this.options.config.stallMinutes * 60_000
    while (this.now() < deadline) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      if (this.now() > stallDeadline) {
        throw new TransportError(`no progress for ${this.options.config.stallMinutes} minutes`, 'timeout')
      }
      const polled: PollResult = await this.options.transport.poll({
        submissionId,
        timeoutMs: this.options.pollIntervalMs ?? 60_000,
        signal,
      })
      if (polled.state === 'answered') {
        try {
          return await this.options.transport.fetch({ submissionId })
        } catch (error) {
          // Text-only fallback keeps older transports (and partial pages) usable.
          if (polled.answer !== undefined) {
            return { answer: polled.answer.startsWith('image:') ? '' : polled.answer }
          }
          throw error
        }
      }
      if (polled.state === 'unknown') throw new TransportError('page state is unknown', 'ui')
      if (polled.progress === true) stallDeadline = this.now() + this.options.config.stallMinutes * 60_000
    }
    throw new TransportError('no progress before maxRoundMinutes', 'timeout')
  }

  private async adjudicate(topic: Topic, round: RoundRecord): Promise<void> {
    const answer = await this.options.store.readAnswer(topic, round.n)
    if (answer === undefined) {
      throw new TransportError('answer file is missing for adjudication', 'ui')
    }
    await this.transition(topic, 'adjudicating')
    const question = (await this.options.store.readQuestion(topic, round.n)) ?? ''
    const result = await this.options.judge({ topic, round: round.n, answer, criteria: topic.successCriteria, question })
    const verdictText = `# 第 ${round.n} 轮裁决\n\n- 结论：${result.verdict}\n- 停止：${result.done ? '是' : '否'}\n- 理由：${result.reason}\n\n## 摘要\n\n${result.summary}\n`
    await this.options.store.writeVerdict(topic, round.n, verdictText)
    round.verdict = result.verdict
    round.done = result.done
    this.emit({ type: 'round', topicId: topic.id, round: round.n, verdict: result.verdict })
    if (result.done) {
      await this.options.store.writeFinal(topic, this.finalDocument(topic, result.summary, result.reason, 'completed'))
      await this.transition(topic, 'completed', { stopReason: result.reason })
      this.emit({ type: 'finished', topicId: topic.id, status: 'completed' })
      return
    }
    if (round.n >= topic.roundsCap) {
      await this.options.store.writeFinal(topic, this.finalDocument(topic, result.summary, result.reason, 'capped'))
      await this.transition(topic, 'capped', { stopReason: result.reason })
      this.emit({ type: 'finished', topicId: topic.id, status: 'capped' })
      return
    }
    this.nextBrief.set(topic.id, result.nextBrief)
    if (result.nextBrief !== undefined && result.nextBrief.trim() !== '') topic.nextBrief = result.nextBrief
    else delete topic.nextBrief
    await this.transition(topic, 'queued')
  }

  private followUpBrief(topic: Topic): string {
    const stored = this.nextBrief.get(topic.id) ?? topic.nextBrief
    if (stored !== undefined && stored.trim() !== '') return stored
    const last = topic.rounds[topic.rounds.length - 1]
    if (topic.type === 'design') {
      return [
        `继续主题「${topic.title}」，给出与上一轮明显不同的新方向；若上一轮只部分满足判据，就在保留已确认部分的前提下修订。不要重复已确认的方案。`,
        '',
        `本轮请生成 ${topic.designs ?? 3} 个可区分的设计方向，每个方向单独一张图；需要前端时给一个可运行的单文件 HTML demo。`,
        '',
        '## 成功判据',
        ...topic.successCriteria.map(item => `- ${item}`),
        '',
        last?.verdict !== undefined ? `上一轮裁决：${last.verdict}` : '上一轮裁决：未记录',
      ].join('\n')
    }
    return [
      `继续主题「${topic.title}」，只补充未决部分，不要重复已确认结论。`,
      '',
      '## 成功判据',
      ...topic.successCriteria.map(item => `- ${item}`),
      '',
      last?.verdict !== undefined ? `上一轮裁决：${last.verdict}` : '上一轮裁决：未记录',
    ].join('\n')
  }

  private async finishCapped(topic: Topic, reason: string): Promise<void> {
    await this.options.store.writeFinal(topic, this.finalDocument(topic, undefined, reason, 'capped'))
    await this.transition(topic, 'capped', { stopReason: reason })
    this.emit({ type: 'finished', topicId: topic.id, status: 'capped' })
  }

  private finalDocument(topic: Topic, summary: string | undefined, stopReason: string, status: Status): string {
    const rows = topic.rounds.map(round =>
      `| ${round.n} | ${round.verdict ?? '未裁决'} | ${round.files} | ${round.submittedAt ?? '未提交'} | ${round.answeredAt ?? '未完成'} |`,
    )
    return [
      `# ${topic.title}`,
      '',
      `- 状态：${status}`,
      `- 停止依据：${stopReason}`,
      `- 通道：${topic.channel}`,
      `- 轮次：${topic.rounds.length}/${topic.roundsCap}`,
      '',
      '## 成功判据',
      '',
      ...topic.successCriteria.map(item => `- ${item}`),
      '',
      '## 结论摘要',
      '',
      summary ?? '（未生成摘要；见各轮裁决与原始答复）',
      '',
      '## 轮次',
      '',
      '| 轮 | 裁决 | 文件 | 提交时间 | 完成时间 |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      '## 产物',
      '',
      ...(topic.artifacts.length > 0 ? topic.artifacts.map(item => `- \`${item}\``) : ['- （无产物）']),
      '',
      '## 原始答复',
      '',
      `原始答复保存在 \`rawAnswersDir/${topic.id}/\`；是否随仓库保存由 \`rawAnswers\` 配置决定。`,
      '',
    ].join('\n')
  }

  private async handleFailure(id: string, error: unknown, signal: AbortSignal): Promise<void> {
    if (isAbort(error) || signal.aborted) {
      const cancelled = await this.options.store.load(id).catch(() => undefined)
      if (cancelled !== undefined && cancelled.status !== 'cancelled' && cancelled.status !== 'completed') {
        await this.transition(cancelled, 'cancelled')
      }
      return
    }
    const topic = await this.options.store.load(id)
    if (topic.status === 'completed' || topic.status === 'cancelled') return
    if (error instanceof TransportError) {
      if (error.failure === 'worker') {
        await this.transition(topic, 'failed', { stopReason: error.message })
        return
      }
      const reason = error.failure === 'login' || error.failure === 'upload' || error.failure === 'ui' || error.failure === 'config'
        ? error.failure
        : 'timeout'
      await this.transition(topic, 'stalled', { stallReason: reason, stopReason: error.message })
      return
    }
    await this.transition(topic, 'failed', {
      stopReason: error instanceof Error ? error.message : String(error),
    })
  }

  private async transition(
    topic: Topic,
    next: Status,
    extra?: { stallReason?: Topic['stallReason']; stopReason?: string },
  ): Promise<void> {
    assertTransition(topic.status, next)
    topic.status = next
    if (extra?.stallReason !== undefined) topic.stallReason = extra.stallReason
    if (extra?.stopReason !== undefined) topic.stopReason = extra.stopReason
    if (extra?.stopReason === undefined && (next === 'queued' || next === 'uploading' || next === 'submitted' || next === 'waiting' || next === 'answered' || next === 'adjudicating')) {
      delete topic.stopReason
    }
    if (next !== 'stalled') delete topic.stallReason
    await this.options.store.save(topic)
    this.emit({
      type: 'status',
      topicId: topic.id,
      status: next,
      ...(extra?.stallReason !== undefined ? { reason: extra.stallReason } : {}),
    })
  }

  private emit(event: EngineEvent): void {
    this.options.onEvent?.(event)
  }
}
