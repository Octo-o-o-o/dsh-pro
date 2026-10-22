import { describe, expect, it } from 'vitest'
import { assertConfig, assertImageApiConfig, defaultConfig, resolveConfig } from '../src/config.ts'
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

  it('validates the api channel before the first billable request', () => {
    const config = defaultConfig(join('C:', 'tmp', 'pro'))
    const api = { ...config, channel: 'api' as const, image: { ...config.image, apiKey: 'test-key' } }
    expect(() => assertConfig(api)).not.toThrow()
    expect(() => assertConfig({ ...api, channel: 'cli' as never })).toThrow(/channel/)
    expect(() => assertConfig({ ...api, image: { ...api.image, baseUrl: 'not a url' } })).toThrow(/imageBaseUrl/)
    expect(() => assertConfig({ ...api, image: { ...api.image, baseUrl: 'ftp://example.com/v1' } })).toThrow(/http/)
    expect(() => assertConfig({ ...api, image: { ...api.image, model: ' ' } })).toThrow(/imageModel/)
    expect(() => assertConfig({ ...api, image: { ...api.image, timeoutSeconds: 5 } })).toThrow(/imageTimeoutSeconds/)
    expect(() => assertConfig({ ...api, image: { ...api.image, format: 'gif' as never } })).toThrow(/imageFormat/)
    expect(() => assertImageApiConfig({ ...api.image, apiKey: '' }, { requireKey: true })).toThrow(/imageApiKey/)
  })

  it('keeps the image settings object independent between resolutions', () => {
    const profile = defaultConfig(join('C:', 'tmp', 'pro'))
    const resolved = resolveConfig(profile, { designs: 2 })
    resolved.image.model = 'other-model'
    expect(profile.image.model).toBe('gpt-image-1')
  })
})
