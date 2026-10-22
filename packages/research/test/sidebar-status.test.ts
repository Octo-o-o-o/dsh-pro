import { describe, expect, it } from 'vitest'
import { sidebarStatusText } from '../client/sidebar-status.ts'

describe('sidebar status badge', () => {
  it('summarizes active, completed, failed and stalled topics', () => {
    expect(sidebarStatusText([
      { status: 'waiting' },
      { status: 'uploading' },
      { status: 'completed' },
      { status: 'capped' },
      { status: 'failed' },
      { status: 'stalled' },
    ])).toBe('2 进行 · 2 完成 · 2 失败')
  })

  it('hides the badge when there is nothing to count', () => {
    expect(sidebarStatusText([])).toBe('')
    expect(sidebarStatusText([{ status: 'cancelled' }, { status: 'draft' }])).toBe('')
  })

  it('does not count a completed topic the user has already opened', () => {
    const topics = [
      { id: 'a', status: 'completed', updated: '2026-10-22T15:00:00.000Z' },
      { id: 'b', status: 'capped', updated: '2026-10-22T15:01:00.000Z' },
    ]
    expect(sidebarStatusText(topics, topic => topic.id === 'a')).toBe('1 完成')
  })
})
