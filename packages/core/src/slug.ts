import { createHash, randomBytes } from 'node:crypto'

/** Four hex chars; used for ids and collision suffixes. */
export function shortHash(value: string, length = 4): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export function newTopicId(seed: string): string {
  return `topic-${shortHash(`${seed}:${Date.now()}:${randomBytes(4).toString('hex')}`)}`
}

/**
 * Directory name for a topic. ASCII titles become kebab-case; anything else
 * falls back to `topic-<hash4>`. Callers append a hash on collision.
 */
export function slugifyTitle(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return ascii.length > 0 ? ascii : `topic-${shortHash(title)}`
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
