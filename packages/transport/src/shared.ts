import { resolve } from 'node:path'
import { ChatGptWebTransport, type ChatGptTransportOptions } from './chatgpt.ts'

interface Slot {
  transport: ChatGptWebTransport
  refs: number
}

const REGISTRY = Symbol.for('dsh-pro.transport.shared.v1')

function registry(): Map<string, Slot> {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = holder[REGISTRY]
  if (existing instanceof Map) return existing as Map<string, Slot>
  const created = new Map<string, Slot>()
  holder[REGISTRY] = created
  return created
}

export interface SharedTransport {
  transport: ChatGptWebTransport
  release(): void
}

/**
 * Both plugins live in one DSH host process but are bundled separately. A
 * module-level singleton would therefore be duplicated; the global registry
 * keyed by profile directory keeps one Chrome instance per profile and
 * reference-counts its users. The last release closes the browser.
 */
export function acquireSharedTransport(
  options: ChatGptTransportOptions,
  create: () => ChatGptWebTransport = () => new ChatGptWebTransport(options),
): SharedTransport {
  const key = resolve(options.profileDir)
  const slots = registry()
  let slot = slots.get(key)
  if (slot === undefined) {
    slot = { transport: create(), refs: 0 }
    slots.set(key, slot)
  }
  slot.refs += 1
  const target = slot
  let released = false
  return {
    transport: target.transport,
    release: () => {
      if (released) return
      released = true
      target.refs -= 1
      if (target.refs > 0) return
      if (slots.get(key) === target) slots.delete(key)
      void target.transport.close()
    },
  }
}
