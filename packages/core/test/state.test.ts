import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition, isTerminal } from '../src/state.ts'

describe('status transitions', () => {
  it('accepts the documented happy path', () => {
    const path = ['draft', 'queued', 'uploading', 'submitted', 'waiting', 'answered', 'adjudicating', 'completed'] as const
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true)
    }
  })

  it('rejects skipping stages', () => {
    expect(canTransition('queued', 'completed')).toBe(false)
    expect(canTransition('waiting', 'adjudicating')).toBe(false)
    expect(() => assertTransition('draft', 'completed')).toThrow(/illegal status transition/)
  })

  it('marks terminal states', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('capped')).toBe(false)
    expect(canTransition('capped', 'queued')).toBe(true)
  })

  it('allows recovery entrances', () => {
    expect(canTransition('queued', 'stalled')).toBe(true)
    expect(canTransition('answered', 'stalled')).toBe(true)
    expect(canTransition('adjudicating', 'stalled')).toBe(true)
    expect(canTransition('failed', 'stalled')).toBe(true)
    expect(canTransition('stalled', 'waiting')).toBe(true)
    expect(canTransition('stalled', 'queued')).toBe(true)
    expect(canTransition('failed', 'queued')).toBe(true)
  })

  it('models the human-to-agent review handoff', () => {
    expect(canTransition('capped', 'reviewing')).toBe(true)
    expect(canTransition('failed', 'reviewing')).toBe(true)
    expect(canTransition('stalled', 'reviewing')).toBe(true)
    expect(canTransition('reviewing', 'capped')).toBe(true)
    expect(canTransition('reviewing', 'failed')).toBe(true)
    expect(canTransition('reviewing', 'stalled')).toBe(true)
    expect(canTransition('reviewing', 'completed')).toBe(true)
    expect(canTransition('reviewing', 'queued')).toBe(true)
    expect(canTransition('reviewing', 'cancelled')).toBe(true)
  })
})
