import { mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSizeLimitError, readContainedFile, readContainedPrefix, resolveContainedPath } from '../src/files.ts'
import { ResearchStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-contained-files-'))
  roots.push(root)
  const safe = join(root, 'safe')
  const outside = join(root, 'outside')
  await mkdir(safe)
  await mkdir(outside)
  await writeFile(join(safe, 'note.txt'), 'safe data', 'utf8')
  await writeFile(join(outside, 'private.txt'), 'private data', 'utf8')
  await symlink(outside, join(safe, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  return { root, safe, outside }
}

describe('contained file reads', () => {
  it('rejects lexical and physical escape for reads and native-open resolution', async () => {
    const { safe, outside } = await fixture()
    for (const path of ['../outside/private.txt', join(outside, 'private.txt'), 'linked/private.txt']) {
      await expect(resolveContainedPath(safe, path)).rejects.toThrow(/escapes/)
      await expect(readContainedFile(safe, path, 100)).rejects.toThrow(/escapes/)
    }
    expect((await readContainedFile(safe, 'note.txt', 9)).toString()).toBe('safe data')
    await expect(readContainedFile(safe, '.', 100)).rejects.toThrow('regular file')
  })

  it('rejects oversized files before materializing them and reads only bounded previews', async () => {
    const { safe } = await fixture()
    await writeFile(join(safe, 'large.txt'), 'header')
    // Sparse fixture tests a large stat without allocating a large buffer.
    await truncate(join(safe, 'large.txt'), 150 * 1024 * 1024)
    await expect(readContainedFile(safe, 'large.txt', 1024)).rejects.toBeInstanceOf(FileSizeLimitError)
    expect((await readContainedPrefix(safe, 'large.txt', 6)).toString()).toBe('header')
    expect((await readContainedPrefix(safe, 'note.txt', 4)).toString()).toBe('safe')
    expect((await readContainedFile(safe, 'note.txt', 9)).byteLength).toBe(9)
  })

  it('rejects a cached topic directory replaced by an external junction', async () => {
    const { root, outside } = await fixture()
    const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: join(root, 'local'), rawDir: join(root, 'raw'), rawAnswers: 'local' })
    const { topic, dir } = await store.create({ title: 'Cached', type: 'research', question: 'q', successCriteria: ['c'], brief: 'b', materials: [], rounds: 1, store: 'project' }, 1, 'pro', 'web')
    const original = join(outside, 'original-topic')
    await rename(dir, original)
    await symlink(original, dir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.dirOf(topic.id)).rejects.toThrow(/escapes/)
    await expect(store.load(topic.id)).rejects.toThrow(/escapes/)
  })

  it('rechecks staged material links before returning upload paths', async () => {
    const { root, outside } = await fixture()
    const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: join(root, 'local'), rawDir: join(root, 'raw'), rawAnswers: 'local' })
    const { topic, dir } = await store.create({ title: 'Staged', type: 'research', question: 'q', successCriteria: ['c'], brief: 'b', materials: [], rounds: 1, store: 'project' }, 1, 'pro', 'web')
    await symlink(outside, join(dir, 'materials', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(dir, 'materials', 'manifest.json'), JSON.stringify({ materials: [{ path: 'linked/private.txt', bytes: 12, sha256: 'unused' }] }))
    await expect(store.readMaterialPaths(topic)).rejects.toThrow(/escapes/)
    await store.writeRoundMaterials(topic, 2, [{ path: 'linked/private.txt', bytes: 12, sha256: 'unused' }])
    await expect(store.readRoundMaterials(topic, 2)).rejects.toThrow(/escapes/)
    // A missing manifest means no materials; a missing entry in an existing
    // manifest is an error, not permission to silently submit without it.
    await writeFile(join(dir, 'materials', 'manifest.json'), JSON.stringify({ materials: [{ path: 'missing.txt', bytes: 1, sha256: 'unused' }] }))
    await expect(store.readMaterialPaths(topic)).rejects.toThrow(/cannot read material manifest/)
    await store.writeRoundMaterials(topic, 2, [{ path: 'missing.txt', bytes: 1, sha256: 'unused' }])
    await expect(store.readRoundMaterials(topic, 2)).rejects.toThrow(/cannot read round 2 materials/)
    expect(() => store.rawTopicDir('../../outside')).toThrow('invalid topic id')
  })
})
