/**
 * The host's `sidebar.panellist` contract only allows a plain-text label, so a
 * badge cannot be registered declaratively. This mounts a small, non-interactive
 * status badge into the rendered row (the same DOM-adjacent approach used by
 * other sidebar plugins), keeps it in sync with `/topics`, and tolerates React
 * re-renders by re-attaching when the row is recreated.
 */

import { isTopicSeen, SEEN_EVENT } from './seen.ts'

export interface SidebarStatusOptions {
  label: string
  routes: string
  panelId: string
}

interface Counts {
  active: number
  completed: number
  incomplete: number
  failed: number
}

const POLL_MS = 5_000

function countTopics(
  topics: Array<{ topic_id?: string; status?: string; updated?: string }>,
  isSeen: (topic: { topic_id?: string; status?: string; updated?: string }) => boolean,
): Counts {
  const counts: Counts = { active: 0, completed: 0, incomplete: 0, failed: 0 }
  for (const topic of topics) {
    switch (topic.status) {
      case 'queued':
      case 'uploading':
      case 'submitted':
      case 'waiting':
      case 'answered':
      case 'adjudicating':
        counts.active += 1
        break
      case 'completed':
        if (!isSeen(topic)) counts.completed += 1
        break
      case 'capped':
        counts.incomplete += 1
        break
      case 'failed':
      case 'stalled':
        counts.failed += 1
        break
      default:
        break
    }
  }
  return counts
}

function badgeText(counts: Counts): string {
  const parts: string[] = []
  if (counts.active > 0) parts.push(`${counts.active} 进行`)
  if (counts.incomplete > 0) parts.push(`${counts.incomplete} 未完成`)
  if (counts.completed > 0) parts.push(`${counts.completed} 完成`)
  if (counts.failed > 0) parts.push(`${counts.failed} 失败`)
  return parts.join(' · ')
}

/** Pure summary used by the badge and by tests. */
export function sidebarStatusText(
  topics: Array<{ topic_id?: string; status?: string; updated?: string }>,
  isSeen: (topic: { topic_id?: string; status?: string; updated?: string }) => boolean = () => false,
): string {
  return badgeText(countTopics(topics, isSeen))
}

export function mountSidebarStatus(options: SidebarStatusOptions): () => void {
  if (typeof document === 'undefined') return () => {}

  let badge: HTMLSpanElement | undefined
  let text = ''
  let disposed = false
  let polling = false
  let attachTimer: number | undefined
  let observer: MutationObserver | undefined

  const rowFor = (): HTMLButtonElement | undefined => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('button[aria-label]')
    for (const button of buttons) {
      if (button.getAttribute('aria-label') === options.label) return button
    }
    return undefined
  }

  const applyText = (next: string): void => {
    text = next
    if (badge !== undefined && badge.textContent !== text) badge.textContent = text
    ensureMounted()
  }

  const ensureMounted = (): void => {
    if (disposed) return
    if (text === '') {
      badge?.remove()
      badge = undefined
      return
    }
    const row = rowFor()
    if (row === undefined) return
    // Collapsed rail renders the glyph only; a badge would overflow it.
    const title = row.querySelector('[class*="panelTitle"]')
    if (title === null) {
      badge?.remove()
      badge = undefined
      return
    }
    if (badge !== undefined && badge.parentElement === row) {
      if (badge.textContent !== text) badge.textContent = text
      return
    }
    badge = document.createElement('span')
    badge.dataset.dshProBadge = options.panelId
    badge.textContent = text
    badge.setAttribute('aria-hidden', 'true')
    badge.style.cssText = [
      'margin-left:auto',
      'display:inline-flex',
      'align-items:center',
      'flex:0 0 auto',
      'font-size:10px',
      'line-height:1',
      'opacity:.62',
      'white-space:nowrap',
      'font-variant-numeric:tabular-nums',
      'pointer-events:none',
    ].join(';')
    row.appendChild(badge)
  }

  const refresh = async (): Promise<void> => {
    if (disposed || polling) return
    polling = true
    try {
      const response = await fetch(`${options.routes}/topics`, { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const data = await response.json() as { topics?: Array<{ topic_id?: string; status?: string; updated?: string }> }
      applyText(sidebarStatusText(
        data.topics ?? [],
        topic => isTopicSeen(options.panelId, topic.topic_id ?? '', topic.updated),
      ))
    } catch {
      // The host may still be starting; poll again on the next tick.
    } finally {
      polling = false
    }
  }

  observer = new MutationObserver(() => {
    if (attachTimer !== undefined) return
    attachTimer = window.setTimeout(() => {
      attachTimer = undefined
      ensureMounted()
    }, 100)
  })
  observer.observe(document.body, { childList: true, subtree: true })

  const timer = window.setInterval(() => { void refresh() }, POLL_MS)
  const onSeen = () => { void refresh() }
  window.addEventListener(SEEN_EVENT, onSeen)
  void refresh()

  return () => {
    disposed = true
    window.clearInterval(timer)
    window.removeEventListener(SEEN_EVENT, onSeen)
    if (attachTimer !== undefined) window.clearTimeout(attachTimer)
    observer?.disconnect()
    badge?.remove()
    badge = undefined
  }
}
