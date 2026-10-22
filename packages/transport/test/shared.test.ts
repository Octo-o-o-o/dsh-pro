import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatGptWebTransport } from '../src/chatgpt.ts'
import { acquireSharedTransport } from '../src/shared.ts'

describe('shared transport registry', () => {
  it('reuses one transport per profile and closes on the last release', async () => {
    let closed = 0
    const fake = { close: async () => { closed += 1 } } as unknown as ChatGptWebTransport
    const options = { profileDir: join(tmpdir(), `dsh-shared-${randomUUID()}`) }

    const first = acquireSharedTransport(options, () => fake)
    const second = acquireSharedTransport(options, () => {
      throw new Error('must reuse the existing transport')
    })
    expect(second.transport).toBe(first.transport)

    first.release()
    expect(closed).toBe(0)
    second.release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closed).toBe(1)
  })
})
