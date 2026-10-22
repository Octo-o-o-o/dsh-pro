import { describe, expect, it } from 'vitest'
import { parseDataUrlImage } from '../src/assets.ts'

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
