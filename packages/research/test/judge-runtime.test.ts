import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ResearchStore } from '../../core/src/store.ts'
import { apply } from '../src/index.ts'

it.each(['origin', 'fallback', 'provider-error', 'aborted-empty', 'aborted-after-json', 'max-tokens', 'missing-finish', 'non-json', 'reasoning-only'])('judges a saved answer with a routing session: %s', async scenario => {
  const failed = scenario !== 'origin' && scenario !== 'fallback'
  const root = await mkdtemp(join(tmpdir(), 'dsh-judge-runtime-'))
  const store = new ResearchStore({ mode: 'local', projectRoot: root, localRoot: join(root, 'chatgpt-pro-research'), rawDir: join(root, 'raw'), rawAnswers: 'local' })
  const { topic } = await store.create({ title: 'Saved answer', type: 'research', question: 'q', brief: 'b', successCriteria: ['c'], materials: [], rounds: 1, store: 'local' }, 1, 'pro', 'web')
  topic.status = 'reviewing'
  topic.reviewFrom = 'answered'
  topic.rounds = [{ n: 1, files: 0, answeredAt: new Date().toISOString(), judgeError: 'previous failure', attempts: 1 }]
  await store.writeAnswer(topic, 1, 'evidence')
  await store.save(topic)
  await writeFile(join(root, 'chatgpt-pro-research', 'registry.json'), JSON.stringify({ version: 1, topics: [{ id: topic.id, root, mode: 'local', title: topic.title, updated: topic.updated, ...(scenario === 'origin' ? { sessionId: 'origin-session' } : {}) }] }))
  const calls: Array<Record<string, unknown>> = []
  const disposers: Array<() => void> = []
  let execute: (args: unknown, ctx: unknown) => Promise<unknown>
  const ctx = {
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose as () => void); return dispose },
    get: (name: string) => name === 'llm' ? {
      async *stream(options: Record<string, unknown>) {
        calls.push(options)
        if (scenario === 'provider-error') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'MissingSessionID from provider', code: 'INVALID_REQUEST' } } }
          return
        }
        if (scenario === 'reasoning-only') yield { type: 'reasoning-delta', index: 0, text: 'private reasoning fixture' }
        else if (scenario === 'non-json') yield { type: 'text-delta', index: 0, text: 'private invalid output fixture' }
        else if (scenario !== 'aborted-empty') yield { type: 'text-delta', index: 0, text: JSON.stringify({ verdict: 'accepted', done: true, reason: 'met', summary: 'done', criteria: [{ criterion: 'c', status: 'met', evidence: 'evidence' }] }) }
        if (scenario === 'missing-finish') return
        if (scenario === 'max-tokens') {
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          return
        }
        if (scenario.startsWith('aborted-')) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'judge request timed out', code: 'ABORTED' } } }
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } : undefined,
    tools: { register: (tool: { execute: typeof execute }) => { execute = tool.execute; return () => {} } },
    inject: () => {},
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    apply(ctx as never, { store: 'local', rawAnswersDir: join(root, 'raw'), judgeProvider: 'fixture-provider', judgeModel: 'fixture-model' })
    await execute!({ action: 'resume', topic_id: topic.id }, { agent: { session: { header: { cwd: root }, id: 'caller-session' } } })
    let actual = await store.load(topic.id)
    for (let i = 0; i < 100 && actual.status !== 'completed' && actual.status !== 'reviewing'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      actual = await store.load(topic.id)
    }
    expect(calls).toHaveLength(failed ? 2 : 1)
    expect(calls.every(call => call.sessionId === (scenario === 'origin' ? 'origin-session' : topic.id))).toBe(true)
    expect(actual.rounds).toHaveLength(1)
    expect(actual.rounds[0]?.attempts).toBe(1)
    if (failed) {
      expect(actual.status).toBe('reviewing')
      expect(actual.rounds[0]?.verdict).toBeUndefined()
      const error = actual.rounds[0]?.judgeError ?? ''
      if (scenario === 'provider-error' || scenario.startsWith('aborted-')) {
        expect(error).toBe(`裁决服务失败：${scenario === 'provider-error' ? 'MissingSessionID from provider' : 'judge request timed out'}`)
      } else {
        expect(error).toContain(`finish=${scenario === 'max-tokens' ? 'max-tokens' : scenario === 'missing-finish' ? 'missing' : 'stop'}`)
        expect(error).toContain('textChars=')
        expect(error).toContain('reasoningChars=')
        expect(error).not.toContain('private')
        if (scenario === 'reasoning-only') expect(error).toContain('textChars=0; reasoningChars=25')
      }
    } else {
      expect(actual.status).toBe('completed')
      expect(actual.rounds[0]?.verdict).toBe('accepted')
    }
  } finally {
    for (const dispose of disposers) dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
