import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchStore } from '../src/store.ts'
import { buildManifest, sha256File } from '../src/materials.ts'
import { newTopicId } from '../src/slug.ts'
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

  it('generates collision-resistant topic ids and refuses to reuse one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const ids = new Set(Array.from({ length: 500 }, (_, index) => newTopicId(`same title ${index}`)))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(id).toMatch(/^topic-[0-9a-f]{10}$/)

    const first = await store.create(card(), 3, 'pro', 'web')
    const second = await store.create(card(), 3, 'pro', 'web')
    expect(second.topic.id).not.toBe(first.topic.id)
    expect(second.dir).not.toBe(first.dir)
    expect((await store.list()).map(item => item.id).sort()).toEqual([first.topic.id, second.topic.id].sort())
  })

  it('preserves named multi-file code and extracts a downloaded zip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic } = await store.create(card(), 3, 'pro', 'web')
    const archive = Buffer.from(zipSync({
      'pkg/index.html': new TextEncoder().encode('<!doctype html><link rel="stylesheet" href="./style.css">'),
      'pkg/style.css': new TextEncoder().encode('body{color:red}'),
    }))
    const added = await store.writeArtifacts(topic, 1, {
      answer: '',
      codeBlocks: [
        { language: 'tsx', name: 'src/App.tsx', text: 'export default function App() {}' },
        { language: '', name: 'index.html', text: '<!doctype html><link rel="stylesheet" href="./style.css">' },
      ],
      archives: [{ name: 'pkg.zip', base64: archive.toString('base64') }],
    })
    expect(added).toContain('artifacts/round-01/src/App.tsx')
    expect(added).toContain('artifacts/round-01/index.html')
    expect(added).toContain('artifacts/round-01/pkg.zip')
    expect(added).toContain('artifacts/round-01/pkg/index.html')
    const bundle = await store.bundleRound(topic, 1)
    const entries = unzipSync(new Uint8Array(bundle.bytes))
    expect(Object.keys(entries)).toContain('src/App.tsx')
    expect(Object.keys(entries)).toContain('pkg/index.html')
  })

  it('refuses escaped linked artifacts instead of including outside bytes in a round zip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-links-'))
    cleanups.push(root)
    const store = new ResearchStore({ mode: 'project', projectRoot: root, localRoot: root, rawDir: join(root, 'raw'), rawAnswers: 'local' })
    const { topic, dir } = await store.create(card(), 1, 'pro', 'web')
    const outside = join(root, 'outside-topic')
    await mkdir(outside)
    await writeFile(join(outside, 'private.txt'), 'outside-only-marker', 'utf8')
    await mkdir(join(dir, 'artifacts', 'round-01'), { recursive: true })
    await symlink(outside, join(dir, 'artifacts', 'round-01', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    topic.artifacts.push('artifacts/round-01/linked/private.txt')
    await expect(store.bundleRound(topic, 1)).rejects.toThrow(/escapes/)
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

  it('stages materials into the topic directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const sourceDir = join(root, 'src')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'readme.md'), 'hello', 'utf8')
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const readme = join(sourceDir, 'readme.md')
    const { topic, dir } = await store.create(card({
      materials: [{
        path: 'src/readme.md',
        bytes: 5,
        sha256: await sha256File(readme),
        source: readme,
      }],
    }), 3, 'pro', 'web-pro')

    const paths = await store.readMaterialPaths(topic)
    expect(paths).toEqual([join(dir, 'materials', 'src', 'readme.md')])
    expect(await readFile(paths[0] as string, 'utf8')).toBe('hello')
    const manifest = JSON.parse(await readFile(join(dir, 'materials', 'manifest.json'), 'utf8')) as {
      materials: Array<{ path: string; source: string }>
    }
    expect(manifest.materials[0]?.source).toBe('src/readme.md')
    expect(manifest.materials[0]?.path).toBe('src/readme.md')
  })

  it('refuses a material whose bytes changed after hashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const source = join(root, 'a.md')
    await writeFile(source, 'hello', 'utf8')
    const manifest = await buildManifest(root, ['a.md'])
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    await writeFile(source, 'tampered', 'utf8')
    const materials = manifest.map(ref => ({ ...ref, source: join(root, ref.path) }))
    await expect(store.create(card({ materials }), 3, 'pro', 'web')).rejects.toThrow(/changed while staging/)
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

  it('fails closed when a material manifest or locator is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web')
    await writeFile(join(dir, 'materials', 'manifest.json'), '{ not-json', 'utf8')
    await expect(store.readMaterialPaths(topic)).rejects.toThrow(/material manifest/)

    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(join(root, 'sessions', `${topic.id}.json`), '{ not-json', 'utf8')
    await expect(store.readLocator(topic.id)).rejects.toThrow(/session locator/)
  })

  it('keeps every human check in an append-only history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web')
    await store.writeHumanCheck(topic, { at: '2026-10-23T01:00:00.000Z', conclusion: 'submitted', note: 'first' })
    await store.writeHumanCheck(topic, { at: '2026-10-23T02:00:00.000Z', conclusion: 'not_submitted', note: 'second' })
    const lines = (await readFile(join(dir, 'human-checks.ndjson'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"not_submitted"')
  })

  it('rejects a structurally corrupt topic.json on load and skips it on list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web')
    expect(await store.list()).toHaveLength(1)

    const broken = JSON.parse(await readFile(join(dir, 'topic.json'), 'utf8')) as Record<string, unknown>
    broken.status = 'exploded'
    await writeFile(join(dir, 'topic.json'), JSON.stringify(broken), 'utf8')
    await expect(store.load(topic.id)).rejects.toThrow(/corrupt topic/)
    expect(await store.list()).toHaveLength(0)

    broken.status = 'stalled'
    broken.rounds = 'not-an-array'
    await writeFile(join(dir, 'topic.json'), JSON.stringify(broken), 'utf8')
    await expect(store.load(topic.id)).rejects.toThrow(/corrupt topic/)
  })

  it('refuses a tampered material manifest that points outside the topic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web')
    await writeFile(join(dir, 'materials', 'manifest.json'), JSON.stringify({
      materials: [{ path: '../../outside.txt', bytes: 1, sha256: 'x' }],
    }), 'utf8')
    await expect(store.readMaterialPaths(topic)).rejects.toThrow(/escapes the topic/)
  })

  it('skips a structurally invalid topic instead of failing the whole list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const good = await store.create(card(), 3, 'pro', 'web')
    const brokenDir = join(root, 'docs', 'research', 'broken')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, 'topic.json'), JSON.stringify({ schema: 1, id: 'broken' }), 'utf8')
    const listed = await store.list()
    expect(listed.map(item => item.id)).toEqual([good.topic.id])
  })

  it('caps zip extraction by entry count and total bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web')

    const many: Record<string, Uint8Array> = {}
    for (let index = 0; index < 150; index += 1) {
      many[`pkg/f${String(index).padStart(3, '0')}.txt`] = new TextEncoder().encode(`file ${index}`)
    }
    const manyZip = Buffer.from(zipSync(many))
    const added = await store.writeArtifacts(topic, 1, {
      answer: '',
      archives: [{ name: 'many.zip', base64: manyZip.toString('base64') }],
    })
    const extracted = added.filter(path => path.includes('pkg/'))
    expect(extracted.length).toBeLessThanOrEqual(100)
    expect(added).toContain('artifacts/round-01/many.zip')

    // A highly compressible bomb: tiny archive, 60 MB of zeroes inside.
    const bomb = Buffer.from(zipSync({ 'bomb.bin': new Uint8Array(60 * 1024 * 1024) }))
    const before = (await readFile(join(dir, 'artifacts', 'round-01', 'many.zip'))).byteLength
    expect(before).toBeGreaterThan(0)
    const addedBomb = await store.writeArtifacts(topic, 2, {
      answer: '',
      archives: [{ name: 'bomb.zip', base64: bomb.toString('base64') }],
    })
    expect(addedBomb).toContain('artifacts/round-02/bomb.zip')
    expect(addedBomb.some(path => path.endsWith('bomb.bin'))).toBe(false)
  })

  it('removes a topic directory, raw answers and locator on remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-store-'))
    cleanups.push(root)
    const store = new ResearchStore({
      mode: 'project',
      projectRoot: root,
      localRoot: root,
      rawDir: join(root, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create(card(), 3, 'pro', 'web')
    await store.writeAnswer(topic, 1, 'raw answer')
    await store.writeLocator(topic.id, { conversationUrl: 'https://chatgpt.com/c/example', profileDir: root })
    await store.remove(topic)
    await expect(readFile(join(dir, 'topic.json'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'raw', topic.id, '01-answer.md'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'sessions', `${topic.id}.json`), 'utf8')).rejects.toThrow()
    expect(await store.list()).toHaveLength(0)
  })
})
