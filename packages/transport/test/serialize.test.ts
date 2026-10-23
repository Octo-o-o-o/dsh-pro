import { describe, expect, it } from 'vitest'
import { SerialGate } from '../src/serialize.ts'

describe('SerialGate', () => {
  it('never runs two tasks concurrently and preserves order', async () => {
    const gate = new SerialGate()
    const events: string[] = []
    const task = (name: string, delayMs: number): (() => Promise<string>) => async () => {
      events.push(`${name}:start`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      events.push(`${name}:end`)
      return name
    }
    const [a, b, c] = await Promise.all([
      gate.exec(task('a', 60)),
      gate.exec(task('b', 20)),
      gate.exec(task('c', 0)),
    ])
    expect([a, b, c]).toEqual(['a', 'b', 'c'])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('a failed task does not poison the chain', async () => {
    const gate = new SerialGate()
    await expect(gate.exec(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(gate.exec(async () => 'ok')).resolves.toBe('ok')
  })
})
