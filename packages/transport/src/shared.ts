import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { TransportError } from 'dsh-pro-core'
import { ChatGptWebTransport, type ChatGptTransportOptions } from './chatgpt.ts'

interface Slot {
  transport: ChatGptWebTransport
  refs: number
  lockFile: string
  token: string
}

interface LockRecord {
  pid: number
  token: string
  startedAt: string
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function acquireProfileLock(profileDir: string): { file: string; token: string } {
  const file = `${resolve(profileDir)}.dsh-pro.lock`
  mkdirSync(dirname(file), { recursive: true })
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' })
      return { file, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: LockRecord | undefined
      try {
        owner = JSON.parse(readFileSync(file, 'utf8')) as LockRecord
      } catch {
        // A malformed lock is treated as stale; the owner cannot be proven alive.
      }
      if (owner !== undefined && Number.isInteger(owner.pid) && owner.pid !== process.pid && isAlive(owner.pid)) {
        throw new TransportError(
          `Chrome profile is already owned by process ${owner.pid}: ${resolve(profileDir)}`,
          'config',
        )
      }
      try {
        unlinkSync(file)
      } catch {
        // Another process may have removed it between read and unlink.
      }
    }
  }
  throw new TransportError(`cannot acquire the Chrome profile lease: ${resolve(profileDir)}`, 'config')
}

function releaseProfileLock(file: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8')) as LockRecord
    if (owner.token !== token) return
    unlinkSync(file)
  } catch {
    // Best effort: a stale lock is recoverable by PID liveness.
  }
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
    const lease = acquireProfileLock(key)
    let transport: ChatGptWebTransport
    try {
      transport = create()
    } catch (error) {
      releaseProfileLock(lease.file, lease.token)
      throw error
    }
    slot = { transport, refs: 0, lockFile: lease.file, token: lease.token }
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
      void target.transport.close().finally(() => releaseProfileLock(target.lockFile, target.token))
    },
  }
}
