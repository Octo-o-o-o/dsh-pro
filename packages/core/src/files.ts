import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class FileSizeLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`file exceeds ${maxBytes} byte limit`)
    this.name = 'FileSizeLimitError'
  }
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/** Resolve a caller-relative path without trusting links inside the authorized root. */
export async function resolveContainedPath(root: string, path: string): Promise<string> {
  const normalized = path.replace(/\\/g, '/')
  if (isAbsolute(path) || normalized.split('/').includes('..')) throw new Error('file path escapes its authorized directory')
  const original = resolve(root, normalized)
  if (!contains(resolve(root), original)) throw new Error('file path escapes its authorized directory')
  const [canonicalRoot, canonical] = await Promise.all([realpath(root), realpath(original)])
  if (!contains(canonicalRoot, canonical)) throw new Error('file path escapes its authorized directory')
  return canonical
}

/**
 * Validate each existing parent before creating the next one. A recursive mkdir
 * would otherwise create outside children before noticing an escaped junction.
 * The returned parent is canonical; writers must not re-open the lexical alias.
 */
export async function resolveWritablePath(root: string, path: string): Promise<string> {
  const normalized = path.replace(/\\/g, '/')
  const absoluteRoot = resolve(root)
  const original = resolve(root, normalized)
  if (isAbsolute(path) || normalized.split('/').includes('..') || original === absoluteRoot || !contains(absoluteRoot, original)) {
    throw new Error('file path escapes its writable directory')
  }
  await mkdir(absoluteRoot, { recursive: true })
  const canonicalRoot = await realpath(absoluteRoot)
  let parent = canonicalRoot
  const parents = relative(absoluteRoot, dirname(original)).split(sep).filter(Boolean)
  for (const part of parents) {
    const next = join(parent, part)
    try { await mkdir(next) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    parent = await realpath(next)
    if (!contains(canonicalRoot, parent)) throw new Error('file path escapes its writable directory')
    if (!(await lstat(parent)).isDirectory()) throw new Error('file parent must be a directory')
  }
  const target = join(parent, basename(original))
  try {
    const info = await lstat(target)
    // Never follow a final-file symlink, including a dangling link. Hard-linked
    // append logs could likewise alter a file outside this authorized root.
    if (info.isSymbolicLink() || info.nlink > 1) throw new Error('file link escapes its writable directory')
    if (!info.isFile()) throw new Error('file must be a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

async function readBounded(root: string, path: string, maxBytes: number, prefix: boolean): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid file byte limit')
  const canonical = await resolveContainedPath(root, path)
  const file = await open(canonical, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('file must be a regular file')
    // Reject large files before allocating their contents, and keep checking
    // the actual stream in case a file grows after stat().
    if (!prefix && info.size > maxBytes) throw new FileSizeLimitError(maxBytes)
    const chunks: Buffer[] = []
    let total = 0
    const capacity = prefix ? maxBytes : maxBytes + 1
    while (total < capacity) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, capacity - total))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (!prefix && total > maxBytes) throw new FileSizeLimitError(maxBytes)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total)
  } finally {
    await file.close()
  }
}

/** Read a complete regular file, with a hard bound on bytes actually read. */
export function readContainedFile(root: string, path: string, maxBytes: number): Promise<Buffer> {
  return readBounded(root, path, maxBytes, false)
}

/** Read only a bounded header/preview; a large file is deliberately not loaded. */
export function readContainedPrefix(root: string, path: string, maxBytes: number): Promise<Buffer> {
  return readBounded(root, path, maxBytes, true)
}
