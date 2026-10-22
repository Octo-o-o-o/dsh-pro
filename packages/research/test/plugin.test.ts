import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  it('registers one tool, four routes and one skill', async () => {
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
      '/chatgpt-pro-research/asset',
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

async function call(route: Route, request: Record<string, unknown>): Promise<{ status: number; json: any }> {
  let status = 0
  let body = ''
  const response = {
    statusCode: 0,
    writeHead: (code: number) => { status = code },
    write: () => true,
    end: (chunk?: unknown) => { body = typeof chunk === 'string' ? chunk : '' },
  }
  await route.handler(request, response)
  return { status, json: body === '' ? undefined : JSON.parse(body) }
}
