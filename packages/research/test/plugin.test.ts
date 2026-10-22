import { describe, expect, it } from 'vitest'
import { apply, resolveResearchConfig } from '../src/index.ts'

interface Captured {
  tools: Array<Record<string, unknown>>
  routes: string[]
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
    register: (route: { path: string }) => {
      captured.routes.push(route.path)
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
  it('registers one tool, three routes and two skills', async () => {
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

    expect(captured.routes.sort()).toEqual([
      '/pro-research/action',
      '/pro-research/topic',
      '/pro-research/topics',
    ])
    expect(captured.skills.map(skill => skill.name).sort()).toEqual(['pro-design', 'pro-research'])
  })

  it('merges settings over defaults and keeps three-layer precedence', () => {
    const resolved = resolveResearchConfig({ rounds: 5, store: 'local', headless: true })
    expect(resolved.rounds).toBe(5)
    expect(resolved.store).toBe('local')
    expect(resolved.browser.headless).toBe(true)
    expect(resolved.rawAnswers).toBe('local')
    expect(resolved.maxFiles).toBe(12)
  })
})
