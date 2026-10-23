import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchStore, type ResearchCard } from '@dsh-pro/core'
import { apply, resolveResearchConfig } from '../src/index.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface Route {
  path: string
  handler: (req: unknown, res: unknown) => unknown
}

interface Captured {
  tools: Array<Record<string, unknown>>
  routes: Route[]
  skills: Array<{ name: string }>
}

function fakeContext(captured: Captured) {
  const skills = {
    registerProvider: (factory: (control: { signal: AbortSignal }) => unknown) => {
      const provider = factory({ signal: new AbortController().signal }) as {
        list: () => Promise<Array<{ name: string; description: string }>>
        get: (candidate: unknown) => Promise<unknown>
      }
      captured.skills = [{ name: 'provider' }]
      void provider.list().then(items => { captured.skills = items.map(item => ({ name: item.name })) })
      void provider
      return () => {}
    },
  }
  const webServer = {
    register: (route: Route) => {
      captured.routes.push(route)
      return () => {}
    },
  }
  const scoped = {
    effect: (fn: () => () => void) => fn(),
    get: () => undefined,
    webServer,
  }
  const ctx = {
    effect: (fn: () => () => void) => fn(),
    tools: {
      register: (tool: Record<string, unknown>) => {
        captured.tools.push(tool)
        return () => {}
      },
    },
    get: (name: string) => (name === 'skills' ? skills : undefined),
    inject: (services: string[], callback: (scopedContext: unknown) => void) => {
      if (services.includes('webServer')) callback(scoped)
    },
  }
  return ctx
}

describe('plugin wiring', () => {
  it('registers one tool, nine routes and one skill', async () => {
    const captured: Captured = { tools: [], routes: [], skills: [] }
    apply(fakeContext(captured) as never, { rounds: 2 })
    await Promise.resolve()
    await Promise.resolve()

    expect(captured.tools).toHaveLength(1)
    const tool = captured.tools[0] as {
      name: string
      parameters: { properties?: Record<string, unknown> }
      execute: unknown
    }
    expect(tool.name).toBe('pro_research')
    expect(Object.keys(tool.parameters.properties ?? {})).toContain('action')
    expect(typeof tool.execute).toBe('function')

    expect(captured.routes.map(route => route.path).sort()).toEqual([
      '/chatgpt-pro-research/action',
      '/chatgpt-pro-research/answer',
      '/chatgpt-pro-research/asset',
      '/chatgpt-pro-research/bundle',
      '/chatgpt-pro-research/file',
      '/chatgpt-pro-research/open',
      '/chatgpt-pro-research/raw',
      '/chatgpt-pro-research/topic',
      '/chatgpt-pro-research/topics',
    ])
    expect(captured.skills.map(skill => skill.name).sort()).toEqual(['pro-research'])
  })

  it('merges settings over defaults and keeps three-layer precedence', () => {
    const resolved = resolveResearchConfig({ rounds: 5, store: 'local', headless: true })
    expect(resolved.rounds).toBe(5)
    expect(resolved.store).toBe('local')
    expect(resolved.browser.headless).toBe(true)
    expect(resolved.rawAnswers).toBe('local')
    expect(resolved.maxFiles).toBe(12)
  })

  it('lists an empty project without starting the browser', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-plugin-'))
    cleanups.push(cwd)
    const captured: Captured = { tools: [], routes: [], skills: [] }
    apply(fakeContext(captured) as never, { store: 'project' })
    const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
    const exec = { agent: { session: { header: { cwd } } }, signal: new AbortController().signal }
    await expect(tool.execute({ action: 'list' }, exec)).resolves.toEqual({ topics: [] })
  })

  it('refuses to start without the research-card confirmation', async () => {
    const captured: Captured = { tools: [], routes: [], skills: [] }
    apply(fakeContext(captured) as never, {})
    const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
    await expect(tool.execute({ action: 'start' }, { agent: undefined })).rejects.toThrow(/confirmed=true/)
    await expect(tool.execute({ action: 'continue', topic_id: 'x' }, { agent: undefined })).rejects.toThrow(/confirmed=true/)
  })

  it('refuses to send a secret in the final card text before creating a topic', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-project-'))
    cleanups.push(home, cwd)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
      const exec = { agent: { session: { header: { cwd }, id: 's1' } } }
      await expect(tool.execute({
        action: 'start',
        confirmed: true,
        title: 'secret check',
        question: 'q',
        brief: 'use key sk-abcdefghijklmnopqrstuvwxyz123456',
        criteria: ['c'],
      }, exec)).rejects.toThrow(/openai-key/)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('serves the topics route from an isolated home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
    cleanups.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const route = captured.routes.find(item => item.path === '/chatgpt-pro-research/topics')
      expect(route).toBeDefined()
      const response = await call(route as Route, { url: '/chatgpt-pro-research/topics', method: 'GET', headers: {} })
      expect(response.status).toBe(200)
      expect(response.json).toEqual({ topics: [] })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('answers 404 for an unknown topic id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
    cleanups.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const route = captured.routes.find(item => item.path === '/chatgpt-pro-research/topic')
      const response = await call(route as Route, { url: '/chatgpt-pro-research/topic?id=missing', method: 'GET', headers: {} })
      expect(response.status).toBe(404)
      expect(response.json).toEqual({ error: 'unknown topic' })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('lists and reads a topic recorded before the current host start', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-project-'))
    cleanups.push(home, cwd)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const store = new ResearchStore({
        mode: 'local',
        projectRoot: cwd,
        localRoot: join(home, 'chatgpt-pro-research'),
        rawDir: join(home, 'raw'),
        rawAnswers: 'local',
      })
      const card: ResearchCard = {
        title: 'Persisted topic',
        type: 'research',
        question: 'Q?',
        successCriteria: ['c'],
        brief: 'b',
        materials: [],
        rounds: 2,
        store: 'local',
      }
      const { topic } = await store.create(card, 2, 'pro', 'web-pro')
      await mkdir(join(home, 'chatgpt-pro-research'), { recursive: true })
      await writeFile(join(home, 'chatgpt-pro-research', 'registry.json'), JSON.stringify({
        version: 1,
        topics: [{ id: topic.id, root: cwd, mode: 'local', title: topic.title, updated: topic.updated }],
      }), 'utf8')

      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const topicsRoute = captured.routes.find(item => item.path === '/chatgpt-pro-research/topics')
      const listed = await call(topicsRoute as Route, { url: '/chatgpt-pro-research/topics', method: 'GET', headers: {} })
      expect(listed.status).toBe(200)
      expect(listed.json.topics).toHaveLength(1)
      expect(listed.json.topics[0].topic_id).toBe(topic.id)

      const detailRoute = captured.routes.find(item => item.path === '/chatgpt-pro-research/topic')
      const detail = await call(detailRoute as Route, {
        url: `/chatgpt-pro-research/topic?id=${topic.id}`,
        method: 'GET',
        headers: {},
      })
      expect(detail.status).toBe(200)
      expect(detail.json.topic.title).toBe('Persisted topic')
      expect(detail.json.topic.rounds_detail).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('settings scoping', () => {
  it('keeps research on the web channel even when api fields are present', () => {
    const previous = process.env.GPT_IMAGE_API_KEY
    process.env.GPT_IMAGE_API_KEY = 'env-key'
    try {
      const settings = resolveResearchConfig({
        channel: 'api',
        imageBaseUrl: 'https://gateway.example/v1',
        imageModel: 'gpt-image-1',
      })
      expect(settings.channel).toBe('web')
      expect(settings.image.baseUrl).toBe('https://api.openai.com/v1')
      expect(settings.image.model).toBe('gpt-image-1')
      expect(resolveResearchConfig({}).channel).toBe('web')
    } finally {
      if (previous === undefined) delete process.env.GPT_IMAGE_API_KEY
      else process.env.GPT_IMAGE_API_KEY = previous
    }
  })
})

async function call(route: Route, request: Record<string, unknown>): Promise<{ status: number; json: any; headers: Record<string, string>; body: string }> {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const response = {
    statusCode: 0,
    writeHead: (code: number, hdrs?: Record<string, string>) => { status = code; headers = hdrs ?? {} },
    write: () => true,
    end: (chunk?: unknown) => { body = typeof chunk === 'string' ? chunk : chunk instanceof Buffer ? chunk.toString('utf8') : '' },
  }
  await route.handler(request, response)
  let json: any
  try { json = body === '' ? undefined : JSON.parse(body) } catch { json = undefined }
  return { status, json, headers, body }
}

/** A fake POST request whose body arrives as raw byte chunks. */
function chunkedRequest(url: string, chunks: Buffer[]): Record<string, unknown> {
  return {
    url,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

interface Seed {
  home: string
  cwd: string
  topicId: string
  dir: string
}

/** Create one topic record + registry entry in an isolated DSH_HOME. */
async function seedTopic(status: string): Promise<Seed> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-project-'))
  cleanups.push(home, cwd)
  const store = new ResearchStore({
    mode: 'local',
    projectRoot: cwd,
    localRoot: join(home, 'chatgpt-pro-research'),
    rawDir: join(home, 'raw'),
    rawAnswers: 'local',
  })
  const { topic, dir } = await store.create({
    title: 'Seeded topic',
    type: 'research',
    question: 'Q?',
    successCriteria: ['c'],
    brief: 'b',
    materials: [],
    rounds: 1,
    store: 'local',
  }, 1, 'pro', 'web')
  topic.status = status as never
  await store.save(topic)
  await mkdir(join(home, 'chatgpt-pro-research'), { recursive: true })
  await writeFile(join(home, 'chatgpt-pro-research', 'registry.json'), JSON.stringify({
    version: 1,
    topics: [{ id: topic.id, root: cwd, mode: 'local', title: topic.title, updated: topic.updated }],
  }), 'utf8')
  return { home, cwd, topicId: topic.id, dir }
}

async function withEnv<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

describe('route hardening', () => {
  it('decodes a multibyte note split across body chunks', async () => {
    const seed = await seedTopic('stalled')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const route = captured.routes.find(item => item.path === '/chatgpt-pro-research/action') as Route
      const note = '人工核对依据：页面里能看到这条消息，但宿主重启过'
      const bytes = Buffer.from(JSON.stringify({ topic_id: seed.topicId, action: 'human_check', conclusion: 'reopen', note }), 'utf8')
      // Split inside a multibyte character: per-chunk decoding would corrupt it.
      const cut = bytes.indexOf('页', 'utf8') + 1
      const response = await call(route, chunkedRequest('/chatgpt-pro-research/action', [bytes.subarray(0, cut), bytes.subarray(cut)]))
      expect(response.status).toBe(200)
      const record = JSON.parse(await readFile(join(seed.dir, 'human-check.json'), 'utf8')) as { note: string }
      expect(record.note).toBe(note)
    })
  })

  it('rejects an over-limit action body with 413', async () => {
    const seed = await seedTopic('stalled')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const route = captured.routes.find(item => item.path === '/chatgpt-pro-research/action') as Route
      const big = Buffer.from(JSON.stringify({ topic_id: seed.topicId, action: 'cancel', padding: 'x'.repeat(1_100_000) }), 'utf8')
      const response = await call(route, chunkedRequest('/chatgpt-pro-research/action', [big]))
      expect(response.status).toBe(413)
    })
  })

  it('serves html/svg topic files and svg artifacts with a sandbox CSP', async () => {
    const seed = await seedTopic('completed')
    await mkdir(join(seed.dir, 'artifacts', 'round-01'), { recursive: true })
    await writeFile(join(seed.dir, 'artifacts', 'round-01', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8')
    await writeFile(join(seed.dir, 'rounds', 'poc.html'), '<!doctype html><script>alert(1)</script>', 'utf8')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const fileRoute = captured.routes.find(item => item.path === '/chatgpt-pro-research/file') as Route
      const assetRoute = captured.routes.find(item => item.path === '/chatgpt-pro-research/asset') as Route

      const html = await call(fileRoute, { url: `/chatgpt-pro-research/file?id=${seed.topicId}&path=${encodeURIComponent('rounds/poc.html')}`, method: 'GET', headers: {} })
      expect(html.status).toBe(200)
      expect(html.headers['content-security-policy']).toBe('sandbox allow-scripts')
      expect(html.headers['x-content-type-options']).toBe('nosniff')

      const svg = await call(assetRoute, { url: `/chatgpt-pro-research/asset?id=${seed.topicId}&path=${encodeURIComponent('artifacts/round-01/icon.svg')}`, method: 'GET', headers: {} })
      expect(svg.status).toBe(200)
      expect(svg.headers['content-security-policy']).toBe('sandbox')
      expect(svg.headers['x-content-type-options']).toBe('nosniff')
    })
  })

  it('rejects a cross-site POST even before the host guard runs', async () => {
    const seed = await seedTopic('completed')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const route = captured.routes.find(item => item.path === '/chatgpt-pro-research/action') as Route
      const request = chunkedRequest('/chatgpt-pro-research/action', [Buffer.from(JSON.stringify({ topic_id: seed.topicId, action: 'cancel' }), 'utf8')])
      request.headers = { 'sec-fetch-site': 'cross-site' }
      const response = await call(route, request)
      expect(response.status).toBe(403)
    })
  })
})

describe('delete and recovery', () => {
  it('deletes a terminal topic end to end and requires confirmation', async () => {
    const seed = await seedTopic('cancelled')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
      const exec = { agent: { session: { header: { cwd: seed.cwd }, id: 's1' } } }

      await expect(tool.execute({ action: 'delete', topic_id: seed.topicId }, exec)).rejects.toThrow(/confirmed=true/)
      const deleted = await tool.execute({ action: 'delete', topic_id: seed.topicId, confirmed: true }, exec) as { deleted: boolean }
      expect(deleted.deleted).toBe(true)
      await expect(readFile(join(seed.dir, 'topic.json'), 'utf8')).rejects.toThrow()
      const registry = JSON.parse(await readFile(join(seed.home, 'chatgpt-pro-research', 'registry.json'), 'utf8')) as { topics: unknown[] }
      expect(registry.topics).toHaveLength(0)

      const listed = await tool.execute({ action: 'list' }, exec) as { topics: unknown[] }
      expect(listed.topics).toHaveLength(0)
    })
  })

  it('refuses to delete an active topic', async () => {
    const seed = await seedTopic('waiting')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
      const exec = { agent: { session: { header: { cwd: seed.cwd }, id: 's1' } } }
      await expect(tool.execute({ action: 'delete', topic_id: seed.topicId, confirmed: true }, exec)).rejects.toThrow(/can be deleted/)
      // The record survives the refused delete.
      await expect(readFile(join(seed.dir, 'topic.json'), 'utf8')).resolves.toContain('waiting')
    })
  })

  it('acts on a topic found in another project store with the matching engine', async () => {
    const seed = await seedTopic('stalled')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
      // A different session cwd: the topic lives in seed.cwd's local store.
      const otherCwd = await mkdtemp(join(tmpdir(), 'dsh-pro-other-'))
      cleanups.push(otherCwd)
      const exec = { agent: { session: { header: { cwd: otherCwd }, id: 's2' } } }
      const cancelled = await tool.execute({ action: 'cancel', topic_id: seed.topicId }, exec) as { status: string }
      expect(cancelled.status).toBe('cancelled')
      const stored = JSON.parse(await readFile(join(seed.dir, 'topic.json'), 'utf8')) as { status: string }
      expect(stored.status).toBe('cancelled')
    })
  })

  it('writes scan-discovered topics back into the registry on recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-project-'))
    cleanups.push(home, cwd)
    const store = new ResearchStore({
      mode: 'local',
      projectRoot: process.cwd(),
      localRoot: join(home, 'chatgpt-pro-research'),
      rawDir: join(home, 'raw'),
      rawAnswers: 'local',
    })
    const { topic } = await store.create({
      title: 'Discovered topic',
      type: 'research',
      question: 'Q?',
      successCriteria: ['c'],
      brief: 'b',
      materials: [],
      rounds: 1,
      store: 'local',
    }, 1, 'pro', 'web')
    topic.status = 'completed'
    await store.save(topic)
    // No registry at all: the topic only exists on disk.
    await withEnv(home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      // recoverActive runs 2.5s after apply; give it room.
      const deadline = Date.now() + 9_000
      let found = false
      while (Date.now() < deadline) {
        try {
          const registry = JSON.parse(await readFile(join(home, 'chatgpt-pro-research', 'registry.json'), 'utf8')) as { topics: Array<{ id: string }> }
          if (registry.topics.some(entry => entry.id === topic.id)) {
            found = true
            break
          }
        } catch {
          // registry not written yet
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(found).toBe(true)
    })
  }, 15_000)
})
