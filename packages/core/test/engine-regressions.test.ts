import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.ts'
import { ResearchEngine } from '../src/engine.ts'
import { ResearchStore } from '../src/store.ts'
import type { EngineEvent, Judge, ResearchCard, RoundRecord, SubmitRequest, Transport } from '../src/types.ts'

const roots: string[] = []
const engines: ResearchEngine[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) {
    engine.dispose()
    await engine.settle()
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class FakeTransport implements Transport {
  submits: SubmitRequest[] = []
  attaches = 0
  cancelled = deferred()

  async probe() { return { ok: true, loggedIn: true, model: 'pro', available: ['pro'] } }
  async submit(request: SubmitRequest) {
    this.submits.push(request)
    return { submissionId: `sub-${request.round}`, fingerprint: `fp-${request.round}`, attachments: request.files, conversationUrl: 'https://chatgpt.com/c/fixture' }
  }
  async reattach() { this.attaches += 1; return { attached: true, submissionId: 'old-submission' } }
  async poll() { return { state: 'answered' as const } }
  async fetch() { return { answer: 'saved response evidence' } }
  async cancelSubmission() { this.cancelled.resolve() }
  async cancel() {}
}

function card(rounds: number): ResearchCard {
  return { title: 'Engine regression', type: 'research', question: 'question', successCriteria: ['criterion'], brief: 'initial brief', materials: [], rounds, store: 'project' }
}

const partial: Judge = async () => ({ verdict: 'partial', done: false, reason: 'more evidence needed', summary: 'current partial summary' })
const accepted: Judge = async input => ({ verdict: 'accepted', done: true, reason: 'met', summary: 'current accepted summary', criteria: input.criteria.map(criterion => ({ criterion, status: 'met', evidence: 'saved response evidence' })) })

async function fixture(rounds: number, judge: Judge = partial, onEvent?: (event: EngineEvent) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-engine-regression-'))
  roots.push(root)
  const config = { ...defaultConfig(root), rounds }
  const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: root, rawDir: join(root, 'raw'), rawAnswers: 'local' })
  const transport = new FakeTransport()
  const engine = new ResearchEngine({ store, transport, judge, config, pollIntervalMs: 1, onEvent })
  engines.push(engine)
  const { topic, dir } = await store.create(card(rounds), rounds, 'pro', 'web')
  return { store, transport, engine, topic, dir }
}

function answered(n: number, generation = 1): RoundRecord {
  return { n, generation, files: 0, submittedAt: '2026-01-01T00:00:00.000Z', answeredAt: '2026-01-01T00:01:00.000Z', submissionId: `old-${n}`, verdict: 'partial', done: false }
}

it('resumes the next authorized round after a restart between verdict and dispatch', async () => {
  const { store, transport, engine, topic } = await fixture(2)
  topic.rounds = [answered(1)]
  topic.status = 'queued'
  topic.nextBrief = 'judge-authored next question'
  await store.writeQuestion(topic, 1, 'original question')
  await store.writeAnswer(topic, 1, 'original answer')
  await store.writeLocator(topic.id, { conversationUrl: 'https://chatgpt.com/c/fixture', profileDir: 'unused' })
  await store.save(topic)
  await engine.interrupt(topic.id, 'host restarted before the next dispatch')

  await engine.resume(topic.id)
  await engine.drain()

  const actual = await store.load(topic.id)
  expect(actual.status).toBe('capped')
  expect(actual.rounds.map(round => round.n)).toEqual([1, 2])
  expect(transport.attaches).toBe(0)
  expect(transport.submits.map(request => request.round)).toEqual([2])
  expect(transport.submits[0]?.brief).toBe('judge-authored next question')
  expect(await store.readAnswer(actual, 1)).toBe('original answer')
})

it.each(['initial-budget', 'single-follow-up', 'later-generation'] as const)('does not expand the authorized ceiling when retrying %s', async scenario => {
  const { store, transport, engine, topic } = await fixture(3)
  topic.status = 'stalled'
  topic.stallReason = 'ui'
  if (scenario === 'initial-budget') {
    topic.rounds = [answered(1), answered(2), { n: 3, generation: 1, files: 0, attempts: 1, submissionState: 'not_sent' }]
  } else if (scenario === 'single-follow-up') {
    topic.rounds = [answered(1), { n: 2, generation: 1, files: 0, attempts: 1, submissionState: 'not_sent' }]
    topic.runThrough = 2
  } else {
    topic.generations?.push({ n: 2, createdAt: '2026-01-02T00:00:00.000Z', rounds: 3 })
    topic.rounds = [answered(1), answered(2), answered(3), answered(4, 2), answered(5, 2), { n: 6, generation: 2, files: 0, attempts: 1, submissionState: 'not_sent' }]
    topic.roundsCap = 6
    topic.runThrough = 6
  }
  const round = topic.rounds.at(-1)!.n
  const cap = topic.roundsCap
  await store.writeQuestion(topic, round, 'failed question')
  await store.save(topic)

  await engine.continue(topic.id, 'retry the failed question')
  await engine.drain()

  const actual = await store.load(topic.id)
  expect(actual.status).toBe('capped')
  expect(actual.roundsCap).toBe(cap)
  expect(actual.rounds.at(-1)?.n).toBe(round)
  expect(transport.submits.map(request => request.round)).toEqual([round])
})

it('retains the remaining initial budget when retrying its first round', async () => {
  const { store, transport, engine, topic } = await fixture(3)
  topic.status = 'stalled'
  topic.rounds = [{ n: 1, generation: 1, files: 0, submissionState: 'not_sent' }]
  await store.writeQuestion(topic, 1, 'failed question')
  await store.save(topic)

  await engine.continue(topic.id, 'retry the first round')
  await engine.drain()

  expect(transport.submits.map(request => request.round)).toEqual([1, 2, 3])
  expect((await store.load(topic.id)).roundsCap).toBe(3)
})

it.each([
  { result: 'accepted', attempt: 1 },
  { result: 'partial', attempt: 1 },
  { result: 'error', attempt: 1 },
  { result: 'accepted', attempt: 2 },
  { result: 'partial', attempt: 2 },
  { result: 'error', attempt: 2 },
] as const)('keeps cancellation authoritative during judge attempt $attempt returning $result', async ({ result, attempt }) => {
  const entered = deferred()
  const release = deferred()
  let calls = 0
  let observedSignal: AbortSignal | undefined
  const judge: Judge = async input => {
    calls += 1
    if (calls < attempt) throw new Error('transient judge failure')
    observedSignal = input.signal
    entered.resolve()
    await release.promise
    if (result === 'error') throw new Error('judge failed after cancellation')
    return await (result === 'accepted' ? accepted : partial)(input)
  }
  const { store, transport, engine, topic } = await fixture(1, judge)
  topic.status = 'answered'
  const round = answered(1)
  delete round.verdict
  delete round.done
  topic.rounds = [round]
  await store.writeQuestion(topic, 1, 'question')
  await store.writeAnswer(topic, 1, 'answer that must survive cancellation')
  await store.save(topic)
  const verdictWrites = vi.spyOn(store, 'writeVerdict')
  const finalWrites = vi.spyOn(store, 'writeFinal')

  await engine.resume(topic.id)
  await entered.promise
  const cancellation = engine.cancel(topic.id)
  await transport.cancelled.promise
  release.resolve()
  const cancelled = await cancellation
  await engine.drain()

  expect(cancelled.status).toBe('cancelled')
  expect((await store.load(topic.id)).status).toBe('cancelled')
  expect(observedSignal?.aborted).toBe(true)
  expect(calls).toBe(attempt)
  expect(verdictWrites).not.toHaveBeenCalled()
  expect(finalWrites).not.toHaveBeenCalled()
  expect(await store.readAnswer(topic, 1)).toBe('answer that must survive cancellation')
})

it.each([
  { status: 'completed', phase: 'before-save' },
  { status: 'capped', phase: 'before-save' },
  { status: 'reviewing', phase: 'before-save' },
  { status: 'completed', phase: 'after-save' },
  { status: 'capped', phase: 'after-save' },
  { status: 'reviewing', phase: 'after-save' },
] as const)('keeps a running cancellation authoritative during $status $phase', async ({ status, phase }) => {
  const entered = deferred()
  const release = deferred()
  const events: EngineEvent[] = []
  const judge: Judge = status === 'completed' ? accepted : status === 'capped' ? partial : async () => { throw new Error('judge unavailable') }
  const { store, transport, engine, topic } = await fixture(1, judge, event => events.push(event))
  topic.status = 'answered'
  const round = answered(1)
  delete round.verdict
  delete round.done
  topic.rounds = [round]
  await store.writeQuestion(topic, 1, 'question')
  await store.writeAnswer(topic, 1, 'answer survives a terminal-save cancellation')
  await store.save(topic)
  const save = store.save.bind(store)
  let held = false
  vi.spyOn(store, 'save').mockImplementation(async current => {
    if (!held && current.status === status) {
      held = true
      if (phase === 'after-save') await save(current)
      entered.resolve()
      await release.promise
      if (phase === 'after-save') return
    }
    await save(current)
  })

  await engine.resume(topic.id)
  await entered.promise
  const cancellation = engine.cancel(topic.id)
  // An unfixed completed branch returns immediately instead of aborting. Keep
  // that path observable without hanging this regression behind its barrier.
  await Promise.race([transport.cancelled.promise, cancellation.then(() => undefined)])
  const afterCancel = events.length
  release.resolve()
  const actual = await cancellation
  await engine.drain()

  expect(actual.status).toBe('cancelled')
  const persisted = await store.load(topic.id)
  expect(persisted.status).toBe('cancelled')
  expect(persisted.reviewFrom).toBeUndefined()
  expect(events.slice(afterCancel).filter(event => event.type === 'finished' || event.type === 'judge_failed')).toEqual([])
  expect(events.slice(afterCancel).filter(event => event.type === 'status' && ['completed', 'capped', 'reviewing'].includes(event.status))).toEqual([])
  expect(await store.readAnswer(topic, 1)).toBe('answer survives a terminal-save cancellation')
})

it('leaves a completed topic unchanged when cancellation has no owning runner', async () => {
  const { store, engine } = await fixture(1, accepted)
  const topic = await engine.start(card(1))
  await engine.drain()
  const writes = vi.spyOn(store, 'save')

  expect((await engine.cancel(topic.id)).status).toBe('completed')
  expect((await store.load(topic.id)).status).toBe('completed')
  expect(writes).not.toHaveBeenCalled()
})

it.each(['continue', 'regenerate'] as const)('does not accept a stale final from before %s as the latest result', async action => {
  const judge: Judge = async () => { throw new Error('judge unavailable for the new answer') }
  const { store, engine, topic, dir } = await fixture(1, judge)
  topic.status = 'completed'
  topic.rounds = [answered(1)]
  topic.rounds[0]!.verdict = 'accepted'
  topic.rounds[0]!.done = true
  const oldFinal = '<!-- dsh-pro-final: {"generation":1,"throughRound":1} -->\n# Old result\n\n- 状态：completed\n- 轮次：1/1\n\n## 结论摘要\n\nOLD SUMMARY MUST NOT BECOME THE NEW RESULT\n'
  await store.writeFinal(topic, oldFinal)
  await store.writeAnswer(topic, 1, 'old answer')
  await store.save(topic)
  if (action === 'continue') await engine.continue(topic.id, 'new question')
  else await engine.regenerate(topic.id, 'new question', 'new version')
  await engine.drain()
  expect((await store.load(topic.id)).status).toBe('reviewing')

  const actual = await engine.accept(topic.id)
  const final = await store.readFinal(actual)
  expect(actual.status).toBe('completed')
  expect(final).not.toContain('OLD SUMMARY MUST NOT BECOME THE NEW RESULT')
  expect(final).toContain('（未生成摘要；见各轮裁决与原始答复）')
  expect(final).toContain('| 2 | 未裁决 |')
  expect(final).toContain('人工接受')
  if (action === 'regenerate') {
    expect(await readFile(join(dir, 'finals', 'attempt-01.md'), 'utf8')).toBe(oldFinal)
    expect(await readFile(join(dir, 'finals', 'attempt-02.md'), 'utf8')).not.toContain('OLD SUMMARY MUST NOT BECOME THE NEW RESULT')
  }
})

it('preserves a verified current final summary when a capped result is accepted', async () => {
  const { store, engine } = await fixture(1)
  const started = await engine.start(card(1))
  await engine.drain()
  expect((await store.load(started.id)).status).toBe('capped')

  const acceptedTopic = await engine.accept(started.id)
  const final = await store.readFinal(acceptedTopic)
  expect(final).toContain('current partial summary')
  expect(final).toContain('- 状态：completed')
  expect(final).toContain('人工接受')
})
