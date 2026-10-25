import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { MaterialRef, Topic } from './types.ts'

function assertRaster(bytes: Buffer, path: string): void {
  const ext = extname(path).toLowerCase()
  const png = ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpg = /^\.jpe?g$/.test(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  const webp = ext === '.webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!png && !jpg && !webp) throw new Error('底图必须是有效的 PNG、JPEG 或 WebP 图片')
}

/** Recheck the immutable staged copy immediately before every dispatch. */
export async function verifyStagedBaseImage(topicDir: string, ref: MaterialRef): Promise<void> {
  const topicRoot = await realpath(topicDir)
  const root = await realpath(join(topicDir, 'materials'))
  if (!root.startsWith(`${topicRoot}${sep}`)) throw new Error('底图材料目录超出主题目录，停止发送')
  const path = await realpath(ref.path)
  if (!path.startsWith(`${root}${sep}`)) throw new Error('底图材料路径超出主题目录，停止发送')
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('底图材料已变化，停止发送')
  assertRaster(bytes, path)
}

/** Only an owned, recorded raster artifact can become an explicit edit base. */
export async function baseImageMaterial(dir: string, topic: Topic, path: string): Promise<MaterialRef> {
  if (topic.type !== 'design' || isAbsolute(path) || path.includes('\\')
    || path.split('/').includes('..') || !path.startsWith('artifacts/')
    || !topic.artifacts.includes(path) || !topic.rounds.some(round => round.artifacts?.includes(path))) {
    throw new Error('底图必须是当前设计主题已记录的图片产物')
  }
  const root = await realpath(resolve(dir))
  const source = await realpath(resolve(dir, path))
  if (!source.startsWith(`${root}${sep}`)) throw new Error('底图路径超出主题目录')
  const bytes = await readFile(source)
  const ext = extname(path).toLowerCase()
  assertRaster(bytes, path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { path: `edit-base/${sha256}${ext}`, source, bytes: bytes.byteLength, sha256, reason: `修改底图：${path}` }
}
