import { describe, expect, it } from 'vitest'
import { slugifyTitle } from '../src/slug.ts'

describe('slugifyTitle', () => {
  it('keeps readable ASCII titles', () => {
    expect(slugifyTitle('DSH plugin market')).toBe('dsh-plugin-market')
    expect(slugifyTitle('0.3.2 release notes')).toBe('0-3-2-release-notes')
  })

  it('does not turn a version-only title into a meaningless directory', () => {
    expect(slugifyTitle('0.3.2')).toMatch(/^topic-[0-9a-f]{4}$/)
    expect(slugifyTitle('（0.3.2 之后）')).toMatch(/^topic-[0-9a-f]{4}$/)
  })

  it('falls back when Chinese text leaves only a short ASCII fragment', () => {
    expect(slugifyTitle('DSH 插件市场对比')).toMatch(/^topic-[0-9a-f]{4}$/)
    expect(slugifyTitle('插件市场对比')).toMatch(/^topic-[0-9a-f]{4}$/)
  })
})
