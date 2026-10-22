import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const answer = await readFile('C:/Users/satan/.dsh/gpt-image-design/raw/topic-ca9a/01-answer.md', 'utf8')
const dir = 'C:/WorkSpace/dsh-plugins/dsh-pro/docs/design/dsh-pro-website/artifacts/round-01'
await mkdir(dir, { recursive: true })
let count = 0
for (const match of answer.matchAll(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/gi)) {
  const [, mime, base64] = match
  if (mime === undefined || base64 === undefined) continue
  count += 1
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
  const path = join(dir, `image-${String(count).padStart(2, '0')}.${ext}`)
  await writeFile(path, Buffer.from(base64, 'base64'))
  console.log('wrote', path, Buffer.byteLength(base64, 'base64'))
}
console.log('total', count)
