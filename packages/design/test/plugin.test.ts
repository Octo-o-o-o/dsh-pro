import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

interface Captured {
  tools: Array<Record<string, unknown>>
  routes: string[]
  skills: string[]
}

function fakeContext(captured: Captured) {
  const skills = {
    registerProvider: (factory: (control: { signal: AbortSignal }) => unknown) => {
      const provider = factory({ signal: new AbortController().signal }) as {
        list: () => Promise<Array<{ name: string }>>
      }
      void provider.list().then(items => { captured.skills = items.map(item => item.name) })
      return () => {}
    },
  }
  const webServer = {
    register: (route: { path: string }) => {
      captured.routes.push(route.path)
      return () => {}
    },
  }
  const scoped = { effect: (fn: () => () => void) => fn(), get: () => undefined, webServer }
  return {
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
}

describe('design plugin wiring', () => {
  it('registers the image tool, four routes and the design skill', async () => {
    const captured: Captured = { tools: [], routes: [], skills: [] }
    apply(fakeContext(captured) as never, { store: 'local' })
    await Promise.resolve()
    await Promise.resolve()

    expect(captured.tools).toHaveLength(1)
    expect((captured.tools[0] as { name?: string }).name).toBe('gpt_image_design')
    expect(JSON.stringify(captured.tools[0])).toContain('designs')
    expect(captured.routes.sort()).toEqual([
      '/gpt-image-design/action',
      '/gpt-image-design/answer',
      '/gpt-image-design/asset',
      '/gpt-image-design/open',
      '/gpt-image-design/topic',
      '/gpt-image-design/topics',
    ])
    expect(captured.skills).toEqual(['pro-design'])
  })
})
