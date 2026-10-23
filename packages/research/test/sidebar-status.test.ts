import { describe, expect, it } from 'vitest'
import { sidebarStatusText } from '../client/sidebar-status.ts'

describe('sidebar status badge', () => {
  it('summarizes active, reviewing, completed, failed and stalled topics', () => {
    expect(sidebarStatusText([
      { status: 'waiting' },
      { status: 'uploading' },
      { status: 'completed' },
      { status: 'capped' },
      { status: 'reviewing' },
      { status: 'failed' },
      { status: 'stalled' },
    ])).toBe('2 进行 · 1 待判断 · 1 待接受 · 1 完成 · 2 失败')
  })

  it('hides the badge when there is nothing to count', () => {
    expect(sidebarStatusText([])).toBe('')
    expect(sidebarStatusText([{ status: 'cancelled' }, { status: 'draft' }])).toBe('')
  })

  it('does not count a completed topic the user has already opened', () => {
    const topics = [
      { topic_id: 'a', status: 'completed', updated: '2026-10-22T15:00:00.000Z' },
      { topic_id: 'b', status: 'capped', updated: '2026-10-22T15:01:00.000Z' },
    ]
    expect(sidebarStatusText(topics, topic => topic.topic_id === 'a')).toBe('1 待接受')
  })
})
