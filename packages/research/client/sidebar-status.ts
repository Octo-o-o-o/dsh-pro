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
  reviewing: number
  completed: number
  incomplete: number
  failed: number
}

const POLL_MS = 5_000

function countTopics(
  topics: Array<{ topic_id?: string; status?: string; updated?: string }>,
  isSeen: (topic: { topic_id?: string; status?: string; updated?: string }) => boolean,
): Counts {
  const counts: Counts = { active: 0, reviewing: 0, completed: 0, incomplete: 0, failed: 0 }
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
      case 'reviewing':
        counts.reviewing += 1
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

interface BadgePart {
  text: string
  color: string
}

const STATUS_TINT = {
  active: '#6f9fd0',
  reviewing: '#5c88c4',
  incomplete: '#c39a4a',
  completed: '#5f9c7a',
  failed: '#c26a6a',
}

function badgeParts(counts: Counts): BadgePart[] {
  const parts: BadgePart[] = []
  if (counts.active > 0) parts.push({ text: `${counts.active} 进行`, color: STATUS_TINT.active })
  if (counts.reviewing > 0) parts.push({ text: `${counts.reviewing} 待判断`, color: STATUS_TINT.reviewing })
  if (counts.incomplete > 0) parts.push({ text: `${counts.incomplete} 待接受`, color: STATUS_TINT.incomplete })
  if (counts.completed > 0) parts.push({ text: `${counts.completed} 完成`, color: STATUS_TINT.completed })
  if (counts.failed > 0) parts.push({ text: `${counts.failed} 失败`, color: STATUS_TINT.failed })
  return parts
}

function badgeText(counts: Counts): string {
  return badgeParts(counts).map(part => part.text).join(' · ')
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
  let parts: BadgePart[] = []
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

  const renderBadge = (target: HTMLSpanElement): void => {
    target.replaceChildren()
    parts.forEach((part, index) => {
      if (index > 0) {
        const separator = document.createElement('span')
        separator.textContent = '·'
        separator.style.opacity = '.35'
        separator.style.margin = '0 2px'
        target.appendChild(separator)
      }
      const span = document.createElement('span')
      span.textContent = part.text
      span.style.color = part.color
      target.appendChild(span)
    })
    target.dataset.text = text
  }

  const applyText = (next: string, nextParts: BadgePart[]): void => {
    const changed = text !== next
    text = next
    parts = nextParts
    if (badge !== undefined && changed) renderBadge(badge)
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
      if (badge.dataset.text !== text) renderBadge(badge)
      return
    }
    badge = document.createElement('span')
    badge.dataset.dshProBadge = options.panelId
    badge.setAttribute('aria-hidden', 'true')
    badge.style.cssText = [
      'margin-left:auto',
      'display:inline-flex',
      'align-items:center',
      'flex:0 0 auto',
      'font-size:10px',
      'font-weight:500',
      'line-height:1',
      'opacity:.8',
      'white-space:nowrap',
      'font-variant-numeric:tabular-nums',
      'pointer-events:none',
    ].join(';')
    renderBadge(badge)
    row.appendChild(badge)
  }

  const refresh = async (): Promise<void> => {
    if (disposed || polling) return
    polling = true
    try {
      const response = await fetch(`${options.routes}/topics`, { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const data = await response.json() as { topics?: Array<{ topic_id?: string; status?: string; updated?: string }> }
      const counts = countTopics(
        data.topics ?? [],
        topic => isTopicSeen(options.panelId, topic.topic_id ?? '', topic.updated),
      )
      applyText(badgeText(counts), badgeParts(counts))
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
