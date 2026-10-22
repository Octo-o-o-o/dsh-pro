import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply } from '../client/index.tsx'

interface Registration {
  options: Record<string, unknown>
  render: () => unknown
}

describe('client panel', () => {
  it('registers the main page and the sidebar row under their declaration lifetimes', () => {
    const registrations: Registration[] = []
    const effects: Array<() => void> = []
    let disposed = 0
    const ctx = {
      slots: {
        inject: (_name: string, register: () => () => void) => {
          const dispose = register()
          effects.push(dispose)
          return dispose
        },
        register: (options: Record<string, unknown>, render: () => unknown) => {
          registrations.push({ options, render })
          return () => { disposed += 1 }
        },
      },
    }
    apply(ctx as never)

    expect(registrations.map(item => item.options.name)).toEqual(['main', 'sidebar.panellist'])
    expect(registrations[0]?.options.key).toBe('chatgpt-pro-research')
    expect(registrations[1]?.options.id).toBe('chatgpt-pro-research')
    expect(registrations[1]?.options.order).toBe(21)
    expect((registrations[1]?.options.label as () => string)()).toBe('Pro Research')

    const icon = registrations[1]?.render()
    expect(icon).toBeTruthy()
    expect(disposed).toBe(0)
    for (const dispose of effects) dispose()
    expect(disposed).toBe(2)
  })

  it('waits for layout and sidebar to declare their slots independently', () => {
    const pending = new Map<string, () => void>()
    const registrations: string[] = []
    const ctx = {
      slots: {
        inject: (name: string, register: () => void) => {
          pending.set(name, register)
          return () => { pending.delete(name) }
        },
        register: (options: Record<string, unknown>) => {
          registrations.push(String(options.name))
          return () => {}
        },
      },
    }
    apply(ctx as never)
    expect(registrations).toEqual([])
    pending.get('sidebar.panellist')?.()
    expect(registrations).toEqual(['sidebar.panellist'])
    pending.get('main')?.()
    expect(registrations).toEqual(['sidebar.panellist', 'main'])
  })

  it('renders the panel shell without a browser', () => {
    const registrations: Registration[] = []
    const ctx = {
      slots: {
        inject: (_name: string, register: () => () => void) => register(),
        register: (options: Record<string, unknown>, render: () => unknown) => {
          registrations.push({ options, render })
          return () => {}
        },
      },
    }
    apply(ctx as never)

    const main = registrations[0]?.render()
    expect(main).toBeTruthy()
    const html = renderToString(main as Parameters<typeof renderToString>[0])
    expect(html).toContain('ChatGPT Pro Research')
    expect(html).toContain('还没有研究任务')
  })
})
