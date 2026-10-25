import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { baseImageMaterial, verifyStagedBaseImage } from '../src/base-image.ts'
import { createHash } from 'node:crypto'
import { ResearchStore } from '../src/store.ts'
import type { Topic } from '../src/types.ts'

it('rejects artifact symlink escapes and files whose extension lies about their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-base-boundary-'))
  try {
    const dir = join(root, 'topic')
    await mkdir(join(dir, 'artifacts'), { recursive: true })
    const outside = join(root, 'outside')
    await mkdir(outside)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    await writeFile(join(outside, 'base.png'), png)
    await symlink(outside, join(dir, 'artifacts', 'link'), 'junction')
    await writeFile(join(dir, 'artifacts', 'fake.png'), 'this is not a PNG')
    const paths = ['artifacts/link/base.png', 'artifacts/fake.png']
    const topic = { type: 'design', artifacts: paths, rounds: [{ n: 1, files: 0, artifacts: paths }] } as Topic
    await expect(baseImageMaterial(dir, topic, paths[0]!)).rejects.toThrow('超出主题目录')
    await expect(baseImageMaterial(dir, topic, paths[1]!)).rejects.toThrow('有效的 PNG')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a relocated materials root before reading or writing the selected base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-base-root-'))
  try {
    const store = new ResearchStore({ mode: 'local', localRoot: root, rawDir: join(root, 'raw'), rawAnswers: 'local' })
    const { topic, dir } = await store.create({ title: 'Base isolation', type: 'design', question: 'q', brief: 'b', successCriteria: ['c'], materials: [], rounds: 1, store: 'local' }, 1, 'pro', 'api')
    const materials = join(dir, 'materials')
    await rm(materials, { recursive: true })
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, materials, 'junction')
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const source = join(root, 'base.png')
    await writeFile(source, bytes)
    await writeFile(join(outside, 'base.png'), bytes)
    const ref = { path: join(materials, 'base.png'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    await expect(verifyStagedBaseImage(dir, ref)).rejects.toThrow('超出主题目录')
    await expect(store.addMaterials(topic, [{ ...ref, path: 'new.png', source }])).rejects.toThrow('escapes the topic')
    const { access } = await import('node:fs/promises')
    await expect(access(join(outside, 'new.png'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
