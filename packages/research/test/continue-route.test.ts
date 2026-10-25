import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchStore } from '@dsh-pro/core'

/**
 * The panel's continue dialog only talks to POST /action. A route-only test
 * with a fake transport proves the whole path (body -> act -> engine.continue)
 * without launching Chrome.
 */
const state = vi.hoisted(() => ({
  submits: 0,
  transport: {
    probe: async () => ({ ok: true, loggedIn: true, model: 'pro', available: ['pro'] }),
    submit: async () => {
      state.submits += 1
      return {
        submissionId: `sub-${state.submits}`,
        fingerprint: 'fp',
        attachments: [],
        conversationUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000000',
      }
    },
    poll: ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
      if (signal?.aborted === true) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    }),
    fetch: async () => ({ answer: 'answer' }),
    cancel: async () => undefined,
  },
}))

vi.mock('@dsh-pro/transport', () => ({
  acquireSharedTransport: () => ({ transport: state.transport, release: () => undefined }),
  OpenAIImageTransport: class {},
}))

const { apply } = await import('../src/index.ts')

const cleanups: string[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
  state.submits = 0
})

interface Route {
  path: string
  handler: (req: unknown, res: unknown) => Promise<void> | void
}

function context(routes: Route[], messages: unknown[] = []) {
  const effect = (fn: () => () => void): (() => void) => fn()
  const webServer = { register: (route: Route) => { routes.push(route); return () => undefined } }
  const scoped = {
    effect,
    get: (name: string) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    webServer,
  }
  return {
    effect,
    tools: { register: () => () => undefined },
    get: (name: string) => name === 'agents' ? { get: () => ({ followup: (message: unknown) => messages.push(message) }) } : (name === 'skills' ? { registerProvider: () => () => undefined } : undefined),
    inject: (services: string[], callback: (scopedContext: unknown) => void) => {
      if (services.includes('webServer')) callback(scoped)
    },
  }
}

async function call(route: Route, body: unknown): Promise<{ status: number; json: any }> {
  let status = 0
  let text = ''
  const request = {
    url: route.path,
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  }
  const response = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: unknown) => { text = typeof chunk === 'string' ? chunk : '' },
    write: () => true,
  }
  await route.handler(request, response)
  return { status, json: text === '' ? undefined : JSON.parse(text) }
}

describe('panel continue route', () => {
  it('continues a completed topic and cancels the queued run through the route', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-continue-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-continue-project-'))
    cleanups.push(home, cwd)
    const store = new ResearchStore({
      mode: 'local',
      projectRoot: cwd,
      localRoot: join(home, 'chatgpt-pro-research'),
      rawDir: join(home, 'raw'),
      rawAnswers: 'local',
    })
    const { topic, dir } = await store.create({
      title: 'Continue me',
      type: 'research',
      question: 'Q?',
      successCriteria: ['c'],
      brief: 'b',
      materials: [],
      rounds: 1,
      store: 'local',
    }, 1, 'pro', 'web')
    topic.status = 'completed'
    // Model-authored stop text cannot establish human acceptance.
    topic.stopReason = '人工接受结果'
    topic.rounds.push({ n: 1, files: 0, verdict: 'accepted', answeredAt: new Date().toISOString() })
    await store.save(topic)
    await mkdir(join(home, 'chatgpt-pro-research'), { recursive: true })
    await writeFile(join(home, 'chatgpt-pro-research', 'registry.json'), JSON.stringify({
      version: 1,
      topics: [{ id: topic.id, root: cwd, mode: 'local', title: topic.title, updated: topic.updated, sessionId: 'fixture-session' }],
    }), 'utf8')

    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const routes: Route[] = []
      const messages: unknown[] = []
      apply(context(routes, messages) as never, { store: 'local' })
      const route = routes.find(item => item.path === '/chatgpt-pro-research/action') as Route
      const woke = await call(route, { action: 'wake', topic_id: topic.id })
      expect(woke.status).toBe(200)
      expect(JSON.stringify(messages)).toContain('尚不代表人工验收')
      expect(JSON.stringify(messages)).not.toContain('用户已接受')
      expect((await call(route, { action: 'accept', topic_id: topic.id })).status).toBe(200)
      expect((await store.load(topic.id)).acceptedAt).toBeDefined()
      messages.length = 0
      await call(route, { action: 'wake', topic_id: topic.id })
      expect(JSON.stringify(messages)).toContain('用户已接受')
      const continued = await call(route, { action: 'continue', topic_id: topic.id, brief: 'next round' })
      expect(continued.status).toBe(200)
      expect(continued.json.topic.status).toBe('queued')
      expect(continued.json.topic.rounds_cap).toBe(2)
      expect((await store.load(topic.id)).acceptedAt).toBeUndefined()
      expect(await readFile(join(dir, 'rounds', '02-question.md'), 'utf8')).toContain('next round')

      // Stop the background run so this test does not leave a poller behind.
      const cancelled = await call(route, { action: 'cancel', topic_id: topic.id })
      expect(cancelled.status).toBe(200)
      expect(cancelled.json.topic.status).toBe('cancelled')
      const saved = await store.load(topic.id)
      saved.status = 'capped'
      await store.save(saved)
      messages.length = 0
      expect((await call(route, { action: 'accept', topic_id: topic.id })).status).toBe(200)
      expect(JSON.stringify(messages)).toContain('用户已接受')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
