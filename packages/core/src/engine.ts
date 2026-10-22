import type {
  EngineEvent,
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

export class ResearchEngine {
  private queue: string[] = []
  private active?: ActiveRun
  private runs = new Map<string, ActiveRun>()
  private nextBrief = new Map<string, string | undefined>()
  private readonly now: () => number

  constructor(private readonly options: EngineOptions) {
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
      run.controller.abort()
      return topic
    }
    await this.transition(topic, 'cancelled')
    return topic
  }

  async resume(id: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    if (topic.status !== 'stalled' && topic.status !== 'failed') {
      throw new Error(`topic ${id} is ${topic.status}, not stalled or failed`)
    }
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
    if (brief.trim() === '') throw new Error('brief is required')
    if (topic.status !== 'completed' && topic.status !== 'capped') {
      throw new Error(`topic ${id} is ${topic.status}; only completed or capped topics accept a follow-up`)
    }
    const next = topic.rounds.length + 1
    if (next > topic.roundsCap) topic.roundsCap = next
    await this.options.store.writeQuestion(topic, next, brief)
    await this.options.store.addMaterials(topic, materials ?? [])
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
    if (topic.status !== 'stalled') throw new Error(`topic ${id} is ${topic.status}, not stalled`)
    const check = { at: new Date().toISOString(), conclusion, note }
    topic.humanCheck = check
    await this.options.store.writeHumanCheck(topic, check)
    if (conclusion === 'submitted') {
      await this.transition(topic, 'waiting')
      this.enqueue(id)
    } else if (conclusion === 'not_submitted') {
      const last = topic.rounds[topic.rounds.length - 1]
      if (last !== undefined) {
        delete last.submissionId
        delete last.fingerprint
        delete last.submittedAt
      }
      await this.transition(topic, 'queued')
      this.enqueue(id)
    } else {
      await this.transition(topic, 'failed')
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
        if (topic.status === 'cancelled' || topic.status === 'completed') return

        // An answered round whose verdict is missing is adjudicated first.
        const last = topic.rounds[topic.rounds.length - 1]
        if (last !== undefined && last.answeredAt !== undefined && last.verdict === undefined) {
          await this.adjudicate(topic, last)
          if (signal.aborted) return
          topic = await this.options.store.load(id)
          if (topic.status === 'completed' || topic.status === 'capped') return
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
          round = { n, files: 0 }
          topic.rounds.push(round)
          const stored = n === 1
            ? await this.options.store.readQuestion(topic, 0)
            : await this.options.store.readQuestion(topic, n)
          const brief = stored ?? this.followUpBrief(topic)
          if (stored === undefined) await this.options.store.writeQuestion(topic, n, brief)
          await this.transition(topic, 'uploading')
        }

        if (round.submissionId === undefined) {
          if (topic.status !== 'uploading') await this.transition(topic, 'uploading')
          await this.submitRound(topic, round, signal)
        } else if (topic.status === 'queued') {
          await this.transition(topic, 'uploading')
          await this.transition(topic, 'submitted')
        }
        if (topic.status !== 'waiting') await this.transition(topic, 'waiting')

        const answer = await this.waitAnswer(round, signal)
        if (answer === undefined) return
        await this.options.store.writeAnswer(topic, n, answer)
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
    const brief = (await this.options.store.readQuestion(topic, round.n)) ?? ''
    const files = await this.options.store.readMaterialPaths(topic)
    round.files = files.length
    const result: SubmitResult = await this.options.transport.submit({
      topicId: topic.id,
      round: round.n,
      brief,
      files,
      model: topic.model,
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

  private async waitAnswer(round: RoundRecord, signal: AbortSignal): Promise<string | undefined> {
    const submissionId = round.submissionId
    if (submissionId === undefined) throw new Error('round has no submission')
    const deadline = this.now() + this.options.config.maxRoundMinutes * 60_000
    while (this.now() < deadline) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const polled: PollResult = await this.options.transport.poll({
        submissionId,
        timeoutMs: this.options.pollIntervalMs ?? 60_000,
        signal,
      })
      if (polled.state === 'answered') {
        if (polled.answer !== undefined) return polled.answer
        const fetched = await this.options.transport.fetch({ submissionId })
        return fetched.answer
      }
      if (polled.state === 'unknown') throw new TransportError('page state is unknown', 'ui')
    }
    throw new TransportError('no progress before maxRoundMinutes', 'timeout')
  }

  private async adjudicate(topic: Topic, round: RoundRecord): Promise<void> {
    const answer = await this.options.store.readAnswer(topic, round.n)
    if (answer === undefined) {
      throw new TransportError('answer file is missing for adjudication', 'ui')
    }
    await this.transition(topic, 'adjudicating')
    const result = await this.options.judge({ topic, round: round.n, answer, criteria: topic.successCriteria })
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
    await this.transition(topic, 'queued')
  }

  private followUpBrief(topic: Topic): string {
    const stored = this.nextBrief.get(topic.id)
    if (stored !== undefined && stored.trim() !== '') return stored
    const last = topic.rounds[topic.rounds.length - 1]
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
      `| ${round.n} | ${round.verdict ?? '未裁决'} | ${round.files} | ${round.submittedAt ?? '未提交'} |`,
    )
    return [
      `# ${topic.title}`,
      '',
      `- 状态：${status}`,
      `- 停止依据：${stopReason}`,
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
      '| 轮 | 裁决 | 文件 | 提交时间 |',
      '|---|---|---|---|',
      ...rows,
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
        await this.transition(topic, 'failed')
        return
      }
      const reason = error.failure === 'login' || error.failure === 'upload' || error.failure === 'ui'
        ? error.failure
        : 'timeout'
      await this.transition(topic, 'stalled', { stallReason: reason })
      return
    }
    await this.transition(topic, 'failed')
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
