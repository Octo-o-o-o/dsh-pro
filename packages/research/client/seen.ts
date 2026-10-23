/**
 * Per-panel "already looked at this completed topic" memory. A completed topic
 * keeps appearing in the sidebar badge until the user opens it once; a later
 * update changes `updated` and makes it count again.
 */
export const SEEN_EVENT = 'dsh-pro:topic-seen'

function storageKey(panelId: string): string {
  return `dsh-pro:seen:${panelId}`
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // Opaque origins (about:blank, sandboxed frames) throw on access.
    return undefined
  }
}

function read(panelId: string): Record<string, string> {
  const store = storage()
  if (store === undefined) return {}
  try {
    const parsed = JSON.parse(store.getItem(storageKey(panelId)) ?? '{}') as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

export function markTopicSeen(panelId: string, topicId: string, updated: string | undefined): void {
  const store = storage()
  if (store === undefined || updated === undefined) return
  const seen = read(panelId)
  if (seen[topicId] === updated) return
  seen[topicId] = updated
  try {
    store.setItem(storageKey(panelId), JSON.stringify(seen))
  } catch {
    return
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SEEN_EVENT))
}

export function isTopicSeen(panelId: string, topicId: string, updated: string | undefined): boolean {
  if (updated === undefined) return false
  return read(panelId)[topicId] === updated
}
