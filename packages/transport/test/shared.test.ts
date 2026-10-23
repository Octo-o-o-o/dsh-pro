import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatGptWebTransport } from '../src/chatgpt.ts'
import { acquireSharedTransport } from '../src/shared.ts'

describe('shared transport registry', () => {
  it('reuses one transport per profile and closes on the last release', async () => {
    let closed = 0
    const fake = { close: async () => { closed += 1 } } as unknown as ChatGptWebTransport
    const options = { profileDir: join(tmpdir(), `dsh-shared-${randomUUID()}`) }
    const lockFile = `${resolve(options.profileDir)}.dsh-pro.lock`

    const first = acquireSharedTransport(options, () => fake)
    expect(existsSync(lockFile)).toBe(true)
    const second = acquireSharedTransport(options, () => {
      throw new Error('must reuse the existing transport')
    })
    expect(second.transport).toBe(first.transport)

    first.release()
    expect(closed).toBe(0)
    expect(existsSync(lockFile)).toBe(true)
    second.release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closed).toBe(1)
    expect(existsSync(lockFile)).toBe(false)
    rmSync(options.profileDir, { recursive: true, force: true })
  })

  it('refuses a profile lease owned by another live process', () => {
    const options = { profileDir: join(tmpdir(), `dsh-shared-${randomUUID()}`) }
    const lockFile = `${resolve(options.profileDir)}.dsh-pro.lock`
    mkdirSync(dirname(lockFile), { recursive: true })
    writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, token: 'other', startedAt: new Date().toISOString() }))
    expect(() => acquireSharedTransport(options, () => ({ close: async () => {} } as unknown as ChatGptWebTransport)))
      .toThrow(/already owned/)
    rmSync(lockFile, { force: true })
    rmSync(options.profileDir, { recursive: true, force: true })
  })

  it('recovers a stale profile lease', () => {
    const options = { profileDir: join(tmpdir(), `dsh-shared-${randomUUID()}`) }
    const lockFile = `${resolve(options.profileDir)}.dsh-pro.lock`
    mkdirSync(dirname(lockFile), { recursive: true })
    writeFileSync(lockFile, JSON.stringify({ pid: 999_999_999, token: 'other', startedAt: new Date().toISOString() }))
    // A dead PID is recoverable: the lease is stolen.
    const recovered = acquireSharedTransport(options, () => ({ close: async () => {} } as unknown as ChatGptWebTransport))
    expect(recovered.transport).toBeTruthy()
    recovered.release()
    rmSync(options.profileDir, { recursive: true, force: true })
  })
})
