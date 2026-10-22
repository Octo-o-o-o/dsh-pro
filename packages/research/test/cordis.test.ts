import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

/**
 * Loads the plugin through a real Cordis context (not a hand-written stub):
 * this is the closest local check to what the DSH loader does, without booting
 * the desktop app.
 */
describe('cordis load', () => {
  it('applies once the injected services exist', async () => {
    const captured: { tools: unknown[]; routes: unknown[] } = { tools: [], routes: [] }
    const ctx = new Context()
    ctx.provide('tools', {
      register: (tool: unknown) => {
        captured.tools.push(tool)
        return () => {}
      },
    })
    ctx.provide('webServer', {
      register: (route: unknown) => {
        captured.routes.push(route)
        return () => {}
      },
    })
    ctx.provide('skills', { registerProvider: () => () => {} })
    ctx.provide('connection', { requestRejection: () => undefined })

    ctx.plugin({ name, inject, apply } as never, { store: 'local' })
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(captured.tools).toHaveLength(1)
    expect(captured.routes).toHaveLength(3)
  })
})
