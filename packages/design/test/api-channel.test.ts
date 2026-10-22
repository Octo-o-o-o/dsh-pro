import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchStore } from '@dsh-pro/core'
import { apply } from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()
    if (cleanup !== undefined) await cleanup()
  }
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2_048, 5),
])

interface Tool {
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>
}

function fakeContext(tools: Tool[]): unknown {
  const skills = { registerProvider: () => () => {} }
  const scoped = {
    effect: (fn: () => () => void) => fn(),
    get: () => undefined,
    webServer: { register: () => () => {} },
  }
  return {
    effect: (fn: () => () => void) => fn(),
    tools: { register: (tool: Tool) => { tools.push(tool); return () => {} } },
    get: (name: string) => (name === 'skills' ? skills : undefined),
    inject: (_services: string[], callback: (scopedContext: unknown) => void) => callback(scoped),
  }
}

describe('design plugin on the api channel', () => {
  it('generates images, stores them under artifacts and caps at one round', async () => {
    const requests: Array<{ url: string; body: string }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      requests.push({ url: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    const address = server.address() as AddressInfo

    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-design-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-design-project-'))
    cleanups.push(
      () => rm(home, { recursive: true, force: true }),
      () => rm(cwd, { recursive: true, force: true }),
    )
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const tools: Tool[] = []
      apply(fakeContext(tools) as never, {
        channel: 'api',
        imageBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        imageApiKey: 'test-key',
        imageModel: 'gpt-image-1',
        imageSize: '1024x1024',
        designs: 2,
        rounds: 3,
        store: 'local',
      })
      const tool = tools[0] as Tool
      const exec = { agent: { session: { header: { cwd }, id: 'session-1' } } }
      const started = await tool.execute({
        action: 'start',
        confirmed: true,
        title: 'API 首屏',
        question: '出两个方向的首屏',
        brief: '深色科技风，中文大标题',
        criteria: ['至少一张完整首屏'],
      }, exec)
      expect(started.status).toBe('queued')

      const deadline = Date.now() + 8_000
      let topic = started
      while (Date.now() < deadline) {
        topic = await tool.execute({ action: 'status', topic_id: started.topic_id }, exec)
        if (['capped', 'completed', 'stalled', 'failed'].includes(String(topic.status))) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }

      expect(topic.status, String(topic.stop_reason)).toBe('capped')
      expect(topic.channel).toBe('api')
      expect(topic.model).toBe('gpt-image-1')
      expect(topic.rounds).toBe(1)
      expect(topic.rounds_cap).toBe(1)

      const store = new ResearchStore({
        mode: 'local',
        projectRoot: cwd,
        localRoot: join(home, 'gpt-image-design'),
        rawDir: join(home, 'raw'),
        rawAnswers: 'local',
        docsSubdir: 'design',
      })
      const stored = await store.load(String(started.topic_id))
      const images = stored.artifacts.filter(path => path.endsWith('.png'))
      expect(images).toHaveLength(2)
      const dir = await store.dirOf(stored.id)
      const bytes = await readFile(join(dir, images[0] as string))
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      expect(requests).toHaveLength(2)
      expect(requests[0]?.url).toBe('/v1/images/generations')
      expect(requests[0]?.body).toContain('第 1 个方向（共 2 个）')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})
