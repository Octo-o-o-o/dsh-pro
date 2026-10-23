import { describe, expect, it } from 'vitest'
import { detectImageMime, parseDataUrlImage } from '../src/assets.ts'

describe('data URL images', () => {
  it('decodes a base64 image and strips line breaks', () => {
    expect(parseDataUrlImage('data:image/jpeg;base64,AAEC\nAwQ=')).toEqual({
      mime: 'image/jpeg',
      base64: 'AAECAwQ=',
    })
  })

  it('ignores non-data and non-base64 sources', () => {
    expect(parseDataUrlImage('https://example.test/a.png')).toBeUndefined()
    expect(parseDataUrlImage('data:image/png,raw')).toBeUndefined()
  })
})

describe('detectImageMime', () => {
  it('detects png, jpeg, webp and gif by magic bytes', () => {
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    expect(detectImageMime(webp)).toBe('image/webp')
    expect(detectImageMime(Buffer.from('GIF89a......', 'ascii'))).toBe('image/gif')
  })

  it('returns undefined for non-image bytes', () => {
    expect(detectImageMime(Buffer.from('<!doctype html>', 'utf8'))).toBeUndefined()
    expect(detectImageMime(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeUndefined()
  })
})
