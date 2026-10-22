/** Decode a `data:` image URL without trusting its size or payload shape. */
export function parseDataUrlImage(source: string): { mime: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(source)
  if (match === null) return undefined
  const mime = match[1]
  const base64 = match[2]
  if (mime === undefined || base64 === undefined) return undefined
  return { mime, base64: base64.replace(/\s/g, '') }
}
