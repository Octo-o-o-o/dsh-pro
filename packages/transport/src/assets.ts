/** Decode a `data:` image URL without trusting its size or payload shape. */
export function parseDataUrlImage(source: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(source)
  if (match === null) return undefined
  const mime = match[1]
  const base64 = match[2]
  if (mime === undefined || base64 === undefined) return undefined
  return { mime, base64: base64.replace(/\s/g, '') }
}

/** Magic bytes win over provider/server headers; some gateways always claim image/png. */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp'
  if (
    bytes.length >= 6
    && String.fromCharCode(...bytes.subarray(0, 3)) === 'GIF'
    && (bytes[3] === 0x38) // '8'
  ) return 'image/gif'
  return undefined
}

export const MAX_IMAGE_ASSET_BYTES = 50 * 1024 * 1024
