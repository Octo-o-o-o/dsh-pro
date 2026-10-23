import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchEngine } from '../src/engine.ts'
import { ResearchStore } from '../src/store.ts'
import { defaultConfig } from '../src/config.ts'
import { buildManifest } from '../src/materials.ts'
import { TransportError, type Judge, type ResearchCard, type SubmitRequest, type Transport } from '../src/types.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

class FakeTransport implements Transport {
  submits: SubmitRequest[] = []
  fail?: Error
  hang = false
  polling = false
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
    this.polling = true
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
})
