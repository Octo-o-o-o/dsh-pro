/**
 * Promise-chain mutex for browser-driving operations. Both plugins share one
 * ChatGptWebTransport per Chrome profile; the per-engine queues are scoped to
 * (mode, root), so without this gate two topics could drive two pages through
 * submit() concurrently. Errors never poison the chain: a failed task does not
 * block the next one.
 */
export class SerialGate {
  private tail: Promise<void> = Promise.resolve()

  exec<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}
