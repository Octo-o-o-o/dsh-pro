import type { Status } from './types.ts'

const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['queued', 'stalled', 'cancelled'],
  queued: ['uploading', 'adjudicating', 'stalled', 'capped', 'failed', 'cancelled'],
  uploading: ['submitted', 'stalled', 'failed', 'cancelled'],
  submitted: ['waiting', 'stalled', 'failed', 'cancelled'],
  waiting: ['answered', 'stalled', 'failed', 'cancelled'],
  answered: ['adjudicating', 'stalled', 'failed', 'cancelled'],
  adjudicating: ['queued', 'completed', 'capped', 'reviewing', 'stalled', 'failed', 'cancelled'],
  completed: ['queued'],
  capped: ['queued', 'reviewing', 'completed', 'cancelled'],
  reviewing: ['queued', 'answered', 'completed', 'capped', 'stalled', 'failed', 'cancelled'],
  stalled: ['queued', 'waiting', 'reviewing', 'failed', 'completed', 'cancelled'],
  failed: ['queued', 'waiting', 'reviewing', 'stalled', 'completed', 'cancelled'],
  cancelled: [],
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Every legal persisted status; used to validate topic.json on load. */
export const STATUSES: readonly Status[] = Object.keys(TRANSITIONS) as Status[]

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal status transition: ${from} -> ${to}`)
  }
}

export function isTerminal(status: Status): boolean {
  return status === 'completed' || status === 'cancelled'
}
