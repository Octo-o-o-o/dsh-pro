import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchStore } from '../src/store.ts'
import type { ResearchCard } from '../src/types.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

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

describe('project store', () => {
  it('creates the documented layout and round files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web-pro')
    expect(topic.status).toBe('draft')
    expect(dir.startsWith(join(root, 'docs', 'research'))).toBe(true)

    const question = await readFile(join(dir, 'rounds', '00-question.md'), 'utf8')
    expect(question).toContain('Does it work?')
    expect(question).toContain('brief body')

    await store.writeAnswer(topic, 1, 'raw answer')
    expect(await store.readAnswer(topic, 1)).toBe('raw answer')
    expect(await readFile(join(root, 'raw', topic.id, '01-answer.md'), 'utf8')).toBe('raw answer')

    const listed = await store.list()
    expect(listed.map(item => item.id)).toEqual([topic.id])

    const index = await store.index()
    expect(index.topics[0]?.id).toBe(topic.id)
    expect(index.topics[0]?.status).toBe('draft')

    const manifest = await readFile(join(dir, 'materials', 'manifest.json'), 'utf8')
    expect(manifest).toContain('materials')
  })

  it('keeps the parent link for follow-up topics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic } = await store.create(card({ parent: 'topic-parent' }), 3, 'pro', 'web-pro')
    expect(topic.parent).toBe('topic-parent')
  })

  it('writes answers into the repo only when rawAnswers=repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'repo',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web-pro')
    await store.writeAnswer(topic, 1, 'repo answer')
    expect(await readFile(join(dir, 'rounds', '01-answer.md'), 'utf8')).toBe('repo answer')
    expect(await readFile(join(root, 'raw', topic.id, '01-answer.md'), 'utf8')).toBe('repo answer')
  })

  it('uses the local tree for store=local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'local',
      projectRoot: root,
      localRoot: join(root, 'local'),
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { dir } = await store.create(card(), 3, 'pro', 'web-pro')
    expect(dir.startsWith(join(root, 'local', 'projects'))).toBe(true)
  })
})
