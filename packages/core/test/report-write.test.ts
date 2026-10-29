import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ResearchStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(mode: 'project' | 'local' = 'local', type: 'research' | 'design' = 'research') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-report-write-')); roots.push(root)
  const cwd = join(root, 'workspace'); await mkdir(cwd)
  const store = new ResearchStore({ mode, projectRoot: cwd, localRoot: join(root, 'home'), rawDir: join(root, 'raw'), rawAnswers: 'local' })
  const { topic, dir } = await store.create({ title: 'Delivery', type, question: 'Q', brief: 'Q', successCriteria: ['c'], materials: [], rounds: 1, store: mode }, 1, 'pro', 'web')
  topic.status = 'capped'
  topic.rounds = [{ n: 1, generation: 1, files: 0, answeredAt: '2020-01-01T00:00:00.000Z' }]
  await store.writeAnswer(topic, 1, 'actual answer')
  await store.save(topic)
  return { root, cwd, store, topic, dir }
}
const draft = { markdown: '# Evidence-based delivery', generation: 1, throughRound: 1, expectedRevision: '' }

it.each(['local', 'project'] as const)('writes both fixed report names in %s and refuses lost updates', async mode => {
  for (const type of ['research', 'design'] as const) {
    const { store, topic, cwd, dir } = await fixture(mode, type)
    expect(await store.readRound(topic.id, cwd, 1)).toMatchObject({ answer: 'actual answer', round: { n: 1 } })
    const report = await store.writeReport(topic.id, cwd, draft)
    expect(report).toMatchObject({ path: type === 'design' ? 'design.md' : 'report.md', status: 'current', generation: 1, throughRound: 1 })
    expect((await store.readReport(topic.id, cwd)).markdown).toContain('<!-- dsh-pro-report: {"generation":1,"throughRound":1} -->')
    await expect(store.writeReport(topic.id, cwd, draft)).rejects.toThrow('revision changed')
    await store.writeReport(topic.id, cwd, { ...draft, markdown: '# Revised', expectedRevision: report.revision })
    expect(await readFile(join(dir, report.path), 'utf8')).toContain('# Revised')
  }
})

it('rejects wrong workspaces, forged coverage, active rounds and arbitrary names', async () => {
  const { store, topic, cwd, root } = await fixture()
  await expect(store.writeReport(topic.id, root, draft)).rejects.toThrow('another workspace')
  await expect(store.readReport(topic.id, root)).rejects.toThrow('another workspace')
  await expect(store.writeReport('../outside', cwd, draft)).rejects.toThrow('unknown topic')
  for (const fields of [{ generation: 2 }, { throughRound: 2 }, { throughRound: 0 }, { throughRound: NaN }]) {
    await expect(store.writeReport(topic.id, cwd, { ...draft, ...fields })).rejects.toThrow('coverage')
  }
  for (const markdown of ['', 'x'.repeat(262145), '<!-- dsh-pro-report: {} -->']) {
    await expect(store.writeReport(topic.id, cwd, { ...draft, markdown })).rejects.toThrow()
  }
  topic.status = 'waiting'; await store.save(topic)
  await expect(store.writeReport(topic.id, cwd, draft)).rejects.toThrow('coverage')
  expect((await store.readReport(topic.id, cwd)).report).toBeNull()
})

it('allows only one concurrent writer and rejects redirected topic directories', async () => {
  const { store, topic, cwd, root, dir } = await fixture()
  const outcomes = await Promise.allSettled([store.writeReport(topic.id, cwd, draft), store.writeReport(topic.id, cwd, draft)])
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const outside = join(root, 'outside'); await rename(dir, outside)
  await symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(store.writeReport(topic.id, cwd, draft)).rejects.toThrow('escapes')
  expect(await readFile(join(outside, 'report.md'), 'utf8')).toContain(draft.markdown)
})

it('does not clobber a preexisting writer lock', async () => {
  const { store, topic, cwd, dir } = await fixture()
  await writeFile(join(dir, '.report.lock'), 'another writer')
  await expect(store.writeReport(topic.id, cwd, draft)).rejects.toThrow('being written')
  expect(await readFile(join(dir, '.report.lock'), 'utf8')).toBe('another writer')
})
