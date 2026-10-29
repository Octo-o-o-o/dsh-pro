import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ResearchStore } from '../../core/src/store.ts'
import { apply as researchApply } from '../src/index.ts'
import { apply as designApply } from '../../design/src/index.ts'

it.each(['web', 'api'])('preserves failed-judge review and its actions after a %s restart', async channel => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-judge-recovery-'))
  const plugin = channel === 'web' ? 'chatgpt-pro-research' : 'gpt-image-design'
  const store = new ResearchStore({ mode: 'local', projectRoot: root, localRoot: join(root, plugin), rawDir: join(root, 'raw'), rawAnswers: 'local', docsSubdir: channel === 'web' ? 'research' : 'design' })
  const { topic } = await store.create({ title: 'Failed verdict', type: channel === 'web' ? 'research' : 'design', question: 'q', brief: 'b', successCriteria: ['c'], materials: [], rounds: 1, store: 'local' }, 1, 'pro', channel)
  topic.status = 'reviewing'
  topic.reviewFrom = 'answered'
  topic.rounds = [{ n: 1, files: 0, answeredAt: new Date().toISOString(), judgeError: 'judge unavailable' }]
  await store.writeAnswer(topic, 1, 'saved response')
  await store.save(topic)
  await writeFile(join(root, plugin, 'registry.json'), JSON.stringify({ version: 1, topics: [{ id: topic.id, root, mode: 'local', title: topic.title, updated: topic.updated }] }))
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (fn: () => unknown) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose as () => void); return dispose },
    get: () => undefined, tools: { register: () => () => {} }, inject: () => {},
  }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    (channel === 'web' ? researchApply : designApply)(ctx as never, { store: 'local', channel, judgeProvider: 'off' })
    await new Promise(resolve => setTimeout(resolve, 3_000))
    const actual = await store.load(topic.id)
    expect(actual).toMatchObject({ status: 'reviewing', reviewFrom: 'answered' })
    expect(actual.rounds[0]?.judgeError).toBe('judge unavailable')
    expect(await store.readAnswer(actual, 1)).toBe('saved response')
  } finally {
    for (const dispose of [...disposers].reverse()) await dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
