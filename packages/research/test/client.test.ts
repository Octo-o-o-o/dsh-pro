import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply } from '../client/index.tsx'

interface Registration {
  options: Record<string, unknown>
  render: () => unknown
}

describe('client panel', () => {
  it('registers the main page and the sidebar row, and disposes them', () => {
    const registrations: Registration[] = []
    let disposed = 0
    const ctx = {
      slots: {
        register: (options: Record<string, unknown>, render: () => unknown) => {
          registrations.push({ options, render })
          return () => { disposed += 1 }
        },
      },
      effect: (fn: () => () => void) => { void fn() },
    }
    apply(ctx as never)

    expect(registrations.map(item => item.options.name)).toEqual(['main', 'sidebar.panellist'])
    expect(registrations[0]?.options.key).toBe('pro-research')
    expect(registrations[1]?.options.id).toBe('pro-research')
    expect(registrations[1]?.options.order).toBe(21)
    expect((registrations[1]?.options.label as () => string)()).toBe('Pro')

    const icon = registrations[1]?.render()
    expect(icon).toBeTruthy()
    expect(disposed).toBe(0)
  })

  it('renders the panel shell without a browser', () => {
    const registrations: Registration[] = []
    const ctx = {
      slots: {
        register: (options: Record<string, unknown>, render: () => unknown) => {
          registrations.push({ options, render })
          return () => {}
        },
      },
      effect: () => {},
    }
    apply(ctx as never)

    const main = registrations[0]?.render()
    expect(main).toBeTruthy()
    const html = renderToString(main as Parameters<typeof renderToString>[0])
    expect(html).toContain('Pro 研究')
    expect(html).toContain('还没有研究任务')
  })
})
