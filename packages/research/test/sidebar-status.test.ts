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
})
