import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MaterialRef } from './types.ts'

const SECRET_CONTENT: ReadonlyArray<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
]

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/** Glob support needed by `secretGlobs`: `**`, `*`, `?`, and literals. */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/')
  let out = '^'
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1
        if (normalized[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char ?? '')) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  out += '$'
  return new RegExp(out)
}

export function isSecretPath(relativePath: string, globs: readonly string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  return globs.some(glob => globToRegExp(glob).test(normalized))
}

/** Return the matched secret family name, or undefined when clean. */
export function findSecret(text: string): string | undefined {
  for (const [name, pattern] of SECRET_CONTENT) {
    if (pattern.test(text)) return name
  }
  return undefined
}

export async function buildManifest(
  root: string,
  relativePaths: readonly string[],
  reasons?: Readonly<Record<string, string>>,
): Promise<MaterialRef[]> {
  const refs: MaterialRef[] = []
  for (const relativePath of relativePaths) {
    const absolute = join(root, relativePath)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`material is not a file: ${relativePath}`)
    const bytes = await readFile(absolute)
    const text = bytes.toString('utf8')
    const secret = findSecret(text)
    if (secret !== undefined) throw new Error(`material contains a ${secret}: ${relativePath}`)
    refs.push({
      path: relativePath.replace(/\\/g, '/'),
      bytes: info.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(reasons?.[relativePath] !== undefined ? { reason: reasons[relativePath] } : {}),
    })
  }
  return refs
}

export function assertMaterialLimits(
  refs: readonly MaterialRef[],
  maxFiles: number,
  maxTotalMB: number,
): void {
  if (refs.length > maxFiles) throw new Error(`too many materials: ${refs.length} > ${maxFiles}`)
  const total = refs.reduce((sum, ref) => sum + ref.bytes, 0)
  if (total > maxTotalMB * 1024 * 1024) {
    throw new Error(`materials exceed ${maxTotalMB} MB`)
  }
}
