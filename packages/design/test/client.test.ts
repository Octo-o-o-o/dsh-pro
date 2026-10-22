import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply } from '../client/index.tsx'

describe('design client panel', () => {
  it('registers the design page under its own key and label', () => {
    const registrations: Array<{ options: Record<string, unknown>; render: () => unknown }> = []
    const ctx = {
      slots: {
        inject: (_name: string, register: () => () => void) => {
          void register()
          return () => {}
        },
        register: (options: Record<string, unknown>, render: () => unknown) => {
          registrations.push({ options, render })
          return () => {}
        },
      },
    }
    apply(ctx as never)

    expect(registrations.map(item => item.options.name)).toEqual(['main', 'sidebar.panellist'])
    expect(registrations[0]?.options.key).toBe('gpt-image-design')
    expect(registrations[1]?.options.id).toBe('gpt-image-design')
    expect((registrations[1]?.options.label as () => string)()).toBe('Image Design')

    const main = registrations[0]?.render()
    expect(renderToString(main as Parameters<typeof renderToString>[0])).toContain('GPT-Image Design')
  })
})
