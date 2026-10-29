import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchEngine } from '../src/engine.ts'
import { ResearchStore } from '../src/store.ts'
import { defaultConfig } from '../src/config.ts'
import { buildManifest } from '../src/materials.ts'
import { TransportError, type Judge, type PollResult, type ResearchCard, type SubmitRequest, type Transport } from '../src/types.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

class FakeTransport implements Transport {
  submits: SubmitRequest[] = []
  canceled: string[] = []
  fail?: Error
  submitFail?: Error
  hang = false
  polling = false
  submitDelay = 0
  imageFingerprint = false
  fetchFail?: Error
  private seq = 0

  constructor(private readonly answers: string[]) {}

  async probe() {
    return { ok: true, loggedIn: true, model: 'pro', available: ['pro'] }
  }

  async submit(request: SubmitRequest) {
    this.submits.push(request)
    this.seq += 1
    if (this.submitDelay > 0) await new Promise(resolve => setTimeout(resolve, this.submitDelay))
    if (this.submitFail !== undefined) throw this.submitFail
    return {
      submissionId: `sub-${this.seq}`,
      fingerprint: `fp-${this.seq}`,
      attachments: request.files,
      conversationUrl: 'https://chatgpt.com/c/example',
    }
  }

  async cancelSubmission(submissionId: string) {
    this.canceled.push(submissionId)
  }

  async poll(request: { submissionId: string; signal?: AbortSignal }): Promise<PollResult> {
    this.polling = true
    if (this.hang) {
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    if (this.fail !== undefined) throw this.fail
    if (this.imageFingerprint) return { state: 'answered' as const, answer: 'image:2:512x512,1024x1024' }
    const n = Number(request.submissionId.split('-')[1])
    return { state: 'answered' as const, answer: this.answers[n - 1] ?? `answer ${n}` }
  }

  async fetch() {
    if (this.fetchFail !== undefined) throw this.fetchFail
    return { answer: 'fetched answer' }
  }

  async cancel(): Promise<void> {}
}

function judgeWith(doneAt: number): Judge {
  return async ({ round, criteria }) => ({
    verdict: round === doneAt ? 'accepted' : 'partial',
    reason: `reason ${round}`,
    done: round === doneAt,
    summary: `summary ${round}`,
    criteria: criteria.map(criterion => ({ criterion, status: 'met', evidence: 'answer' })),
  })
}

function card(overrides: Partial<ResearchCard> = {}): ResearchCard {
  return {
    title: 'Test topic',
    type: 'research',
    question: 'Does it work?',
    successCriteria: ['one criterion'],
    brief: 'brief body',
    materials: [],
    rounds: 3,
    store: 'project',
    ...overrides,
  }
}

async function harness(options: {
  doneAt: number
  rounds?: number
  answers?: string[]
  transport?: FakeTransport
  judge?: Judge
}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pro-engine-'))
  cleanups.push(root)
  const config = {
    ...defaultConfig(root),
    rounds: options.rounds ?? 3,
    maxRoundMinutes: 1,
    stallMinutes: 1,
  }
  const store = new ResearchStore({
    mode: 'project',
    projectRoot: root,
    localRoot: root,
    rawDir: join(root, 'raw'),
    rawAnswers: 'local',
  })
  const transport = options.transport ?? new FakeTransport(options.answers ?? ['first answer', 'second answer'])
  const engine = new ResearchEngine({
    store,
    transport,
    judge: options.judge ?? judgeWith(options.doneAt),
    config,
    pollIntervalMs: 10,
  })
  return { root, store, transport, engine, config }
}

describe('engine', () => {
  it('keeps waiting when fetch revokes completion instead of saving the poll snapshot', async () => {
    class ResumedGeneration extends FakeTransport {
      fetches = 0
      async fetch() {
        this.fetches += 1
        if (this.fetches <= 3) throw new TransportError('still generating', 'ui', { answerIncomplete: true })
        return { answer: 'complete answer after generation resumed' }
      }
    }
    const transport = new ResumedGeneration(['partial poll snapshot'])
    const judged: string[] = []
    const { engine, store } = await harness({ doneAt: 1, transport, judge: async input => {
      judged.push(input.answer)
      return judgeWith(1)(input)
    } })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await store.load(topic.id)).status).toBe('completed')
    expect(judged).toEqual(['complete answer after generation resumed'])
    expect(transport.submits).toHaveLength(1)
    await engine.dispose()
  })

  it('recognizes transport failures from another plugin bundle', async () => {
    const transport = new FakeTransport([])
    transport.submitFail = runInNewContext(`Object.assign(new Error('foreign UI failure'), { name: 'TransportError', failure: 'ui' })`)
    expect(transport.submitFail).not.toBeInstanceOf(TransportError)
    const { engine, store } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    const failed = await store.load(topic.id)
    expect(failed).toMatchObject({ status: 'stalled', stallReason: 'ui', stopReason: 'foreign UI failure' })
    expect(failed.rounds[0]).toMatchObject({ submissionState: 'unknown', dispatch: { attemptId: expect.any(String) } })
    await expect(engine.resume(topic.id)).rejects.toThrow(/无法重新附着/)
    expect(transport.submits).toHaveLength(1)
    await engine.dispose()
  })

  it('retries a proven pre-send failure in round two without reattaching round one', async () => {
    class PreSendFailure extends FakeTransport {
      failSecond = true
      async submit(request: SubmitRequest) {
        this.submitFail = this.failSecond && request.round === 2
          ? new TransportError('previous response is busy', 'ui', { submissionState: 'not_sent' })
          : undefined
        return super.submit(request)
      }
      async reattach(): Promise<never> { throw new Error('must not attach an earlier round') }
    }
    const transport = new PreSendFailure(['first', 'second', 'retry answer'])
    const { engine, store, config } = await harness({ doneAt: 2, transport })
    const topic = await engine.start(card())
    await engine.drain()
    const stopped = await store.load(topic.id)
    expect(stopped.status).toBe('stalled')
    expect(stopped.rounds).toHaveLength(2)
    expect(stopped.rounds[1]).toMatchObject({ attempts: 1, submissionState: 'not_sent' })
    expect(stopped.rounds[1]?.dispatch).toBeUndefined()
    const events = await readFile(join(await store.dirOf(topic.id), 'events.ndjson'), 'utf8')
    expect(events).toContain('submit_failed')
    expect(events).toContain('attemptId')
    await engine.dispose()
    transport.failSecond = false
    const restarted = new ResearchEngine({ store, transport, config, judge: judgeWith(2), pollIntervalMs: 10 })
    await restarted.resume(topic.id)
    await restarted.drain()
    const recovered = await store.load(topic.id)
    expect(recovered.status).toBe('completed')
    expect(recovered.rounds).toHaveLength(2)
    expect(recovered.rounds[1]?.attempts).toBe(2)
    expect(recovered.rounds[1]?.submissionState).toBeUndefined()
    expect(transport.submits.map(request => request.round)).toEqual([1, 2, 2])
    await restarted.dispose()
  })

  it('keeps human verification available for legacy failed submissions', async () => {
    const transport = new FakeTransport([])
    transport.submitFail = new Error('legacy failure')
    const { engine, store } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await store.load(topic.id)).status).toBe('failed')
    await expect(engine.humanCheck(topic.id, 'reopen', 'manually checked original conversation')).resolves.toMatchObject({ status: 'failed' })
    await engine.dispose()
  })
  it.each(['continue', 'regenerate', 'continue-restart', 'regenerate-restart'])('honors %s after failed judging without retrying the old verdict', async action => {
    const judged: number[] = []
    const judge: Judge = async input => {
      judged.push(input.round)
      if (input.round === 1) throw new Error('judge unavailable')
      return await judgeWith(2)(input)
    }
    const { engine, store, transport, config } = await harness({ doneAt: 2, judge })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await store.load(topic.id)).status).toBe('reviewing')
    const restart = action.endsWith('-restart')
    if (restart) await engine.dispose()
    if (action.startsWith('continue')) await engine.continue(topic.id, 'explicit new question')
    else await engine.regenerate(topic.id, 'explicit new question', 'new version')
    let runner = engine
    if (restart) {
      runner = new ResearchEngine({ store, transport, config, judge, pollIntervalMs: 10 })
      await runner.interrupt(topic.id, 'host restarted before dispatch')
      await runner.resume(topic.id)
    }
    await runner.drain()
    const final = await store.load(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds).toHaveLength(2)
    expect(final.rounds[0]).toMatchObject({ judgeError: 'judge unavailable', judgeSkippedAt: expect.any(String) })
    expect(final.rounds[0]?.verdict).toBeUndefined()
    expect(final.rounds[1]?.generation).toBe(action.startsWith('regenerate') ? 2 : 1)
    expect(judged).toEqual([1, 1, 2])
    expect(transport.submits).toHaveLength(2)
    expect(transport.submits[1]?.brief).toBe('explicit new question')
    await runner.dispose()
  })

  it.each(['missing', 'duplicate', 'mismatch', 'partial', 'unknown', 'no-evidence', 'contradiction'])('parks %s completion claims without sending another round', async invalid => {
    let calls = 0
    const judge: Judge = async () => {
      calls += 1
      let criteria = [
        { criterion: 'A', status: 'met' as const, evidence: 'answer A' },
        { criterion: 'B', status: 'met' as const, evidence: 'answer B' },
      ] as NonNullable<Awaited<ReturnType<Judge>>['criteria']>
      if (invalid === 'missing') criteria.pop()
      if (invalid === 'duplicate') criteria[1] = { ...criteria[0]! }
      if (invalid === 'mismatch') criteria[1]!.criterion = 'C'
      if (invalid === 'partial' || invalid === 'unknown') criteria[1]!.status = invalid
      if (invalid === 'no-evidence') criteria[1]!.evidence = ' '
      return { verdict: invalid === 'contradiction' ? 'partial' : 'accepted', done: true, reason: 'claimed done', summary: 'answer kept', criteria }
    }
    const { engine, store, transport } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card({ successCriteria: ['A', 'B'] }))
    await engine.drain()
    const result = await store.load(topic.id)
    expect(result.status).toBe('reviewing')
    expect(result.reviewFrom).toBe('answered')
    expect(result.rounds[0]?.judgeError).toContain('完成声明')
    expect(await store.readAnswer(result, 1)).toBe('fetched answer')
    expect(calls).toBe(2)
    expect(transport.submits).toHaveLength(1)
    await engine.accept(topic.id)
    expect((await engine.status(topic.id)).status).toBe('completed')
  })

  it('leaves visually unverified design output awaiting acceptance after a valid text verdict', async () => {
    const { engine, transport } = await harness({ doneAt: 1 })
    const topic = await engine.start(card({ type: 'design' }))
    await engine.drain()
    const result = await engine.status(topic.id)
    expect(result.status).toBe('capped')
    expect(result.stopReason).toContain('图片视觉效果待人工确认')
    expect(transport.submits).toHaveLength(1)
    expect(result.rounds[0]?.done).toBe(false)
  })

  it('keeps an explicit base-image retry to one image and one round', async () => {
    const { engine, store, root, transport } = await harness({ doneAt: 99 })
    const { topic } = await store.create(card({ type: 'design', designs: 3 }), 3, 'pro', 'web')
    topic.status = 'failed'
    topic.rounds = [
      { n: 1, files: 0, generation: 1, answeredAt: new Date().toISOString(), verdict: 'partial' },
      { n: 2, files: 0, generation: 1, designs: 3 },
    ]
    await store.save(topic)
    await writeFile(join(root, 'selected.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))
    const refs = (await buildManifest(root, ['selected.png'])).map(ref => ({ ...ref, source: join(root, ref.path) }))
    await engine.continue(topic.id, 'change background only', refs, 1, 'artifacts/round-01/image-02.png')
    await engine.drain()
    const result = await store.load(topic.id)
    expect(result.status).toBe('capped')
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[1]).toMatchObject({ designs: 1, baseArtifact: 'artifacts/round-01/image-02.png' })
    expect(transport.submits).toHaveLength(1)
    expect(transport.submits[0]?.designs).toBe(1)
    expect(transport.submits[0]?.files).toHaveLength(1)
    expect(transport.submits[0]?.fallbackFiles).toEqual(transport.submits[0]?.files)
  })

  it('renders per-criterion findings in the verdict document', async () => {
    const judge: Judge = async () => ({
      verdict: 'partial',
      reason: 'ok',
      done: false,
      summary: 'done',
      criteria: [
        { criterion: '覆盖两个市场', status: 'met', evidence: '答复第 2 节' },
        { criterion: '给出可执行流程', status: 'partial', evidence: '缺回滚步骤' },
      ],
    })
    const { engine, store } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card())
    await engine.drain()
    const dir = await store.dirOf(topic.id)
    const verdict = await readFile(join(dir, 'rounds', '01-verdict.md'), 'utf8')
    expect(verdict).toContain('| 覆盖两个市场 | 满足 | 答复第 2 节 |')
    expect(verdict).toContain('| 给出可执行流程 | 部分满足 | 缺回滚步骤 |')
  })

  it('runs rounds until the judge stops it', async () => {
    const { engine, store, transport } = await harness({ doneAt: 2 })
    const topic = await engine.start(card())
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds).toHaveLength(2)
    expect(transport.submits).toHaveLength(2)
    expect(transport.submits[0]?.brief).toContain('brief body')
    expect(transport.submits[1]?.brief).toContain('继续主题')
    const dir = await store.dirOf(topic.id)
    const document = await readFile(join(dir, 'final.md'), 'utf8')
    expect(document).toContain('summary 2')
    expect(document).toContain('状态：completed')
  })

  it('asks a design follow-up for a new direction and carries the image count', async () => {
    const { engine, transport } = await harness({ doneAt: 99, rounds: 2 })
    const topic = await engine.start(card({ type: 'design', designs: 2, rounds: 2 }))
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('capped')
    expect(transport.submits).toHaveLength(2)
    expect(transport.submits[0]?.designs).toBe(2)
    expect(transport.submits[1]?.brief).toContain('明显不同的新方向')
    expect(transport.submits[1]?.brief).not.toContain('只补充未决部分')
  })

  it('stores images and code blocks from the fetched answer', async () => {
    class AssetTransport extends FakeTransport {
      override async fetch() {
        return {
          answer: 'asset answer',
          images: [{
            name: 'hero.png',
            mime: 'image/png',
            base64: Buffer.from('png-bytes').toString('base64'),
          }],
          codeBlocks: [{ language: 'html', text: '<h1>demo</h1>' }],
        }
      }
    }
    const transport = new AssetTransport(['first answer'])
    const { engine, store } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.artifacts).toEqual(expect.arrayContaining([
      'artifacts/round-01/hero.png',
      'artifacts/round-01/code-01.html',
    ]))
    const dir = await store.dirOf(topic.id)
    expect(await readFile(join(dir, 'artifacts', 'round-01', 'hero.png'), 'utf8')).toBe('png-bytes')
    expect(await readFile(join(dir, 'artifacts', 'round-01', 'code-01.html'), 'utf8')).toContain('<h1>demo</h1>')
  })

  it('stops early when the first round satisfies the criteria', async () => {
    const { engine } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds).toHaveLength(1)
  })

  it('caps at the configured round limit', async () => {
    const { engine } = await harness({ doneAt: 99, rounds: 2 })
    const topic = await engine.start(card({ rounds: 2 }))
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('capped')
    expect(final.rounds).toHaveLength(2)
    expect(final.stopReason).toBe('reason 2')
  })

  it('stalls on a transport UI failure and resumes without resubmitting', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.fail = new TransportError('page changed', 'ui')
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    const stalled = await engine.status(topic.id)
    expect(stalled.status).toBe('stalled')
    expect(stalled.stallReason).toBe('ui')
    expect(stalled.stopReason).toContain('page changed')

    transport.fail = undefined
    await engine.resume(topic.id)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(transport.submits).toHaveLength(1)
  })

  it('records the worker failure message on failed topics', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.fail = new TransportError('cannot launch Chrome with profile X', 'worker')
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    const failed = await engine.status(topic.id)
    expect(failed.status).toBe('failed')
    expect(failed.stopReason).toContain('cannot launch Chrome')
  })

  it('resubmits only after a human confirms the submission was not made', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.fail = new TransportError('page changed', 'ui')
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()

    await engine.humanCheck(topic.id, 'not_submitted', 'checked the page: nothing was sent')
    transport.fail = undefined
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(transport.submits).toHaveLength(2)
  })

  it('continues polling after a human confirms the submission was made', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.fail = new TransportError('page changed', 'ui')
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('stalled')

    await engine.humanCheck(topic.id, 'submitted', 'saw the message in the conversation')
    transport.fail = undefined
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(transport.submits).toHaveLength(1)
  })

  it('parks a judge failure for review and resumes without resubmitting', async () => {
    let calls = 0
    const judge: Judge = async () => {
      calls += 1
      if (calls <= 2) throw new Error('judge unavailable')
      return { verdict: 'accepted', reason: 'ok', done: true, summary: 'done', criteria: [{ criterion: 'one criterion', status: 'met', evidence: 'answer' }] }
    }
    const { engine, store, transport } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card())
    await engine.drain()
    const parked = await engine.status(topic.id)
    expect(parked.status).toBe('reviewing')
    expect(parked.reviewFrom).toBe('answered')
    expect(parked.stopReason).toContain('judge unavailable')
    expect(parked.rounds[0]?.judgeError).toBe('judge unavailable')

    const dir = await store.dirOf(topic.id)
    const verdict = await readFile(join(dir, 'rounds', '01-verdict.md'), 'utf8')
    expect(verdict).toContain('未完成自动裁决')
    expect(verdict).toContain('| 判据 | 状态 | 依据 |')
    expect(await store.readAnswer(topic, 1)).toBe('fetched answer')

    await engine.resume(topic.id)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(transport.submits).toHaveLength(1)
  })

  it('accepts a judge-failed answer without treating it as a run failure', async () => {
    const judge: Judge = async () => { throw new Error('model returned prose') }
    const { engine, transport } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card())
    await engine.drain()
    const parked = await engine.status(topic.id)
    expect(parked.status).toBe('reviewing')
    expect(parked.reviewFrom).toBe('answered')

    const accepted = await engine.accept(topic.id)
    expect(accepted.status).toBe('completed')
    expect(accepted.stopReason).toBe('人工接受结果')
    expect(transport.submits).toHaveLength(1)
  })

  it('adjudicates an on-disk answer without touching the transport', async () => {
    let calls = 0
    const judge: Judge = async () => {
      calls += 1
      if (calls <= 2) throw new Error('judge unavailable')
      return { verdict: 'accepted', reason: 'ok', done: true, summary: 'done', criteria: [{ criterion: 'one criterion', status: 'met', evidence: 'answer' }] }
    }
    class ReattachTransport extends FakeTransport {
      reattachCalls = 0
      async reattach(): Promise<never> {
        this.reattachCalls += 1
        throw new Error('reattach must not run for a local adjudication')
      }
    }
    const transport = new ReattachTransport(['first answer'])
    const { engine } = await harness({ doneAt: 1, judge, transport })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('reviewing')

    await engine.resume(topic.id)
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('completed')
    expect(transport.reattachCalls).toBe(0)
    expect(transport.submits).toHaveLength(1)
  })

  it('cancels a run that is aborted between rounds', async () => {
    let releaseJudge: () => void = () => {}
    const judge: Judge = async () => {
      await new Promise<void>(resolve => { releaseJudge = resolve })
      return { verdict: 'partial', reason: 'more', done: false, summary: 'more' }
    }
    const { engine } = await harness({ doneAt: 99, judge })
    const topic = await engine.start(card())
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const current = await engine.status(topic.id).catch(() => undefined)
      if (current?.status === 'adjudicating') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const cancelling = engine.cancel(topic.id)
    releaseJudge()
    await cancelling
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('cancelled')
  })

  it('refuses human_check submitted when the round was never dispatched', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.submitFail = new TransportError('network dropped during submit', 'network')
    const { engine, store } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('stalled')

    // The failed submit left a dispatch; clear it to reach the no-record branch.
    const stalled = await store.load(topic.id)
    delete stalled.rounds[0]?.dispatch
    await store.save(stalled)

    await expect(engine.humanCheck(topic.id, 'submitted', 'no submission record exists'))
      .rejects.toThrow(/没有任何提交记录/)
  })

  it('refuses human_check submitted when a reattach-less transport lost the job', async () => {
    class LostTransport extends FakeTransport {
      override async poll(): Promise<PollResult> {
        return { state: 'unknown' }
      }
    }
    const transport = new LostTransport(['first answer'])
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    // poll never sees the submission: the round stalls with only a submission id.
    expect((await engine.status(topic.id)).status).toBe('stalled')

    await expect(engine.humanCheck(topic.id, 'submitted', 'the job is gone after a restart'))
      .rejects.toThrow(/无法接管核对/)
  })

  it('resumes an api topic only while its job is still alive', async () => {
    class ApiTransport extends FakeTransport {
      lost = false
      override async poll(request: { submissionId: string; signal?: AbortSignal }): Promise<PollResult> {
        if (this.lost) return { state: 'unknown' }
        return await super.poll(request)
      }
    }
    const transport = new ApiTransport(['first answer'])
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-engine-'))
    cleanups.push(root)
    const config = { ...defaultConfig(root), channel: 'api' as const, maxRoundMinutes: 1, stallMinutes: 1 }
    const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: root, rawDir: join(root, 'raw'), rawAnswers: 'local' })
    const alwaysDone: Judge = async () => ({ verdict: 'accepted', reason: 'ok', done: true, summary: 'done', criteria: [{ criterion: 'one criterion', status: 'met', evidence: 'answer' }] })
    const engine = new ResearchEngine({ store, transport, judge: alwaysDone, config, pollIntervalMs: 10 })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('completed')

    // Simulate a failed second round whose in-flight job is still alive.
    const resurrect = await store.load(topic.id)
    resurrect.status = 'stalled'
    resurrect.stallReason = 'timeout'
    resurrect.rounds.push({ n: 2, files: 0, submissionId: 'sub-live', attempts: 1 })
    await store.save(resurrect)
    await engine.resume(topic.id)
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('completed')
    expect(transport.submits).toHaveLength(1)

    // Once the job is gone, resume refuses instead of stalling again.
    const lost = await store.load(topic.id)
    lost.status = 'stalled'
    lost.stallReason = 'unknown_submission'
    lost.rounds.push({ n: 3, files: 0, submissionId: 'sub-gone', attempts: 1 })
    await store.save(lost)
    transport.lost = true
    await expect(engine.resume(topic.id)).rejects.toThrow(/已丢失，无法接管/)
  })


  it('adds an explicit follow-up round to a completed topic', async () => {
    const judge: Judge = async () => ({ verdict: 'accepted', reason: 'enough', done: true, summary: 'done', criteria: [{ criterion: 'one criterion', status: 'met', evidence: 'answer' }] })
    const { engine, store, transport } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card({ materials: [{ path: 'base.md', bytes: 1, sha256: 'b' }] }))
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('completed')
    expect(transport.submits[0]?.files.map(path => basename(path))).toEqual(['base.md'])

    await engine.continue(topic.id, 'follow-up brief', [{ path: 'new.md', bytes: 1, sha256: 'x' }])
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds).toHaveLength(2)
    expect(transport.submits).toHaveLength(2)
    expect(transport.submits[1]?.files.map(path => basename(path))).toEqual(['new.md'])
    expect(transport.submits[1]?.fallbackFiles?.map(path => basename(path))).toEqual(['base.md', 'new.md'])
    expect(transport.submits[1]?.session?.conversationUrl).toBe('https://chatgpt.com/c/example')
    expect(final.rounds[1]?.files).toBe(1)
    const dir = await store.dirOf(topic.id)
    expect(await readFile(join(dir, 'rounds', '02-question.md'), 'utf8')).toContain('follow-up brief')
  })

  it('hands a capped result to review and can return it', async () => {
    const { engine } = await harness({ doneAt: 99, rounds: 1 })
    const topic = await engine.start(card({ rounds: 1 }))
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('capped')

    const reviewing = await engine.markReviewing(topic.id)
    expect(reviewing.status).toBe('reviewing')
    const returned = await engine.cancelReview(topic.id)
    expect(returned.status).toBe('capped')
    const accepted = await engine.accept(topic.id)
    expect(accepted.status).toBe('completed')
  })

  it('accepts a capped topic as completed', async () => {
    const { engine } = await harness({ doneAt: 99, rounds: 1 })
    const topic = await engine.start(card({ rounds: 1 }))
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('capped')

    const accepted = await engine.accept(topic.id)
    expect(accepted.status).toBe('completed')
    expect(accepted.stopReason).toBe('人工接受结果')
  })

  it('accepts a failed topic that still has artifacts', async () => {
    const { engine, store } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const failed = await store.load(topic.id)
    failed.status = 'failed'
    failed.artifacts = ['artifacts/round-01/image-01.png']
    failed.stopReason = 'page closed'
    await store.save(failed)

    const accepted = await engine.accept(topic.id)
    expect(accepted.status).toBe('completed')
    expect(accepted.stopReason).toBe('人工接受结果')
    const dir = await store.dirOf(topic.id)
    const document = await readFile(join(dir, 'final.md'), 'utf8')
    expect(document).toContain('人工接受')
  })

  it('returns a failed review handoff to failed, not capped', async () => {
    const { engine, store } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const failed = await store.load(topic.id)
    failed.status = 'failed'
    failed.artifacts = ['artifacts/round-01/image-01.png']
    await store.save(failed)

    expect((await engine.markReviewing(topic.id)).status).toBe('reviewing')
    expect((await engine.cancelReview(topic.id)).status).toBe('failed')
    expect((await engine.accept(topic.id)).status).toBe('completed')
  })

  it('restores a stalled review handoff with its stall reason', async () => {
    const { engine, store } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const stalled = await store.load(topic.id)
    stalled.status = 'stalled'
    stalled.stallReason = 'ui'
    stalled.stopReason = 'page changed'
    await store.save(stalled)

    expect((await engine.markReviewing(topic.id)).status).toBe('reviewing')
    const restored = await engine.cancelReview(topic.id)
    expect(restored.status).toBe('stalled')
    expect(restored.stallReason).toBe('ui')
    expect(restored.stopReason).toBe('page changed')
  })

  it('records regeneration as a new generation and archives the previous final', async () => {
    const { engine, store } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const dir = await store.dirOf(topic.id)
    expect(await readFile(join(dir, 'finals', 'attempt-01.md'), 'utf8')).toContain('状态：completed')

    const regenerated = await engine.regenerate(topic.id, '换一个方向', '上一版太保守')
    expect(regenerated.status).toBe('queued')
    expect(regenerated.generations?.map(item => item.n)).toEqual([1, 2])
    expect(regenerated.generations?.[1]?.reason).toBe('上一版太保守')
    expect(regenerated.generations?.[1]?.rounds).toBe(3)
    expect(await readFile(join(dir, 'rounds', '02-question.md'), 'utf8')).toContain('换一个方向')

    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.rounds[0]?.generation).toBe(1)
    expect(final.rounds[1]?.generation).toBe(2)
    expect(final.rounds.filter(round => round.generation === 2)).toHaveLength(3)
    expect(await readFile(join(dir, 'finals', 'attempt-01.md'), 'utf8')).toContain('状态：completed')
  })

  it('treats the legacy web-pro channel as web', async () => {
    const { engine, store } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const legacy = await store.load(topic.id)
    legacy.channel = 'web-pro'
    await store.save(legacy)

    await engine.continue(topic.id, 'continue on a legacy topic')
    await engine.drain()
    expect(['completed', 'capped']).toContain((await engine.status(topic.id)).status)
  })

  it('stages follow-up materials and records absolute paths for that round', async () => {
    const { engine, store, root } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    await writeFile(join(root, 'new.md'), 'new material', 'utf8')
    const refs = await buildManifest(root, ['new.md'])
    if (refs[0] !== undefined) refs[0].source = join(root, 'new.md')

    await engine.continue(topic.id, 'use the new material', refs)
    await engine.drain()
    const final = await engine.status(topic.id)
    const materials = await store.readRoundMaterials(final, 2)
    expect(materials).toHaveLength(1)
    expect(isAbsolute(materials?.[0]?.path ?? '')).toBe(true)
    expect(await readFile(materials?.[0]?.path ?? '', 'utf8')).toBe('new material')
  })

  it('persists dispatch intent before submit and refuses auto-resend after an unknown result', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.submitFail = new TransportError('network dropped during submit', 'network')
    const { engine, store } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()

    const stalled = await store.load(topic.id)
    expect(stalled.status).toBe('stalled')
    expect(stalled.rounds[0]?.dispatch?.attemptId).toBeTruthy()
    expect(stalled.rounds[0]?.dispatch?.observedAt).toBeUndefined()
    expect(stalled.rounds[0]?.submissionId).toBeUndefined()
    const firstAttempt = stalled.rounds[0]?.dispatch?.attemptId

    await expect(engine.resume(topic.id)).rejects.toThrow(/人工核对|无法确认|可能已经提交/)
    await expect(engine.continue(topic.id, 'feedback without checking')).rejects.toThrow(/人工核对/)

    transport.submitFail = undefined
    await engine.humanCheck(topic.id, 'not_submitted', 'checked the page: no user turn was added')
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds[0]?.dispatch?.attemptId).not.toBe(firstAttempt)
    expect(final.rounds[0]?.dispatch?.observedAt).toBeTruthy()
    expect(transport.submits).toHaveLength(2)
  })

  it('retries the unanswered round with the follow-up brief after a stall', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.fail = new TransportError('page changed', 'ui')
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('stalled')

    transport.fail = undefined
    await engine.continue(topic.id, 'new feedback after the stall')
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds).toHaveLength(1)
    expect(transport.submits[transport.submits.length - 1]?.brief).toContain('new feedback after the stall')
  })

  it('raises the cap when a capped topic is continued', async () => {
    const { engine, transport } = await harness({ doneAt: 99, rounds: 2 })
    const topic = await engine.start(card({ rounds: 2 }))
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('capped')

    await engine.continue(topic.id, 'one more question')
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.roundsCap).toBe(3)
    expect(final.rounds).toHaveLength(3)
    expect(final.status).toBe('capped')
    expect(transport.submits).toHaveLength(3)
  })

  it('treats one continue as one authorized round after an early completion', async () => {
    let calls = 0
    const judge: Judge = async () => {
      calls += 1
      return calls === 1
        ? { verdict: 'accepted', reason: 'enough', done: true, summary: 'done', criteria: [{ criterion: 'one criterion', status: 'met', evidence: 'answer' }] }
        : { verdict: 'partial', reason: 'more needed', done: false, summary: 'more' }
    }
    const { engine, transport } = await harness({ doneAt: 1, rounds: 3, judge })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('completed')

    await engine.continue(topic.id, 'one more question')
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.rounds).toHaveLength(2)
    expect(final.roundsCap).toBe(3)
    expect(final.status).toBe('capped')
    expect(transport.submits).toHaveLength(2)
  })

  it('carries a per-round design count on continue', async () => {
    const { engine, transport } = await harness({ doneAt: 99, rounds: 3 })
    const topic = await engine.start(card({ type: 'design', designs: 3, rounds: 1 }))
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('capped')

    await engine.continue(topic.id, 'one direction only', undefined, 1)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(transport.submits[1]?.designs).toBe(1)
    expect(final.rounds[1]?.designs).toBe(1)
    expect(final.status).toBe('capped')
  })

  it('cancels an in-flight run', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.hang = true
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    const deadline = Date.now() + 2_000
    while (!transport.polling && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await engine.cancel(topic.id)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('cancelled')
  })

  it('stops an active run when the engine is disposed', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.hang = true
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    const deadline = Date.now() + 2_000
    while (!transport.polling && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    engine.dispose()
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('cancelled')
  })

  it('parks an image-only answer whose assets cannot be fetched instead of completing empty', async () => {
    const transport = new FakeTransport(['ignored'])
    transport.imageFingerprint = true
    transport.fetchFail = new TransportError('page closed', 'ui')
    const { engine, store } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('stalled')
    expect(final.stallReason).toBe('ui')
    expect(final.rounds[0]?.answeredAt).toBeUndefined()
    expect(await store.readAnswer(final, 1)).toBeUndefined()
  })

  it('waits out an already-clicked submit and cancels the submission it created', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.submitDelay = 60
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    const deadline = Date.now() + 2_000
    while (transport.submits.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(transport.submits).toHaveLength(1)
    const cancelled = await engine.cancel(topic.id)
    expect(cancelled.status).toBe('cancelled')
    expect(transport.canceled).toContain('sub-1')
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('cancelled')
  })

  it('records the answer hash and append-only status/answer events', async () => {
    const { engine, store } = await harness({ doneAt: 1 })
    const topic = await engine.start(card())
    await engine.drain()
    const dir = await store.dirOf(topic.id)
    const receipt = JSON.parse(await readFile(join(dir, 'receipts', '01.json'), 'utf8')) as {
      answerSha256?: string
      answeredAt?: string
    }
    expect(receipt.answerSha256).toHaveLength(64)
    expect(receipt.answeredAt).toBeTruthy()
    const events = await readFile(join(dir, 'events.ndjson'), 'utf8')
    expect(events).toContain('"type":"status"')
    expect(events).toContain('"type":"answered"')
    const history = await readFile(join(dir, 'receipts', 'history.ndjson'), 'utf8')
    expect(history).toContain('"answerSha256"')
  })
})
