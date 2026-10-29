import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchStore, TransportError, type ResearchCard } from '@dsh-pro/core'
import { ChatGptWebTransport } from '@dsh-pro/transport'
import { apply, resolveResearchConfig } from '../src/index.ts'
import { externalOpenCommand, externalRevealCommand } from '../src/plugin.ts'

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
  toolUnregistered?: number
  skillUnregistered?: number
}

function fakeContext(captured: Captured, options: { connection?: boolean } = {}) {
  const disposers: Array<() => void> = []
  const effect = (fn: () => () => void): (() => void) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const skills = {
    registerProvider: (factory: (control: { signal: AbortSignal }) => unknown) => {
      const provider = factory({ signal: new AbortController().signal }) as {
        list: () => Promise<Array<{ name: string; description: string }>>
        get: (candidate: unknown) => Promise<unknown>
      }
      captured.skills = [{ name: 'provider' }]
      void provider.list().then(items => { captured.skills = items.map(item => ({ name: item.name })) })
      void provider
      return () => { captured.skillUnregistered = (captured.skillUnregistered ?? 0) + 1 }
    },
  }
  const webServer = {
    register: (route: Route) => {
      captured.routes.push(route)
      return () => {}
    },
  }
  const scoped = {
    effect,
    get: (name: string) => {
      if (name === 'skills') return skills
      if (name === 'connection' && options.connection !== false) return { requestRejection: () => undefined }
      return undefined
    },
    webServer,
  }
  const ctx = {
    effect,
    tools: {
      register: (tool: Record<string, unknown>) => {
        captured.tools.push(tool)
        return () => { captured.toolUnregistered = (captured.toolUnregistered ?? 0) + 1 }
      },
    },
    get: (name: string) => (name === 'skills' ? skills : undefined),
    inject: (services: string[], callback: (scopedContext: unknown) => void) => {
      if (services.includes('webServer') || services.includes('skills')) callback(scoped)
    },
    dispose: async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() },
  }
  return ctx
}

describe('plugin wiring', () => {
  it('delivers a local report through the registered tool without arbitrary filesystem paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-report-tool-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-report-tool-work-'))
    cleanups.push(home, cwd)
    const store = new ResearchStore({ mode: 'local', projectRoot: cwd, localRoot: join(home, 'chatgpt-pro-research'), rawDir: join(home, 'raw'), rawAnswers: 'local' })
    const { topic } = await store.create({ title: 'Delivery tool', type: 'research', question: 'Q', brief: 'Q', successCriteria: ['c'], materials: [], rounds: 1, store: 'local' }, 1, 'pro', 'web')
    topic.status = 'completed'
    topic.rounds = [{ n: 1, files: 0, generation: 1, answeredAt: '2020-01-01T00:00:00.000Z' }]
    await store.writeAnswer(topic, 1, 'the evidence')
    await store.save(topic)
    await withEnv(home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      const ctx = fakeContext(captured)
      apply(ctx as never, { store: 'local', rawAnswersDir: join(home, 'raw') })
      const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
      const exec = { agent: { session: { header: { cwd }, id: 'report-test' } } }
      const args = { action: 'write_report', topic_id: topic.id, generation: 1, through_round: 1, expected_revision: '', markdown: '# Based on the evidence' }
      try {
        await expect(tool.execute(args, exec)).rejects.toThrow('confirmed=true')
        await expect(tool.execute({ ...args, confirmed: true }, {})).rejects.toThrow('workspace session')
        expect(await tool.execute({ action: 'read_round', topic_id: topic.id, round: 1 }, exec)).toMatchObject({ answer: 'the evidence' })
        expect(await tool.execute({ ...args, confirmed: true }, exec)).toMatchObject({ topic_id: topic.id, report: { path: 'report.md', status: 'current' } })
        expect(await tool.execute({ action: 'read_report', topic_id: topic.id }, exec)).toMatchObject({ report: { status: 'current' }, markdown: expect.stringContaining('# Based on the evidence') })
      } finally { await ctx.dispose() }
    })
  })

  it.each(['local', 'project'] as const)('honors the card store=%s and records the effective location', async mode => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-project-'))
    cleanups.push(home, cwd)
    const submit = vi.spyOn(ChatGptWebTransport.prototype, 'submit').mockRejectedValue(
      new TransportError('fixture stopped before send', 'ui', { submissionState: 'not_sent' }),
    )
    try {
      await withEnv(home, async () => {
        const captured: Captured = { tools: [], routes: [], skills: [] }
        const ctx = fakeContext(captured)
        apply(ctx as never, { store: mode === 'local' ? 'project' : 'local' })
        try {
          const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
          const exec = { agent: { session: { header: { cwd }, id: 'store-test' } } }
          const result = await tool.execute({ action: 'start', confirmed: true, title: 'store test', question: 'q', brief: 'b', criteria: ['c'], store: mode }, exec)
          expect(result.store).toBe(mode)
          expect(String(result.path).startsWith(mode === 'local' ? home : cwd)).toBe(true)
          const registry = JSON.parse(await readFile(join(home, 'chatgpt-pro-research', 'registry.json'), 'utf8'))
          expect(registry.topics[0].mode).toBe(mode)
          const deadline = Date.now() + 3_000
          let status: Record<string, unknown> = {}
          do {
            status = await tool.execute({ action: 'status', topic_id: result.topic_id }, exec)
            if (status.status === 'stalled') break
            await new Promise(resolve => setTimeout(resolve, 20))
          } while (Date.now() < deadline)
          expect(status.status).toBe('stalled')
          expect(status.last_round).toMatchObject({ n: 1, submissionState: 'not_sent' })
          expect(status.last_round).not.toHaveProperty('submissionId')
          if (mode === 'local') await expect(readFile(join(cwd, 'docs', 'research', 'index.json'))).rejects.toThrow()
        } finally { await ctx.dispose() }
      })
    } finally { submit.mockRestore() }
  })

  it('rejects an invalid per-task store before creating a topic', async () => {
    const captured: Captured = { tools: [], routes: [], skills: [] }
    const ctx = fakeContext(captured)
    apply(ctx as never, {})
    try {
      const tool = captured.tools[0] as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
      await expect(tool.execute({ action: 'start', confirmed: true, store: 'elsewhere' }, {})).rejects.toThrow(/store.*project.*local/)
    } finally { await ctx.dispose() }
  })

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

  it('releases its tool and skill registrations with the plugin fiber', async () => {
    const captured: Captured = { tools: [], routes: [], skills: [] }
    const ctx = fakeContext(captured)
    apply(ctx as never, {})
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.tools).toHaveLength(1)
    expect(captured.skills.map(skill => skill.name)).toEqual(['pro-research'])
    await ctx.dispose()
    expect(captured.toolUnregistered).toBe(1)
    expect(captured.skillUnregistered).toBe(1)
  })

  it('opens files through a fixed executable instead of a shell', () => {
    const opener = externalOpenCommand('win32', 'C:\\topic\\a&b.html')
    expect(opener.command).toBe('explorer.exe')
    expect(opener.args).toEqual(['C:\\topic\\a&b.html'])
    expect(externalOpenCommand('darwin', '/tmp/a&b.html')).toEqual({ command: 'open', args: ['/tmp/a&b.html'] })
    expect(externalOpenCommand('linux', '/tmp/a&b.html')).toEqual({ command: 'xdg-open', args: ['/tmp/a&b.html'] })

    expect(externalRevealCommand('win32', 'C:\\topic\\a&b.html')).toEqual({
      command: 'explorer.exe',
      args: ['/select,C:\\topic\\a&b.html'],
    })
    expect(externalRevealCommand('darwin', '/tmp/a.html')).toEqual({ command: 'open', args: ['-R', '/tmp/a.html'] })
    expect(externalRevealCommand('linux', '/tmp/dir/a.html')).toEqual({ command: 'xdg-open', args: ['/tmp/dir'] })
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

  it('does not expose routes when the connection guard is missing', async () => {
    const captured: Captured = { tools: [], routes: [], skills: [] }
    apply(fakeContext(captured, { connection: false }) as never, { store: 'local' })
    await Promise.resolve()
    expect(captured.tools).toHaveLength(1)
    expect(captured.routes).toHaveLength(0)
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
  it('refuses topic file and artifact directory links that escape the topic', async () => {
    const seed = await seedTopic('completed')
    const outside = join(seed.home, 'outside-topic')
    await mkdir(outside)
    await writeFile(join(outside, 'private.txt'), 'outside-only-marker', 'utf8')
    await mkdir(join(seed.dir, 'artifacts', 'round-01'), { recursive: true })
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(outside, join(seed.dir, 'rounds', 'linked'), kind)
    await symlink(outside, join(seed.dir, 'artifacts', 'round-01', 'linked'), kind)
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      const ctx = fakeContext(captured)
      apply(ctx as never, { store: 'local' })
      try {
        for (const [routeName, path] of [
          ['file', 'rounds/linked/private.txt'],
          ['asset', 'artifacts/round-01/linked/private.txt'],
        ]) {
          const route = captured.routes.find(item => item.path === `/chatgpt-pro-research/${routeName}`) as Route
          const response = await call(route, { url: `${route.path}?id=${seed.topicId}&path=${encodeURIComponent(path!)}`, method: 'GET', headers: {} })
          expect(response.status).toBe(404)
          expect(response.body).not.toContain('outside-only-marker')
        }
        const raw = captured.routes.find(item => item.path === '/chatgpt-pro-research/raw') as Route
        const response = await call(raw, { url: `${raw.path}/${seed.topicId}/artifacts/round-01/linked/private.txt`, method: 'GET', headers: {} })
        expect(response.status).toBe(404)
        expect(response.body).not.toContain('outside-only-marker')
      } finally {
        await ctx.dispose()
      }
    })
  })

  it('returns 413 for oversized preview and artifact files without reading their entire bodies', async () => {
    const seed = await seedTopic('completed')
    await writeFile(join(seed.dir, 'rounds', 'large.txt'), 'header')
    await truncate(join(seed.dir, 'rounds', 'large.txt'), 2_000_001)
    await mkdir(join(seed.dir, 'artifacts', 'round-01'), { recursive: true })
    await writeFile(join(seed.dir, 'artifacts', 'round-01', 'large.png'), 'header')
    await truncate(join(seed.dir, 'artifacts', 'round-01', 'large.png'), 100 * 1024 * 1024 + 1)
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      const ctx = fakeContext(captured)
      apply(ctx as never, { store: 'local' })
      try {
        for (const [name, path] of [['file', 'rounds/large.txt'], ['asset', 'artifacts/round-01/large.png']]) {
          const route = captured.routes.find(item => item.path === `/chatgpt-pro-research/${name}`) as Route
          const response = await call(route, { url: `${route.path}?id=${seed.topicId}&path=${encodeURIComponent(path!)}`, method: 'GET', headers: {} })
          expect(response.status).toBe(413)
          expect(response.body).not.toContain('header')
        }
      } finally { await ctx.dispose() }
    })
  })

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

      const rawRoute = captured.routes.find(item => item.path === '/chatgpt-pro-research/raw') as Route
      const demoPath = 'artifacts/round-01/demo.html'
      const original = '<!doctype html><html><button>完成</button></html>'
      await writeFile(join(seed.dir, demoPath), original, 'utf8')
      const url = `/chatgpt-pro-research/raw/${seed.topicId}/${demoPath}`
      const untouched = await call(rawRoute, { url, method: 'GET', headers: {} })
      const preview = await call(rawRoute, { url: `${url}?preview=1`, method: 'GET', headers: {} })
      expect(untouched.body).toBe(original)
      expect(preview.status).toBe(200)
      expect(preview.body).toMatch(/^<!doctype html><script>/)
      expect(preview.body).toContain('dsh-pro:preview-escape')
      expect(preview.body).toContain('<button>完成</button>')
      expect(preview.headers['content-security-policy']).toBe('sandbox allow-scripts')
      expect(await readFile(join(seed.dir, demoPath), 'utf8')).toBe(original)
    })
  })

  it('routes the panel continue action through its own branch', async () => {
    const seed = await seedTopic('waiting')
    await withEnv(seed.home, async () => {
      const captured: Captured = { tools: [], routes: [], skills: [] }
      apply(fakeContext(captured) as never, { store: 'local' })
      const route = captured.routes.find(item => item.path === '/chatgpt-pro-research/action') as Route

      // The old handler raised "action must be ..." before looking at the
      // body. A missing brief must now come from the continue branch itself.
      const missing = await call(route, chunkedRequest('/chatgpt-pro-research/action', [
        Buffer.from(JSON.stringify({ topic_id: seed.topicId, action: 'continue' }), 'utf8'),
      ]))
      expect(missing.status).toBe(400)
      expect(missing.json.error).toBe('brief is required')

      // A brief reaches engine.continue; the status guard is the engine's, not
      // the route's, which proves the fields were forwarded.
      const forwarded = await call(route, chunkedRequest('/chatgpt-pro-research/action', [
        Buffer.from(JSON.stringify({ topic_id: seed.topicId, action: 'continue', brief: 'next round' }), 'utf8'),
      ]))
      expect(forwarded.status).toBe(400)
      expect(forwarded.json.error).toContain('only completed/capped/reviewing')
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
