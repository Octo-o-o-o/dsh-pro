import { describe, expect, it } from 'vitest'
import { advanceCompletion } from '../src/completion.ts'

describe('completion heuristic', () => {
  it('needs two identical non-streaming reads', () => {
    const first = advanceCompletion({ lastText: '', stable: 0 }, 'answer', false)
    expect(first).toEqual({ lastText: 'answer', stable: 1, answered: false })
    const second = advanceCompletion(first, 'answer', false)
    expect(second.answered).toBe(true)
  })

  it('resets while streaming', () => {
    const first = advanceCompletion({ lastText: '', stable: 0 }, 'partial', false)
    const streaming = advanceCompletion(first, 'partial', true)
    expect(streaming.stable).toBe(0)
    expect(streaming.answered).toBe(false)
  })

  it('resets when the text changes', () => {
    const first = advanceCompletion({ lastText: '', stable: 0 }, 'one', false)
    const second = advanceCompletion(first, 'two', false)
    expect(second.stable).toBe(1)
    expect(second.answered).toBe(false)
  })

  it('never completes on an empty answer', () => {
    const state = advanceCompletion({ lastText: 'old', stable: 5 }, '', false)
    expect(state.stable).toBe(0)
    expect(state.answered).toBe(false)
  })
})
