import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchEngine } from '../src/engine.ts'
import { ResearchStore } from '../src/store.ts'
import { defaultConfig } from '../src/config.ts'
import { TransportError, type Judge, type ResearchCard, type SubmitRequest, type Transport } from '../src/types.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

class FakeTransport implements Transport {
  submits: SubmitRequest[] = []
  fail?: Error
  hang = false
  private seq = 0

  constructor(private readonly answers: string[]) {}

  async probe() {
    return { ok: true, loggedIn: true, model: 'pro', available: ['pro'] }
  }

  async submit(request: SubmitRequest) {
    this.submits.push(request)
    this.seq += 1
    return {
      submissionId: `sub-${this.seq}`,
      fingerprint: `fp-${this.seq}`,
      attachments: request.files,
      conversationUrl: 'https://chatgpt.com/c/example',
    }
  }

  async poll(request: { submissionId: string; signal?: AbortSignal }) {
    if (this.hang) {
      return await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    if (this.fail !== undefined) throw this.fail
    const n = Number(request.submissionId.split('-')[1])
    return { state: 'answered' as const, answer: this.answers[n - 1] ?? `answer ${n}` }
  }

  async fetch() {
    return { answer: 'fetched answer' }
  }

  async cancel(): Promise<void> {}
}

function judgeWith(doneAt: number): Judge {
  return async ({ round }) => ({
    verdict: round === doneAt ? 'accepted' : 'partial',
    reason: `reason ${round}`,
    done: round === doneAt,
    summary: `summary ${round}`,
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

    transport.fail = undefined
    await engine.resume(topic.id)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(transport.submits).toHaveLength(1)
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

  it('resumes adjudication without resubmitting when the judge fails', async () => {
    let calls = 0
    const judge: Judge = async () => {
      calls += 1
      if (calls === 1) throw new Error('judge unavailable')
      return { verdict: 'accepted', reason: 'ok', done: true, summary: 'done' }
    }
    const { engine, transport } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card())
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('failed')

    await engine.resume(topic.id)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(transport.submits).toHaveLength(1)
  })

  it('adds an explicit follow-up round to a completed topic', async () => {
    const judge: Judge = async () => ({ verdict: 'accepted', reason: 'enough', done: true, summary: 'done' })
    const { engine, store, transport } = await harness({ doneAt: 1, judge })
    const topic = await engine.start(card({ materials: [{ path: 'base.md', bytes: 1, sha256: 'b' }] }))
    await engine.drain()
    expect((await engine.status(topic.id)).status).toBe('completed')
    expect(transport.submits[0]?.files).toEqual(['base.md'])

    await engine.continue(topic.id, 'follow-up brief', [{ path: 'new.md', bytes: 1, sha256: 'x' }])
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('completed')
    expect(final.rounds).toHaveLength(2)
    expect(transport.submits).toHaveLength(2)
    expect(transport.submits[1]?.files).toEqual(['new.md'])
    expect(transport.submits[1]?.fallbackFiles).toEqual(['base.md', 'new.md'])
    expect(transport.submits[1]?.session?.conversationUrl).toBe('https://chatgpt.com/c/example')
    expect(final.rounds[1]?.files).toBe(1)
    const dir = await store.dirOf(topic.id)
    expect(await readFile(join(dir, 'rounds', '02-question.md'), 'utf8')).toContain('follow-up brief')
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

  it('cancels an in-flight run', async () => {
    const transport = new FakeTransport(['first answer'])
    transport.hang = true
    const { engine } = await harness({ doneAt: 1, transport })
    const topic = await engine.start(card())
    await new Promise(resolve => setTimeout(resolve, 30))
    await engine.cancel(topic.id)
    await engine.drain()
    const final = await engine.status(topic.id)
    expect(final.status).toBe('cancelled')
  })
})
