import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.ts'
import { ResearchEngine } from '../src/engine.ts'
import { ResearchStore } from '../src/store.ts'
import type { Judge, ResearchCard, SubmitRequest, Transport } from '../src/types.ts'

it('archives acceptance under the new generation when its first round fails before being recorded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-final-archive-regression-'))
  const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: root, rawDir: join(root, 'raw'), rawAnswers: 'local' })
  const submissions: SubmitRequest[] = []
  const transport: Transport = {
    probe: async () => ({ ok: true, loggedIn: true, model: 'pro', available: ['pro'] }),
    submit: async request => {
      submissions.push(request)
      return { submissionId: `fixture-${request.round}`, fingerprint: `fp-${request.round}`, attachments: [], conversationUrl: 'https://chatgpt.com/c/local-fixture' }
    },
    poll: async () => ({ state: 'answered' }),
    fetch: async () => ({ answer: 'original generation evidence' }),
    cancel: async () => {},
  }
  const judge: Judge = async input => ({
    verdict: 'accepted', done: true, reason: 'criterion met', summary: 'ORIGINAL GENERATION SUMMARY',
    criteria: input.criteria.map(criterion => ({ criterion, status: 'met', evidence: 'original generation evidence' })),
  })
  const engine = new ResearchEngine({ store, transport, judge, config: { ...defaultConfig(root), rounds: 1 }, pollIntervalMs: 1 })
  const card: ResearchCard = { title: 'Retained final archive', type: 'research', question: 'fixture question', successCriteria: ['criterion'], brief: 'initial fixture task', materials: [], rounds: 1, store: 'project' }
  try {
    const started = await engine.start(card)
    await engine.drain()
    const initial = await store.load(started.id)
    expect(initial.status).toBe('completed')
    const dir = await store.dirOf(initial.id)
    const firstArchive = join(dir, 'finals', 'attempt-01.md')
    const original = await readFile(firstArchive, 'utf8')
    expect(original).toContain('ORIGINAL GENERATION SUMMARY')

    // The new generation is already persisted by regenerate(), but runTopic
    // reads its question before saving its first RoundRecord. A real I/O error
    // at this boundary leaves generations[-1]=2 and rounds[-1].generation=1.
    const readQuestion = store.readQuestion.bind(store)
    vi.spyOn(store, 'readQuestion').mockImplementation(async (topic, round) => {
      if (round === 2) throw new Error('fixture I/O failure before the new round was recorded')
      return await readQuestion(topic, round)
    })
    await engine.regenerate(initial.id, 'new generation task', 'user requested another version')
    await engine.drain()
    const failed = await store.load(initial.id)
    expect(failed.status).toBe('failed')
    expect(failed.generations?.at(-1)?.n).toBe(2)
    expect(failed.rounds.map(round => round.generation)).toEqual([1])
    expect(submissions.map(request => request.round)).toEqual([1])

    const accepted = await engine.accept(initial.id)
    expect(accepted.status).toBe('completed')
    expect(await readFile(firstArchive, 'utf8')).toBe(original)
    const latest = await readFile(join(dir, 'finals', 'attempt-02.md'), 'utf8')
    expect(latest).toContain('<!-- dsh-pro-final: {"generation":2,"throughRound":1} -->')
    expect(latest).toContain('（未生成摘要；见各轮裁决与原始答复）')
    expect(latest).not.toContain('ORIGINAL GENERATION SUMMARY')
    expect(accepted.generations?.find(generation => generation.n === 1)?.final).toBe('finals/attempt-01.md')
    expect(accepted.generations?.find(generation => generation.n === 2)?.final).toBe('finals/attempt-02.md')
    expect((await store.load(initial.id)).generations?.at(-1)?.final).toBe('finals/attempt-02.md')
    expect(await readFile(join(dir, 'final.md'), 'utf8')).toBe(latest)
    expect(submissions.map(request => request.round)).toEqual([1])
  } finally {
    vi.restoreAllMocks()
    engine.dispose()
    await engine.drain()
    await rm(root, { recursive: true, force: true })
  }
})
