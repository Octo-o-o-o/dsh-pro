import { createHash, randomUUID } from 'node:crypto'
import type {
  DispatchIntent,
  EngineEvent,
  FetchedAnswer,
  Judge,
  JudgeResult,
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
import { assertCompletion } from './judge.ts'
import { verifyStagedBaseImage } from './base-image.ts'
import { isTransportError, TransportError } from './types.ts'

export interface EngineOptions {
  store: ResearchStore
  transport: Transport
  judge: Judge
  config: ProConfig
  onEvent?: (event: EngineEvent) => void
  /** Last-resort trap for failures inside failure handling itself. */
  onError?: (error: unknown) => void
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

function latestSubmission(topic: Topic): RoundRecord | undefined {
  return [...topic.rounds].reverse().find(round => round.submissionId !== undefined)
}

export class ResearchEngine {
  private queue: string[] = []
  private active?: ActiveRun
  private runs = new Map<string, ActiveRun>()
  private nextBrief = new Map<string, string | undefined>()
  private disposed = false
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
    // Claim cancellation before the first await: a terminal save can finish
    // while load() is pending, but the still-owned runner must not win that race.
    // A queued topic must not become a new un-aborted runner during that read.
    this.queue = this.queue.filter(queued => queued !== id)
    const run = this.runs.get(id)
    run?.controller.abort()
    const topic = await this.options.store.load(id)
    if (run !== undefined) {
      // A submit that has already clicked send cannot be unsent. Let the run
      // record the submission, then cancel it, rather than returning an old
      // "uploading" snapshot while the message and its billing continue.
      const last = latestSubmission(topic)
      if (last?.submissionId !== undefined) await this.cancelSubmission(last.submissionId)
      // Waiting is what makes the returned status honest, but a submit can sit
      // in transport timeouts. Bound the wait so a tool/HTTP call cannot hang
      // for the whole submit budget; the run still settles into cancelled and
      // the panel's poll picks that up.
      await Promise.race([
        run.promise.then(() => undefined, () => undefined),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 90_000)
          timer.unref?.()
        }),
      ])
      return await this.options.store.load(id).catch(() => topic)
    }
    if (topic.status === 'completed' || topic.status === 'cancelled') return topic
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    delete topic.stopReason
    // No local runner, but the transport may still hold an in-flight
    // submission (e.g. a billed API job); tell it to stop.
    const last = latestSubmission(topic)
    if (last?.submissionId !== undefined && last.answeredAt === undefined) {
      await this.cancelSubmission(last.submissionId)
    }
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
    const resumable = topic.status === 'stalled' || topic.status === 'failed'
      || topic.status === 'answered' || topic.status === 'adjudicating'
      || (topic.status === 'reviewing' && topic.reviewFrom === 'answered')
    if (!resumable) {
      throw new Error(`topic ${id} is ${topic.status}, not resumable`)
    }
    const last = topic.rounds[topic.rounds.length - 1]
    // A round whose answer is already on disk needs only the local judge: no
    // browser reattach, no API submission to lose. This branch must precede
    // the api in-flight guard and the reattach path below, and it must end in
    // 'queued'/'answered' so runTopic's adjudicate transition stays legal
    // (waiting -> adjudicating is not a legal transition).
    if (last !== undefined && last.answeredAt !== undefined && last.verdict === undefined && last.judgeSkippedAt === undefined) {
      if (topic.status === 'stalled' || topic.status === 'failed' || topic.status === 'adjudicating' || topic.status === 'reviewing') {
        delete topic.reviewFrom
        delete topic.reviewStopReason
        await this.transition(topic, 'queued')
      }
      this.enqueue(id)
      return topic
    }
    if (last?.answeredAt !== undefined && (last.verdict !== undefined || last.judgeSkippedAt !== undefined)) {
      // The interrupted work is the next round, not this already answered one.
      // Reattaching it would leave runTopic in waiting -> uploading when it
      // creates that next round. Preserve its brief/budget and resume locally.
      if (topic.status === 'answered') await this.transition(topic, 'adjudicating')
      delete topic.reviewFrom
      delete topic.reviewStopReason
      delete topic.reviewStallReason
      await this.transition(topic, 'queued')
      this.enqueue(id)
      return topic
    }
    // A pre-send failure belongs to the pending round, not to an older sent
    // round. Explicit resume retries this round without consuming another one.
    if (last?.submissionState === 'not_sent' && last.submissionId === undefined && last.dispatch === undefined) {
      await this.transition(topic, 'queued')
      this.enqueue(id)
      return topic
    }
    const round = latestDispatchedRound(topic)
    if (topic.channel === 'api' && round !== undefined && round.answeredAt === undefined && round.submissionId !== undefined) {
      // API jobs are in-memory only: after a host restart there is nothing to
      // reattach. Probe once — a live job (same process, transient stall) is
      // resumed honestly; a lost one is refused with an actionable message.
      const probe = await this.options.transport.poll({ submissionId: round.submissionId, timeoutMs: 1_000 })
      if (probe.state === 'unknown') {
        throw new Error('API 生图请求在重启后已丢失，无法接管；请接受已有产物、重新生成或取消')
      }
      await this.transition(topic, 'waiting')
      this.enqueue(id)
      return topic
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
    const last = topic.rounds[topic.rounds.length - 1]
    // Crash window: the answer was written but the verdict never landed. Skip
    // the browser entirely; 'answered' keeps the adjudicate transition legal
    // (waiting -> adjudicating is not a legal transition).
    if (last !== undefined && last.answeredAt !== undefined && last.verdict === undefined && last.judgeSkippedAt === undefined) {
      if (topic.status === 'submitted') await this.transition(topic, 'waiting')
      if (topic.status === 'waiting') await this.transition(topic, 'answered')
      this.enqueue(id)
      return topic
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
    if (topic.status === 'completed') {
      if (topic.acceptedAt === undefined) {
        topic.acceptedAt = new Date().toISOString()
        await this.options.store.save(topic)
      }
      return topic
    }
    const withArtifacts = (topic.status === 'failed' || topic.status === 'stalled') && topic.artifacts.length > 0
    const reviewingFrom = topic.status === 'reviewing' ? topic.reviewFrom ?? 'capped' : undefined
    const reviewingAcceptable = reviewingFrom !== undefined
      && (reviewingFrom === 'capped' || reviewingFrom === 'answered' || topic.artifacts.length > 0)
    if (topic.status !== 'capped' && !reviewingAcceptable && !withArtifacts) {
      throw new Error(`topic ${id} is ${topic.status}; only capped/reviewing or failed/stalled with artifacts can be accepted`)
    }
    delete topic.reviewFrom
    delete topic.reviewStopReason
    delete topic.reviewStallReason
    delete topic.runThrough
    delete topic.nextDesigns
    delete topic.nextBaseArtifact
    const existing = await this.options.store.readFinal(topic)
    // A failed judge does not write a new final. A previous generation/round's
    // final may still exist, but its summary must never become this result.
    const text = existing !== undefined && this.matchesFinalCoverage(topic, existing)
      ? `${existing.replace(/^- 状态：.*$/m, '- 状态：completed').trimEnd()}\n- 人工接受：${new Date().toISOString()}\n`
      : this.finalDocument(topic, undefined, '人工接受结果', 'completed')
    const accepted = text.includes('（未生成摘要；见各轮裁决与原始答复）')
      ? `${text}- 人工接受说明：未生成自动摘要，结论见原始答复。\n`
      : text
    topic.acceptedAt = new Date().toISOString()
    await this.options.store.writeFinal(topic, accepted)
    await this.transition(topic, 'completed', { stopReason: '人工接受结果' })
    this.emit({ type: 'finished', topicId: topic.id, status: 'completed' })
    return topic
  }

  /** Move a capped/failed/stalled topic to "waiting for the originating agent to judge". */
  async markReviewing(id: string): Promise<Topic> {
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
    topic.runThrough = next + budget - 1
    delete topic.nextDesigns
    delete topic.nextBaseArtifact
    delete topic.nextBrief
    delete topic.acceptedAt
    await this.options.store.writeQuestion(topic, next, brief)
    const staged = await this.options.store.addMaterials(topic, materials ?? [])
    await this.options.store.writeRoundMaterials(topic, next, staged)
    if (last?.answeredAt !== undefined && last.verdict === undefined) last.judgeSkippedAt = new Date().toISOString()
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
  async continue(id: string, brief: string, materials?: MaterialRef[], designs?: number, baseArtifact?: string): Promise<Topic> {
    const topic = await this.options.store.load(id)
    this.assertChannel(topic)
    if (brief.trim() === '') throw new Error('brief is required')
    if (designs !== undefined && (!Number.isInteger(designs) || designs < 1 || designs > 6)) {
      throw new Error('designs must be an integer between 1 and 6')
    }
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
    if (baseArtifact !== undefined && (topic.type !== 'design' || materials?.length !== 1)) {
      throw new Error('定向修改必须提供且仅提供一张底图')
    }
    if (retryCurrent) {
      if (baseArtifact !== undefined) last.baseArtifact = baseArtifact
      else delete last.baseArtifact
    } else if (baseArtifact !== undefined) topic.nextBaseArtifact = baseArtifact
    else delete topic.nextBaseArtifact
    if (retryCurrent) {
      // The previous attempt never produced an answer: replace it with the
      // user's feedback instead of appending a round that runTopic would skip.
      // This replaces a failed attempt inside its existing authorization. The
      // stored ceiling already accounts for consumed generation rounds and for
      // an explicit one-round continue; restarting a full budget at last.n
      // would silently authorize extra external submissions.
      topic.runThrough = topic.runThrough ?? topic.roundsCap
      if (last.submissionId !== undefined) {
        // The old attempt may still be generating (a timeout is not proof it
        // stopped); cancel it before the new submit so both are not billed.
        await this.cancelSubmission(last.submissionId)
      }
      delete last.submissionId
      delete last.fingerprint
      delete last.submittedAt
      delete last.verdict
      delete last.done
      delete last.dispatch
    } else {
      if (next > topic.roundsCap) topic.roundsCap = next
      // One explicit continue is one authorized round, even when the previous
      // run finished early and the historical cap has room left.
      topic.runThrough = next
    }
    if (topic.type === 'design' && designs !== undefined) {
      if (retryCurrent) { last.designs = designs; delete topic.nextDesigns }
      else topic.nextDesigns = designs
    } else delete topic.nextDesigns
    if (baseArtifact !== undefined) topic.runThrough = next
    delete topic.nextBrief
    delete topic.acceptedAt
    await this.options.store.writeQuestion(topic, next, brief)
    const staged = await this.options.store.addMaterials(topic, materials ?? [])
    await this.options.store.writeRoundMaterials(topic, next, staged)
    if (last?.answeredAt !== undefined && last.verdict === undefined) last.judgeSkippedAt = new Date().toISOString()
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
    if (topic.status !== 'stalled' && topic.status !== 'failed') throw new Error(`topic ${id} is ${topic.status}, not stalled or failed`)
    if (topic.status === 'failed') {
      await this.transition(topic, 'stalled', { stallReason: 'unknown_submission', stopReason: topic.stopReason })
    }
    const check = { at: new Date().toISOString(), conclusion, note }
    topic.humanCheck = check
    await this.options.store.writeHumanCheck(topic, check)
    if (conclusion === 'submitted') {
      const last = topic.rounds[topic.rounds.length - 1]
      if (last === undefined || (last.dispatch === undefined && last.submissionId === undefined)) {
        throw new Error('这一轮没有任何提交记录可核对；请改用“未提交”重开')
      }
      // The answer is already on disk: only the local judge is missing. End in
      // 'queued' so runTopic's adjudicate transition stays legal.
      if (last.answeredAt !== undefined && last.verdict === undefined) {
        await this.transition(topic, 'queued')
        this.enqueue(id)
        return topic
      }
      if (hasUnobservedDispatch(last) && this.options.transport.reattach === undefined) {
        throw new Error('这个通道无法确认已发送的消息；请保留现场，使用“未提交”重开或接受已有产物')
      }
      if (this.options.transport.reattach !== undefined) {
        const attached = await this.tryAttach(topic)
        if (!attached) {
          throw new Error('无法在原会话里确认这一轮的 prompt；请核对后用“未提交”重开，避免重复发送')
        }
      } else if (last.submissionId !== undefined) {
        // No reattach capability (e.g. the api channel): a definitively lost
        // in-flight job reports 'unknown' and must not be "confirmed" into a
        // stall loop. A transient poll failure does not override the human.
        const probe = await this.options.transport
          .poll({ submissionId: last.submissionId, timeoutMs: 1_000 })
          .catch(() => undefined)
        if (probe?.state === 'unknown') {
          throw new Error('该通道的请求已不在运行（宿主可能重启过），无法接管核对；请用“未提交”重开或接受已有产物')
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

  /**
   * Release this engine when its plugin fiber is disposed. Aborting the runs
   * stops polling; their failure path persists `cancelled`, so a later host
   * start does not resurrect a task this host deliberately stopped. New
   * enqueues are refused after disposal.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queue.length = 0
    this.active?.controller.abort()
    for (const run of this.runs.values()) run.controller.abort()
    this.runs.clear()
    this.nextBrief.clear()
  }

  /**
   * Wait for the aborted run to persist its final status before the caller
   * releases the transport. Bounded because a submit can be inside a
   * transport-level wait; the run still settles afterwards.
   */
  async settle(timeoutMs = 10_000): Promise<void> {
    const active = this.active
    if (active === undefined) return
    await Promise.race([
      active.promise.then(() => undefined, () => undefined),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
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
    if (this.disposed || this.runs.has(id) || this.queue.includes(id)) return
    this.queue.push(id)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.active !== undefined) return
    const id = this.queue.shift()
    if (id === undefined) return
    const controller = new AbortController()
    // The catch MUST sit on the promise stored in `this.active`: runTopic's own
    // catch delegates to handleFailure, which still touches the store and can
    // itself reject. Nobody awaits this promise in production, so without the
    // trap a disk error would surface as an unhandled rejection in the host.
    const promise = this.runTopic(id, controller.signal)
      .catch(error => {
        this.options.onError?.(error)
      })
      .finally(() => {
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
        // A clean return here would leave the topic queued with no runner;
        // aborting must flow through handleFailure so the topic lands in
        // 'cancelled'.
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
        if (topic.status === 'cancelled' || topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing') return

        // An answered round whose verdict is missing is adjudicated first.
        const last = topic.rounds[topic.rounds.length - 1]
        if (last !== undefined && last.answeredAt !== undefined && last.verdict === undefined && last.judgeSkippedAt === undefined) {
          await this.adjudicate(topic, last, signal)
          if (signal.aborted) throw new DOMException('aborted', 'AbortError')
          topic = await this.options.store.load(id)
          if (topic.status === 'completed' || topic.status === 'capped' || topic.status === 'reviewing') return
          continue
        }

        const pending = last !== undefined && last.answeredAt === undefined ? last : undefined
        const n = pending !== undefined ? pending.n : topic.rounds.length + 1
        const effectiveCap = topic.runThrough ?? topic.roundsCap
        if (pending === undefined && n > effectiveCap) {
          await this.finishCapped(topic, '达到轮次上限', signal)
          return
        }

        let round = pending ?? topic.rounds.find(item => item.n === n)
        if (round === undefined) {
          round = { n, files: 0, attempts: 0, generation: topic.generations?.at(-1)?.n ?? 1 }
          const requestedDesigns = topic.nextDesigns ?? topic.designs
          if (topic.type === 'design' && requestedDesigns !== undefined) round.designs = requestedDesigns
          delete topic.nextDesigns
          if (topic.nextBaseArtifact !== undefined) round.baseArtifact = topic.nextBaseArtifact
          delete topic.nextBaseArtifact
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
        const hasPayload = fetched.answer.trim() !== ''
          || (fetched.images?.length ?? 0) > 0
          || (fetched.codeBlocks?.length ?? 0) > 0
          || (fetched.archives?.length ?? 0) > 0
        if (!hasPayload) {
          throw new TransportError('the transport returned an empty answer with no artifacts', 'ui')
        }
        const answerHash = await this.options.store.writeAnswer(topic, n, fetched.answer)
        const written = await this.options.store.writeArtifacts(topic, n, fetched)
        if (written.length > 0) {
          round.artifacts = [...new Set([...(round.artifacts ?? []), ...written])]
        }
        round.answeredAt = new Date().toISOString()
        await this.transition(topic, 'answered')
        await this.options.store.patchReceipt(topic, n, {
          answerSha256: answerHash,
          answeredAt: round.answeredAt,
        }).catch(() => undefined)
        await this.options.store.appendEvent(topic, {
          type: 'answered',
          round: n,
          answerSha256: answerHash,
        }).catch(() => undefined)
        this.emit({ type: 'answered', topicId: topic.id, round: n })
        topic = await this.options.store.load(id)
      }
    } catch (error) {
      await this.handleFailure(id, error, signal)
    }
  }

  private async cancelSubmission(submissionId: string): Promise<void> {
    const cancel = this.options.transport.cancelSubmission
    if (cancel === undefined) return
    await cancel.call(this.options.transport, submissionId).catch(() => undefined)
  }

  private async submitRound(topic: Topic, round: RoundRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (round.dispatch !== undefined && round.submissionId === undefined) {
      throw new TransportError('previous dispatch was never observed; human check is required before any resend', 'ui')
    }
    const brief = await this.options.store.readQuestion(topic, round.n)
    if (brief === undefined) {
      throw new TransportError(`question file is missing for round ${round.n}; refusing to send an empty prompt`, 'ui')
    }
    const locator = await this.options.store.readLocator(topic.id)
    const allFiles = await this.options.store.readMaterialPaths(topic)
    let files = allFiles
    let fallbackFiles: string[] | undefined
    let editBase: { sha256: string } | undefined
    if (round.baseArtifact !== undefined) {
      const delta = await this.options.store.readRoundMaterials(topic, round.n)
      if (delta?.length !== 1) throw new Error('底图材料缺失，停止发送')
      if (topic.channel === 'api' && this.options.config.image.editMode === 'off') throw new Error('图片编辑已关闭，停止底图修改')
      await verifyStagedBaseImage(await this.options.store.dirOf(topic.id), delta[0]!)
      editBase = { sha256: delta[0]!.sha256 }
      files = delta.map(item => item.path)
      fallbackFiles = files
    } else if (locator !== undefined && round.n > 1) {
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
        ...((round.designs ?? topic.designs) !== undefined ? { designs: round.designs ?? topic.designs } : {}),
      }),
    }
    round.dispatch = intent
    delete round.submissionState
    // This is the line that makes a crash after the click conservative: the
    // intent is on disk before the transport can press send.
    await this.options.store.save(topic)
    let result: SubmitResult
    try {
      result = await this.options.transport.submit({
        topicId: topic.id,
        round: round.n,
        brief,
        files,
        ...(fallbackFiles !== undefined ? { fallbackFiles } : {}),
        ...(editBase !== undefined ? { editBase } : {}),
        model: topic.model,
        ...((round.designs ?? topic.designs) !== undefined ? { designs: round.designs ?? topic.designs } : {}),
        session: locator ?? null,
        signal,
      })
    } catch (error) {
      round.submissionState = isTransportError(error) && error.submissionState === 'not_sent' ? 'not_sent' : 'unknown'
      // Keep the original intent in the event log even when it is safe to
      // clear the replay guard. An ambiguous click NEVER clears that guard.
      await this.options.store.appendEvent(topic, {
        type: 'submit_failed', round: round.n, dispatch: intent,
        submissionState: round.submissionState,
        failure: isTransportError(error) ? error.failure : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      })
      if (round.submissionState === 'not_sent') delete round.dispatch
      await this.options.store.save(topic)
      throw error
    }
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
      ...(result.model !== undefined ? { model: result.model } : {}),
      submittedAt: round.submittedAt,
    })
    await this.transition(topic, 'submitted')
  }

  private async waitAnswer(round: RoundRecord, signal: AbortSignal): Promise<FetchedAnswer | undefined> {
    const submissionId = round.submissionId
    if (submissionId === undefined) throw new Error('round has no submission')
    const deadline = this.now() + this.options.config.maxRoundMinutes * 60_000
    let stallDeadline = this.now() + this.options.config.stallMinutes * 60_000
    let diagnostic = ''
    while (this.now() < deadline) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      if (this.now() > stallDeadline) {
        throw new TransportError(`no progress for ${this.options.config.stallMinutes} minutes${diagnostic}`, 'timeout')
      }
      const polled: PollResult = await this.options.transport.poll({
        submissionId,
        timeoutMs: this.options.pollIntervalMs ?? 60_000,
        signal,
      })
      if (polled.diagnostic !== undefined) diagnostic = ` (${polled.diagnostic})`
      if (polled.state === 'answered') {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
        let lastError: unknown
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            return await this.options.transport.fetch({ submissionId })
          } catch (error) {
            lastError = error
            if (signal.aborted) throw new DOMException('aborted', 'AbortError')
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
        // The page resumed generating between poll and fetch. A previous
        // snapshot is not a fallback answer when completion has been revoked.
        if (isTransportError(lastError) && lastError.answerIncomplete === true) continue
        // `image:…`/`code:…` is only a completion fingerprint, never answer
        // text. Saving it as an empty answer used to mark the round completed
        // while silently dropping every image and code block.
        const fingerprint = polled.answer ?? ''
        if (fingerprint.startsWith('image:') || fingerprint.startsWith('code:')) {
          throw new TransportError(
            'the answer contains images/code but its assets could not be read; parked for review instead of saving an empty answer',
            'ui',
            { cause: lastError },
          )
        }
        // A non-empty text answer can still be used when fetch fails, because
        // the poll already returned the assistant text.
        if (polled.answer !== undefined && polled.answer.trim() !== '') return { answer: polled.answer }
        throw lastError ?? new TransportError('the transport reported an answer it could not return', 'ui')
      }
      if (polled.state === 'unknown') throw new TransportError('page state is unknown', 'ui')
      if (polled.progress === true) stallDeadline = this.now() + this.options.config.stallMinutes * 60_000
    }
    throw new TransportError(`no completed answer before maxRoundMinutes${diagnostic}`, 'timeout')
  }

  private async adjudicate(topic: Topic, round: RoundRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const answer = await this.options.store.readAnswer(topic, round.n)
    signal.throwIfAborted()
    if (answer === undefined) {
      throw new TransportError('answer file is missing for adjudication', 'ui')
    }
    await this.transition(topic, 'adjudicating', undefined, signal)
    signal.throwIfAborted()
    const question = (await this.options.store.readQuestion(topic, round.n)) ?? ''
    signal.throwIfAborted()
    const input = { topic, round: round.n, answer, criteria: topic.successCriteria, question, signal }
    let result: JudgeResult
    try {
      result = await this.options.judge(input)
      signal.throwIfAborted()
      assertCompletion(input.criteria, result)
    } catch (first) {
      // Cancellation wins over either a late result or an error. In particular
      // an aborted provider must not trigger a retry or a review handoff.
      signal.throwIfAborted()
      // A malformed/transient judge response must not destroy a completed
      // answer. Retry once, then hand the topic to host/human review with the
      // answer and verdict placeholder intact.
      try {
        result = await this.options.judge(input)
        signal.throwIfAborted()
        assertCompletion(input.criteria, result)
      } catch (second) {
        signal.throwIfAborted()
        await this.parkJudgeFailure(topic, round, second ?? first, signal)
        return
      }
    }
    signal.throwIfAborted()
    delete round.judgeError
    const visualReview = topic.type === 'design' && result.done
    if (visualReview) result = { ...result, done: false, reason: `${result.reason}；文本判据通过，图片视觉效果待人工确认` }
    await this.options.store.writeVerdict(topic, round.n, this.verdictDocument(round, result))
    signal.throwIfAborted()
    round.verdict = result.verdict
    round.done = result.done
    await this.options.store.appendEvent(topic, {
      type: 'verdict',
      round: round.n,
      verdict: result.verdict,
      done: result.done,
    }).catch(() => undefined)
    signal.throwIfAborted()
    this.emit({ type: 'round', topicId: topic.id, round: round.n, verdict: result.verdict })
    if (result.done) {
      delete topic.runThrough
      delete topic.nextDesigns
      signal.throwIfAborted()
      await this.options.store.writeFinal(topic, this.finalDocument(topic, result.summary, result.reason, 'completed'))
      signal.throwIfAborted()
      await this.transition(topic, 'completed', { stopReason: result.reason }, signal)
      signal.throwIfAborted()
      this.emit({ type: 'finished', topicId: topic.id, status: 'completed' })
      return
    }
    if (visualReview || round.n >= (topic.runThrough ?? topic.roundsCap)) {
      delete topic.runThrough
      delete topic.nextDesigns
      signal.throwIfAborted()
      await this.options.store.writeFinal(topic, this.finalDocument(topic, result.summary, result.reason, 'capped'))
      signal.throwIfAborted()
      await this.transition(topic, 'capped', { stopReason: result.reason }, signal)
      signal.throwIfAborted()
      this.emit({ type: 'finished', topicId: topic.id, status: 'capped' })
      return
    }
    this.nextBrief.set(topic.id, result.nextBrief)
    if (result.nextBrief !== undefined && result.nextBrief.trim() !== '') topic.nextBrief = result.nextBrief
    else delete topic.nextBrief
    await this.transition(topic, 'queued', undefined, signal)
  }

  private verdictDocument(round: RoundRecord, result: JudgeResult): string {
    const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    const rows = (result.criteria ?? []).map(item => {
      const label = item.status === 'met' ? '满足' : item.status === 'partial' ? '部分满足' : item.status === 'unmet' ? '未满足' : '证据不足'
      return `| ${cell(item.criterion)} | ${label} | ${cell(item.evidence ?? '')} |`
    })
    return [
      `# 第 ${round.n} 轮裁决`,
      '',
      `- 结论：${result.verdict}`,
      `- 停止：${result.done ? '是' : '否'}`,
      `- 理由：${result.reason}`,
      '',
      '## 判据',
      '',
      ...(rows.length > 0
        ? ['| 判据 | 状态 | 依据 |', '|---|---|---|', ...rows]
        : ['裁决没有返回逐条判断；请对照成功判据人工复核。']),
      '',
      '## 摘要',
      '',
      result.summary,
      '',
    ].join('\n')
  }

  /**
   * The judge failed after an answer landed. Keep the answer, record why, and
   * park in `reviewing` (reviewFrom=answered) instead of failing the topic.
   * Accept/continue/regenerate/resume all remain available from that state.
   */
  private async parkJudgeFailure(topic: Topic, round: RoundRecord, error: unknown, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    round.judgeError = message
    const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    const verdictText = [
      `# 第 ${round.n} 轮裁决`,
      '',
      '- 结论：未完成自动裁决',
      '- 停止：否',
      `- 错误：${message}`,
      '',
      '## 判据',
      '',
      '| 判据 | 状态 | 依据 |',
      '|---|---|---|',
      ...topic.successCriteria.map(item => `| ${cell(item)} | 证据不足 | 自动裁决失败，未产出逐条判断 |`),
      '',
      '## 下一步',
      '',
      '答复与产物已经保留。请宿主或人工按成功判据复核：',
      '',
      '- 满足：`accept`；',
      '- 需要改进：`regenerate`；',
      '- 只补充一轮：`continue`；',
      '- 修复 `judgeProvider` / `judgeModel` 后：`resume` 重试自动裁决。',
      '',
    ].join('\n')
    await this.options.store.writeVerdict(topic, round.n, verdictText)
    signal.throwIfAborted()
    await this.options.store.appendEvent(topic, {
      type: 'judge_failed',
      round: round.n,
      message,
    }).catch(() => undefined)
    signal.throwIfAborted()
    topic.reviewFrom = 'answered'
    topic.reviewStopReason = `自动裁决失败：${message}`
    delete topic.reviewStallReason
    await this.transition(topic, 'reviewing', { stopReason: `自动裁决失败：${message}` }, signal)
    signal.throwIfAborted()
    this.emit({ type: 'judge_failed', topicId: topic.id, round: round.n, message })
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

  private async finishCapped(topic: Topic, reason: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    delete topic.runThrough
    delete topic.nextDesigns
    await this.options.store.writeFinal(topic, this.finalDocument(topic, undefined, reason, 'capped'))
    signal.throwIfAborted()
    await this.transition(topic, 'capped', { stopReason: reason }, signal)
    signal.throwIfAborted()
    this.emit({ type: 'finished', topicId: topic.id, status: 'capped' })
  }

  private finalCoverage(topic: Topic): { generation: number; throughRound: number } {
    return { generation: topic.generations?.at(-1)?.n ?? 1, throughRound: topic.rounds.at(-1)?.n ?? 0 }
  }

  private matchesFinalCoverage(topic: Topic, text: string): boolean {
    const header = /^<!-- dsh-pro-final: (\{[^\r\n]*\}) -->\r?\n/.exec(text)
    if (header === null) return false
    try {
      const coverage = JSON.parse(header[1]!) as { generation?: unknown; throughRound?: unknown }
      const current = this.finalCoverage(topic)
      return coverage.generation === current.generation && coverage.throughRound === current.throughRound
    } catch {
      return false
    }
  }

  private finalDocument(topic: Topic, summary: string | undefined, stopReason: string, status: Status): string {
    const rows = topic.rounds.map(round =>
      `| ${round.n} | ${round.verdict ?? '未裁决'} | ${round.files} | ${round.submittedAt ?? '未提交'} | ${round.answeredAt ?? '未完成'} |`,
    )
    return [
      `<!-- dsh-pro-final: ${JSON.stringify(this.finalCoverage(topic))} -->`,
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

  private ownsAbortedRun(id: string, signal: AbortSignal): boolean {
    return signal.aborted && (this.runs.get(id)?.controller.signal === signal || this.active?.controller.signal === signal)
  }

  private async handleFailure(id: string, error: unknown, signal: AbortSignal): Promise<void> {
    if (isAbort(error) || signal.aborted) {
      const cancelled = await this.options.store.load(id).catch(() => undefined)
      const ownsCancellation = this.ownsAbortedRun(id, signal)
      if (cancelled !== undefined && cancelled.status !== 'cancelled'
        && (ownsCancellation || !['completed', 'capped', 'reviewing'].includes(cancelled.status))) {
        delete cancelled.reviewFrom
        delete cancelled.reviewStopReason
        delete cancelled.reviewStallReason
        delete cancelled.stopReason
        const last = latestSubmission(cancelled)
        if (last?.submissionId !== undefined) {
          // The run may have observed the submission just before the abort;
          // stopping it here also releases an API job that would keep billing.
          await this.cancelSubmission(last.submissionId)
        }
        await this.transition(cancelled, 'cancelled', undefined, signal)
      }
      return
    }
    const topic = await this.options.store.load(id)
    if (topic.status === 'completed' || topic.status === 'cancelled') return
    if (isTransportError(error)) {
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
    runSignal?: AbortSignal,
  ): Promise<void> {
    if (next !== 'cancelled') runSignal?.throwIfAborted()
    // Only the interrupted owner may retract its just-saved completion. Keep
    // the global state machine (and completed topics without a runner) strict.
    const retractCompletion = topic.status === 'completed' && next === 'cancelled'
      && runSignal !== undefined && this.ownsAbortedRun(topic.id, runSignal)
    if (!retractCompletion) assertTransition(topic.status, next)
    topic.status = next
    if (extra?.stallReason !== undefined) topic.stallReason = extra.stallReason
    if (extra?.stopReason !== undefined) topic.stopReason = extra.stopReason
    if (extra?.stopReason === undefined && (next === 'queued' || next === 'uploading' || next === 'submitted' || next === 'waiting' || next === 'answered' || next === 'adjudicating')) {
      delete topic.stopReason
    }
    if (next !== 'stalled') delete topic.stallReason
    await this.options.store.save(topic)
    if (next !== 'cancelled') runSignal?.throwIfAborted()
    await this.options.store.appendEvent(topic, {
      type: 'status',
      status: next,
      ...(extra?.stallReason !== undefined ? { reason: extra.stallReason } : {}),
      ...(extra?.stopReason !== undefined ? { stopReason: extra.stopReason } : {}),
    }).catch(() => undefined)
    if (next !== 'cancelled') runSignal?.throwIfAborted()
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
