import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ResearchStore } from '../src/store.ts'
import { readReportInfo } from '../src/report.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('tracks coverage across follow-up, regeneration and file-only edits without guessing legacy provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-report-')); roots.push(root)
  const store = new ResearchStore({ mode: 'local', projectRoot: root, localRoot: root, rawDir: join(root, 'raw'), rawAnswers: 'local' })
  const { topic, dir } = await store.create({ title: 'Report', type: 'research', question: 'Q', brief: 'Q', successCriteria: ['c'], materials: [], rounds: 3, store: 'local' }, 3, 'pro', 'web')
  topic.status = 'capped'
  topic.rounds = [{ n: 1, generation: 1, files: 0, answeredAt: '2020-01-01T00:00:00.000Z' }]
  const file = join(dir, 'report.md')
  expect(await readReportInfo(dir, topic)).toBeNull()
  await writeFile(file, '# Legacy')
  expect((await readReportInfo(dir, topic))?.status).toBe('unknown')
  await writeFile(file, '<!-- dsh-pro-report: {"generation":1,"throughRound":1} -->\n# A')
  const original = await readReportInfo(dir, topic)
  expect(original?.status).toBe('current')
  topic.status = 'queued'; topic.runThrough = 2
  expect((await readReportInfo(dir, topic))?.status).toBe('stale')
  topic.rounds.push({ n: 2, generation: 1, files: 0, answeredAt: '2020-01-02T00:00:00.000Z' })
  topic.status = 'capped'; delete topic.runThrough
  expect((await readReportInfo(dir, topic))?.status).toBe('stale')
  await writeFile(file, '<!-- dsh-pro-report: {"generation":1,"throughRound":2} -->\n# B')
  expect((await readReportInfo(dir, topic))?.status).toBe('current')
  const beforeEdit = await readReportInfo(dir, topic)
  await writeFile(file, '<!-- dsh-pro-report: {"generation":1,"throughRound":2} -->\n# B revised')
  expect((await readReportInfo(dir, topic))?.revision).not.toBe(beforeEdit?.revision)
  expect(topic.updated).not.toBeUndefined()
  await utimes(file, new Date('2019-01-01'), new Date('2019-01-01'))
  expect((await readReportInfo(dir, topic))?.status).toBe('stale')
  topic.generations?.push({ n: 2, createdAt: new Date().toISOString() })
  expect((await readReportInfo(dir, topic))?.status).toBe('stale')
  for (const meta of ['broken', '{"generation":2,"throughRound":2}', '{"generation":1,"throughRound":99}']) {
    await writeFile(file, `<!-- dsh-pro-report: ${meta} -->\n# Unconfirmed`)
    expect((await readReportInfo(dir, topic))?.status).toBe('unknown')
  }
})
