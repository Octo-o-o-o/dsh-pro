import { createHash, randomBytes } from 'node:crypto'

/** Hex prefix; four chars are enough for a directory suffix, not for a topic id. */
export function shortHash(value: string, length = 4): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

/**
 * Topic ids double as user-facing tool input, registry keys, raw-answer folder
 * names and session-locator names. Four hex chars (65k space) collided in
 * realistic topic counts and silently merged two topics; ten hex chars give a
 * 2^40 space while staying short enough to copy by hand.
 */
export function newTopicId(seed: string): string {
  return `topic-${shortHash(`${seed}:${Date.now()}:${randomBytes(8).toString('hex')}`, 10)}`
}

/**
 * Directory name for a topic. ASCII titles become kebab-case; anything else
 * falls back to `topic-<hash4>`. Callers append a hash on collision.
 *
 * A title that only has digits/version punctuation (`0.3.2`) or a stray short
 * ASCII fragment (`DSH 插件对比` -> `dsh`) is not a readable directory name, so
 * it falls back to the hash form instead of producing `0-3-2` / `dsh`.
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
  const letters = ascii.replace(/[^a-z]/g, '')
  const readable = ascii.length >= 5 && letters.length >= 3
  return readable ? ascii : `topic-${shortHash(title)}`
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
