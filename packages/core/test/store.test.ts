import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
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
    const { topic, dir } = await store.create(card({
      materials: [{
        path: 'src/readme.md',
        bytes: 5,
        sha256: 'x',
        source: join(sourceDir, 'readme.md'),
      }],
    }), 3, 'pro', 'web-pro')

    const paths = await store.readMaterialPaths(topic)
    expect(paths).toEqual([join(dir, 'materials', 'src', 'readme.md')])
    expect(await readFile(paths[0] as string, 'utf8')).toBe('hello')
    const manifest = JSON.parse(await readFile(join(dir, 'materials', 'manifest.json'), 'utf8')) as {
      materials: Array<{ path: string; source: string }>
    }
    expect(manifest.materials[0]?.source).toBe('src/readme.md')
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
