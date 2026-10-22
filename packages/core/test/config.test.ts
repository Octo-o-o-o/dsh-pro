import { describe, expect, it } from 'vitest'
import { assertConfig, defaultConfig, resolveConfig } from '../src/config.ts'
import { join } from 'node:path'

describe('config', () => {
  it('applies designs with project < run precedence', () => {
    const profile = defaultConfig(join('C:', 'tmp', 'pro'))
    expect(resolveConfig(profile, { designs: 2 }, { designs: 5 }).designs).toBe(5)
    expect(resolveConfig(profile, { designs: 2 }).designs).toBe(2)
    expect(resolveConfig(profile).designs).toBe(3)
  })

  it('rejects out-of-range designs', () => {
    const config = defaultConfig(join('C:', 'tmp', 'pro'))
    expect(() => assertConfig({ ...config, designs: 0 })).toThrow(/designs/)
    expect(() => assertConfig({ ...config, designs: 7 })).toThrow(/designs/)
  })
})
