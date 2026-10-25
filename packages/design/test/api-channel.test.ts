import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

interface Route { path: string; handler: (request: unknown, response: unknown) => Promise<void> }

function fakeContext(tools: Tool[], routes: Route[] = []): unknown {
  const skills = { registerProvider: () => () => {} }
  const scoped = {
    effect: (fn: () => () => void) => fn(),
    get: (name: string) => name === 'connection' ? { requestRejection: () => undefined } : undefined,
    webServer: { register: (route: Route) => { routes.push(route); return () => {} } },
  }
  return {
    effect: (fn: () => () => void) => fn(),
    tools: { register: (tool: Tool) => { tools.push(tool); return () => {} } },
    get: (name: string) => (name === 'skills' ? skills : undefined),
    inject: (_services: string[], callback: (scopedContext: unknown) => void) => callback(scoped),
  }
}

describe('design plugin on the api channel', () => {
  it.each(['local', 'project'] as const)('edits only the selected second artifact in %s storage', async mode => {
    const requests: Array<{ url: string; body: Buffer }> = []
    let rejectEdits = false
    const image = (n: number): Buffer => Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(2048, n)])
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      requests.push({ url: req.url ?? '', body: Buffer.concat(chunks) })
      res.writeHead(rejectEdits ? 404 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rejectEdits ? { error: { message: 'edits unsupported' } } : { data: [{ b64_json: image(requests.length).toString('base64') }] }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const home = await mkdtemp(join(tmpdir(), 'dsh-edit-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const previous = process.env.DSH_HOME; process.env.DSH_HOME = home
    try {
      const tools: Tool[] = []
      const routes: Route[] = []
      const cfg = { channel: 'api', imageBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, imageApiKey: 'test-key', imageModel: 'gpt-image-1', designs: 3, store: mode }
      apply(fakeContext(tools, routes) as never, cfg)
      const tool = tools[0]!
      const exec = { agent: { session: { header: { cwd: home }, id: 'fixture-session' } } }
      await writeFile(join(home, 'original.png'), image(9))
      const started = await tool.execute({ action: 'start', title: '选第二张', question: '三张图', brief: '三个方向', criteria: ['图片'], materials: ['original.png'], confirmed: true }, exec)
      const id = String(started.topic_id)
      const wait = async (): Promise<Record<string, unknown>> => {
        for (let i = 0; i < 300; i++) {
          const topic = await tool.execute({ action: 'status', topic_id: id }, exec)
          if (['capped', 'failed', 'stalled', 'completed'].includes(String(topic.status))) return topic
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error('test run did not stop')
      }
      expect((await wait()).status).toBe('capped')
      const store = new ResearchStore({ mode, projectRoot: home, localRoot: join(home, 'gpt-image-design'), rawDir: join(home, 'raw'), rawAnswers: 'local', docsSubdir: 'design' })
      const original = await store.load(id)
      const paths = original.rounds[0]!.artifacts!
      const base = paths[1]!
      const dir = await store.dirOf(id)
      const args = { action: 'continue', topic_id: id, brief: '保留布局，只改背景色', base_artifact: base, confirmed: true }
      for (const bad of ['../outside.png', 'artifacts/other-topic.png', `${dir}/${base}`]) {
        await expect(tool.execute({ ...args, base_artifact: bad }, exec)).rejects.toThrow('当前设计主题')
      }
      await expect(tool.execute({ ...args, designs: 2 }, exec)).rejects.toThrow('一个结果')
      const disabled: Tool[] = []
      apply(fakeContext(disabled) as never, { ...cfg, imageEdit: 'off' })
      await expect(disabled[0]!.execute(args, exec)).rejects.toThrow('imageEdit=off')
      expect(requests).toHaveLength(3)
      if (mode === 'project') {
        const route = routes.find(item => item.path === '/gpt-image-design/action')!
        let code = 0
        let body = ''
        await route.handler({ url: route.path, method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(args)) } }, {
          writeHead: (status: number) => { code = status }, end: (chunk: string) => { body = chunk },
        })
        expect(code, body).toBe(200)
        expect(JSON.parse(body).topic.status).toBe('queued')
      } else await tool.execute(args, exec)
      expect((await wait()).status).toBe('capped')
      expect(requests).toHaveLength(4)
      const edit = requests[3]!
      expect(edit.url).toBe('/v1/images/edits')
      expect(edit.body.includes(image(2))).toBe(true)
      expect(edit.body.includes(image(1))).toBe(false)
      expect(edit.body.includes(image(3))).toBe(false)
      expect(edit.body.includes(image(9))).toBe(false)
      const edited = await store.load(id)
      expect(edited.rounds).toHaveLength(2)
      expect(edited.rounds[1]).toMatchObject({ designs: 1, files: 1, baseArtifact: base })
      expect(await readFile(join(dir, base))).toEqual(image(2))
      expect(await readFile(join(dir, edited.rounds[1]!.artifacts![0]!))).toEqual(image(4))
      const restored: Tool[] = []
      apply(fakeContext(restored) as never, cfg)
      expect((await restored[0]!.execute({ action: 'status', topic_id: id }, exec)).rounds).toBe(2)
      expect(requests).toHaveLength(4)
      rejectEdits = true
      await tool.execute(args, exec)
      expect((await wait()).status).toBe('stalled')
      expect(requests).toHaveLength(5)
      expect(requests[4]!.url).toBe('/v1/images/edits')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }, 20_000)

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

describe('design regenerate with materials', () => {
  it('stages regenerate materials against the topic project root', async () => {
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
    await writeFile(join(cwd, 'palette.md'), '# 品牌色板\n主色 #b26a12', 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const tools: Tool[] = []
      apply(fakeContext(tools) as never, {
        channel: 'api',
        imageBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        imageApiKey: 'test-key',
        imageModel: 'gpt-image-1',
        designs: 1,
        store: 'local',
      })
      const tool = tools[0] as Tool
      const exec = { agent: { session: { header: { cwd }, id: 'session-1' } } }
      const started = await tool.execute({
        action: 'start',
        confirmed: true,
        title: 'API 卡片',
        question: '出一个方向',
        brief: '深色卡片',
        criteria: ['至少一张图'],
      }, exec)

      const untilCapped = Date.now() + 8_000
      let topic = started
      while (Date.now() < untilCapped) {
        topic = await tool.execute({ action: 'status', topic_id: started.topic_id }, exec)
        if (['capped', 'completed', 'stalled', 'failed'].includes(String(topic.status))) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(topic.status, String(topic.stop_reason)).toBe('capped')

      const regenerated = await tool.execute({
        action: 'regenerate',
        topic_id: started.topic_id,
        note: '换成浅色并带品牌色',
        materials: ['palette.md'],
        confirmed: true,
      }, exec)
      expect(regenerated.status).toBe('queued')

      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        topic = await tool.execute({ action: 'status', topic_id: started.topic_id }, exec)
        if (['capped', 'completed', 'stalled', 'failed'].includes(String(topic.status))) break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(['capped', 'completed'], String(topic.stop_reason)).toContain(topic.status)

      const store = new ResearchStore({
        mode: 'local',
        projectRoot: cwd,
        localRoot: join(home, 'gpt-image-design'),
        rawDir: join(home, 'raw'),
        rawAnswers: 'local',
        docsSubdir: 'design',
      })
      const stored = await store.load(String(started.topic_id))
      const dir = await store.dirOf(stored.id)
      const manifest = JSON.parse(await readFile(join(dir, 'materials', 'manifest.json'), 'utf8')) as {
        materials: Array<{ path: string }>
      }
      expect(manifest.materials.map(item => item.path)).toContain('palette.md')
      const roundMaterials = JSON.parse(await readFile(join(dir, 'rounds', '02-materials.json'), 'utf8')) as {
        materials: Array<{ path: string }>
      }
      expect(roundMaterials.materials.map(item => item.path)).toContain('palette.md')
      expect(await readFile(join(dir, 'materials', 'palette.md'), 'utf8')).toContain('品牌色板')
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  }, 20_000)
})
