import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatGptWebTransport } from '../src/chatgpt.ts'

/**
 * Optional, browser-backed smoke test against a local fixture page. It proves
 * the mechanics (launch, type, send, stable-answer completion, fetch), NOT the
 * real chatgpt.com DOM. Enable explicitly:
 *
 *   DSH_PRO_TRANSPORT_SMOKE=1 npx vitest run packages/transport/test/transport.smoke.test.ts
 *
 * Skipped by default so CI needs no Chrome.
 */
const enabled = process.env.DSH_PRO_TRANSPORT_SMOKE === '1'
const appUrl = new URL('./fixtures/chatgpt.html', import.meta.url).href

describe.skipIf(!enabled)('transport against the local fixture', () => {
  it('submits a brief and reads the stable answer', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-pro-browser-'))
    const transport = new ChatGptWebTransport({ profileDir, headless: true, appUrl })
    try {
      const probe = await transport.probe()
      expect(probe.ok).toBe(true)

      const submitted = await transport.submit({
        topicId: 'smoke',
        round: 1,
        brief: 'hello fixture',
        files: [],
        model: 'pro',
      })
      expect(submitted.submissionId).not.toBe('')

      let answer = ''
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const polled = await transport.poll({ submissionId: submitted.submissionId, timeoutMs: 5_000 })
        if (polled.state === 'answered') {
          answer = polled.answer ?? (await transport.fetch({ submissionId: submitted.submissionId })).answer
          break
        }
        if (polled.state === 'unknown') throw new Error('page state unknown')
      }
      expect(answer).toContain('FAKE ANSWER to hello fixture')
      expect(answer).not.toContain('OLD ANSWER')
    } finally {
      await transport.close()
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)
})
