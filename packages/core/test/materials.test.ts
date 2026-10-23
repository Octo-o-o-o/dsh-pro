import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertMaterialLimits, buildManifest, findSecret, globToRegExp, isSecretPath } from '../src/materials.ts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('secret path matching', () => {
  it('matches env and key files at any depth', () => {
    expect(isSecretPath('.env', ['.env', '.env.*'])).toBe(true)
    expect(isSecretPath('.env.local', ['.env'])).toBe(false)
    expect(isSecretPath('.env.local', ['.env.*'])).toBe(true)
    expect(isSecretPath('config/.env', ['**/.env'])).toBe(true)
    expect(isSecretPath('secrets/db.txt', ['**/secrets/**'])).toBe(true)
    expect(isSecretPath('src/index.ts', ['*.pem', '.env'])).toBe(false)
  })

  it('translates globstar without collapsing path segments', () => {
    expect(globToRegExp('**/*.key').test('a/b/c.key')).toBe(true)
    expect(globToRegExp('**/*.key').test('a/b/c.key.txt')).toBe(false)
    expect(globToRegExp('a/*/c').test('a/b/c')).toBe(true)
    expect(globToRegExp('a/*/c').test('a/b/d/c')).toBe(false)
  })
})

describe('secret content scan', () => {
  it('finds high-signal credentials', () => {
    expect(findSecret('key=sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('openai-key')
    expect(findSecret('token ghp_abcdefghijklmnopqrstuvwxyz')).toBe('github-token')
    expect(findSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('private-key')
    expect(findSecret('nothing to see here')).toBeUndefined()
  })
})

describe('manifest', () => {
  it('hashes files and refuses secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-mat-'))
    cleanups.push(root)
    await writeFile(join(root, 'a.md'), 'hello', 'utf8')
    const manifest = await buildManifest(root, ['a.md'])
    expect(manifest[0]?.path).toBe('a.md')
    expect(manifest[0]?.bytes).toBe(5)
    expect(manifest[0]?.sha256).toHaveLength(64)

    await writeFile(join(root, 'b.md'), 'token=ghp_abcdefghijklmnopqrstuvwxyz', 'utf8')
    await expect(buildManifest(root, ['b.md'])).rejects.toThrow(/github-token/)
  })

  it('rejects traversal, absolute paths and secret globs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pro-mat-'))
    cleanups.push(root)
    await writeFile(join(root, 'a.md'), 'hello', 'utf8')
    await writeFile(join(root, '.env'), 'A=1', 'utf8')
    await expect(buildManifest(root, ['../outside.md'])).rejects.toThrow(/escapes/)
    await expect(buildManifest(root, [join(root, 'a.md')])).rejects.toThrow(/relative/)
    await expect(buildManifest(root, ['.env'], undefined, ['.env'])).rejects.toThrow(/secret pattern/)
  })

  it('enforces count and size caps', () => {
    const ref = { path: 'a', bytes: 1024, sha256: 'x' }
    expect(() => assertMaterialLimits([ref], 1, 1)).not.toThrow()
    expect(() => assertMaterialLimits([ref, ref], 1, 1)).toThrow(/too many/)
    expect(() => assertMaterialLimits([{ ...ref, bytes: 2 * 1024 * 1024 }], 2, 1)).toThrow(/MB/)
  })
})
