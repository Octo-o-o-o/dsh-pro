import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { buildManifest } from '../src/materials.ts'
import { ResearchStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-write-boundary-'))
  roots.push(root)
  const outside = join(root, 'outside')
  await mkdir(outside)
  const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: join(root, 'local'), rawDir: join(root, 'raw'), rawAnswers: 'local' })
  const { topic, dir } = await store.create({ title: 'Write boundary', type: 'design', question: 'q', successCriteria: ['c'], brief: 'b', materials: [], rounds: 1, store: 'project' }, 1, 'pro', 'web')
  return { root, outside, store, topic, dir }
}
const linkKind = process.platform === 'win32' ? 'junction' : 'dir'

it('refuses to write returned code through an escaped artifact round directory', async () => {
  const { outside, store, topic, dir } = await fixture()
  await mkdir(join(dir, 'artifacts'))
  await writeFile(join(outside, 'code-01.html'), 'original external bytes')
  await symlink(outside, join(dir, 'artifacts', 'round-01'), linkKind)
  await expect(store.writeArtifacts(topic, 1, { answer: 'a', codeBlocks: [{ language: 'html', text: 'replacement' }] })).rejects.toThrow(/escapes/)
  expect(await readFile(join(outside, 'code-01.html'), 'utf8')).toBe('original external bytes')
})

it('refuses question writes through an escaped rounds directory', async () => {
  const { outside, store, topic, dir } = await fixture()
  await rename(join(dir, 'rounds'), join(dir, 'original-rounds'))
  await writeFile(join(outside, '01-question.md'), 'original question')
  await symlink(outside, join(dir, 'rounds'), linkKind)
  await expect(store.writeQuestion(topic, 1, 'replacement')).rejects.toThrow(/escapes/)
  expect(await readFile(join(outside, '01-question.md'), 'utf8')).toBe('original question')
})

it('refuses raw-answer writes through an escaped topic directory', async () => {
  const { root, outside, store, topic } = await fixture()
  await mkdir(join(root, 'raw'))
  await writeFile(join(outside, '01-answer.md'), 'original answer')
  await symlink(outside, join(root, 'raw', topic.id), linkKind)
  await expect(store.writeAnswer(topic, 1, 'replacement')).rejects.toThrow(/escapes/)
  expect(await readFile(join(outside, '01-answer.md'), 'utf8')).toBe('original answer')
})

it('does not suppress an escaped ZIP extraction write as an invalid archive', async () => {
  const { outside, store, topic, dir } = await fixture()
  await mkdir(join(dir, 'artifacts', 'round-01'), { recursive: true })
  await symlink(outside, join(dir, 'artifacts', 'round-01', 'pkg'), linkKind)
  await writeFile(join(outside, 'a.txt'), 'original a')
  const archive = Buffer.from(zipSync({ 'pkg/a.txt': Buffer.from('replacement'), 'pkg/b.txt': Buffer.from('new b') }))
  await expect(store.writeArtifacts(topic, 1, { answer: 'a', archives: [{ name: 'bundle.zip', base64: archive.toString('base64') }] })).rejects.toThrow(/escapes/)
  expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('original a')
  await expect(stat(join(outside, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('stages normal materials when the project root is accessed through a directory alias', async () => {
  const { root } = await fixture()
  const actual = join(root, 'actual-project')
  const alias = join(root, 'project-alias')
  await mkdir(actual)
  await writeFile(join(actual, 'note.txt'), 'normal aliased reference')
  await symlink(actual, alias, linkKind)
  const materials = await buildManifest(alias, ['note.txt'])
  const store = new ResearchStore({ mode: 'project', projectRoot: alias, localRoot: join(root, 'alias-local'), rawDir: join(root, 'alias-raw'), rawAnswers: 'local' })
  const { topic, dir } = await store.create({ title: 'Aliased project', type: 'research', question: 'q', successCriteria: ['c'], brief: 'b', materials, rounds: 1, store: 'project' }, 1, 'pro', 'web')
  expect(dir.startsWith(alias)).toBe(true)
  expect(await readFile(join(dir, 'materials', 'note.txt'), 'utf8')).toBe('normal aliased reference')
  expect(await store.readMaterialPaths(topic)).toHaveLength(1)
})

it('rejects an escaped material directory before creating any outside children', async () => {
  const { root, outside, store, topic, dir } = await fixture()
  await writeFile(join(root, 'source.txt'), 'safe reference')
  const refs = await buildManifest(root, ['source.txt'])
  refs[0]!.path = 'linked/new/reference.txt'
  await symlink(outside, join(dir, 'materials', 'linked'), linkKind)
  await expect(store.addMaterials(topic, refs)).rejects.toThrow(/escapes/)
  await expect(stat(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
})
