import type { Status } from './types.ts'

const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['queued', 'cancelled'],
  queued: ['uploading', 'adjudicating', 'stalled', 'capped', 'failed', 'cancelled'],
  uploading: ['submitted', 'stalled', 'failed', 'cancelled'],
  submitted: ['waiting', 'stalled', 'failed', 'cancelled'],
  waiting: ['answered', 'stalled', 'failed', 'cancelled'],
  answered: ['adjudicating', 'cancelled'],
  adjudicating: ['queued', 'completed', 'capped', 'failed', 'cancelled'],
  completed: ['queued'],
  capped: ['queued', 'completed', 'cancelled'],
  stalled: ['queued', 'waiting', 'failed', 'cancelled'],
  failed: ['queued', 'waiting', 'cancelled'],
  cancelled: [],
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal status transition: ${from} -> ${to}`)
  }
}

export function isTerminal(status: Status): boolean {
  return status === 'completed' || status === 'cancelled'
}
