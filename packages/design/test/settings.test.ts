import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, resolveDesignConfig } from '../src/index.ts'
import { resolveResearchConfig } from '../../research/src/index.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

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

describe('design settings', () => {
  it('shares one fixed Chrome profile across both plugins', () => {
    const design = resolveDesignConfig({})
    const research = resolveResearchConfig({})
    expect(design.browser.profileDir).toBe(research.browser.profileDir)
    expect(design.browser.profileDir).toMatch(/pro-research[\\/]browser$/)
  })

  it('maps flat settings into the image config and falls back to the environment key', () => {
    const previous = process.env.GPT_IMAGE_API_KEY
    try {
      delete process.env.GPT_IMAGE_API_KEY
      const settings = resolveDesignConfig({
        channel: 'api',
        imageBaseUrl: 'https://gateway.example/v1',
        imageApiKey: '   ',
        imageModel: 'gpt-image-1',
        imageSize: '1536x1024',
        imageQuality: 'high',
        imageFormat: 'webp',
        imageAuth: 'api-key',
        imageEdit: 'off',
        imageTimeoutSeconds: 120,
      })
      expect(settings.channel).toBe('api')
      expect(settings.image).toMatchObject({
        baseUrl: 'https://gateway.example/v1',
        apiKey: '',
        model: 'gpt-image-1',
        size: '1536x1024',
        quality: 'high',
        format: 'webp',
        auth: 'api-key',
        editMode: 'off',
        timeoutSeconds: 120,
      })

      process.env.GPT_IMAGE_API_KEY = 'env-key'
      expect(resolveDesignConfig({ channel: 'api' }).image.apiKey).toBe('env-key')
      expect(resolveDesignConfig({ channel: 'api', imageApiKey: 'settings-key' }).image.apiKey).toBe('settings-key')
      expect(resolveDesignConfig({}).channel).toBe('web')
    } finally {
      if (previous === undefined) delete process.env.GPT_IMAGE_API_KEY
      else process.env.GPT_IMAGE_API_KEY = previous
    }
  })

  it('defers image enum validation to the first api request', async () => {
    expect(resolveDesignConfig({ imageFormat: 'gif' }).image.format).toBe('gif')
    expect(resolveDesignConfig({ imageAuth: 'basic' }).image.auth).toBe('basic')
    expect(resolveDesignConfig({ imageEdit: 'always' }).image.editMode).toBe('always')

    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-design-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-design-project-'))
    cleanups.push(home, cwd)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const tools: Tool[] = []
      apply(fakeContext(tools) as never, {
        channel: 'api',
        imageApiKey: 'test-key',
        imageFormat: 'gif',
        store: 'local',
      })
      await expect((tools[0] as Tool).execute({
        action: 'start',
        confirmed: true,
        title: 'API 首屏',
        question: 'q',
        brief: 'b',
        criteria: ['c'],
      }, { agent: { session: { header: { cwd }, id: 's1' } } })).rejects.toThrow(/imageFormat/)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('refuses to start without a key and needs no browser for login or probe', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pro-design-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-pro-design-project-'))
    cleanups.push(home, cwd)
    const previousHome = process.env.DSH_HOME
    const previousKey = process.env.GPT_IMAGE_API_KEY
    process.env.DSH_HOME = home
    delete process.env.GPT_IMAGE_API_KEY
    try {
      const tools: Tool[] = []
      apply(fakeContext(tools) as never, { channel: 'api', store: 'local' })
      const tool = tools[0] as Tool
      const exec = { agent: { session: { header: { cwd }, id: 's1' } } }
      await expect(tool.execute({
        action: 'start',
        confirmed: true,
        title: 'API 首屏',
        question: '出三个方向',
        brief: '深色科技风',
        criteria: ['至少一张完整首屏'],
      }, exec)).rejects.toThrow(/imageApiKey/)

      await expect(tool.execute({ action: 'login' }, exec)).resolves.toMatchObject({
        login: { ok: true, channel: 'api' },
      })
      await expect(tool.execute({ action: 'probe' }, exec)).resolves.toMatchObject({
        channel: 'api',
        probe: { ok: false },
      })
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousKey === undefined) delete process.env.GPT_IMAGE_API_KEY
      else process.env.GPT_IMAGE_API_KEY = previousKey
    }
  })
  it('clamps out-of-range numeric settings instead of breaking the plugin', () => {
    const settings = resolveDesignConfig({ stallMinutes: 0, maxRoundMinutes: 0, maxFiles: -3, maxTotalMB: -1 })
    expect(settings.stallMinutes).toBe(45)
    expect(settings.maxRoundMinutes).toBeGreaterThanOrEqual(settings.stallMinutes)
    expect(settings.maxFiles).toBe(12)
    expect(settings.maxTotalMB).toBe(24)
    const research = resolveResearchConfig({ stallMinutes: 0, maxRoundMinutes: 1 })
    expect(research.stallMinutes).toBe(45)
    expect(research.maxRoundMinutes).toBe(45)
  })
})
