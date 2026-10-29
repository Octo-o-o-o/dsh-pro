import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatGptWebTransport } from '../src/chatgpt.ts'
import type { BrowserContext } from 'playwright-core'

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
  it('waits through an introductory pause, then continues in the same conversation', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-pro-browser-'))
    const slowUrl = `${appUrl}?slow=1`
    const transport = new ChatGptWebTransport({ profileDir, headless: true, appUrl: slowUrl, readyTimeoutMs: 100 })
    try {
      const files = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
        const path = join(profileDir, `material-${i}.md`)
        await writeFile(path, `fixture material ${i}`)
        return path
      }))
      const firstBrief = '# Topic\n\n## Task\nfirst research question'
      const first = await transport.submit({ topicId: 'multi', round: 1, brief: firstBrief, files, model: 'pro' })
      expect(first.attachments).toHaveLength(6)
      expect(first.model).toBe('Pro')
      expect(await transport.poll({ submissionId: first.submissionId, timeoutMs: 5_000 })).toMatchObject({ state: 'waiting' })
      await expect(transport.fetch({ submissionId: first.submissionId })).rejects.toThrow(/completion/)
      await expect(transport.submit({ topicId: 'multi', round: 2, brief: 'premature follow-up', files: [], model: 'pro', session: { conversationUrl: slowUrl, profileDir } }))
        .rejects.toMatchObject({ failure: 'ui', submissionState: 'not_sent' })
      // The failed submit keeps the live tab and leaves the existing response alone.
      const context = (transport as unknown as { context: BrowserContext }).context
      expect(context.pages().filter(page => page.url() === slowUrl)).toHaveLength(1)
      let polled
      do { polled = await transport.poll({ submissionId: first.submissionId, timeoutMs: 5_000 }) } while (polled.state === 'waiting')
      expect(polled.answer).toContain('COMPLETE RESEARCH')
      const answer = await transport.fetch({ submissionId: first.submissionId })
      expect(answer.answer).not.toContain('INTRO ONLY')
      const attached = await transport.reattach({ topicId: 'multi', round: 1, brief: firstBrief, conversationUrl: slowUrl })
      expect(attached.attached).toBe(true)
      expect((await transport.fetch({ submissionId: attached.submissionId! })).answer).toContain('COMPLETE RESEARCH')
      const second = await transport.submit({ topicId: 'multi', round: 2, brief: 'second research question', files: [], model: 'pro', session: { conversationUrl: slowUrl, profileDir } })
      do { polled = await transport.poll({ submissionId: second.submissionId, timeoutMs: 5_000 }) } while (polled.state === 'waiting')
      expect(polled.answer).toContain('second research question')
      expect(polled.answer).not.toContain('first research question')
      expect(context.pages().filter(page => page.url() === slowUrl)).toHaveLength(1)
    } finally {
      await transport.close()
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 60_000)

  it('refuses an unverified model before sending and keeps the inspection tab', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-pro-browser-'))
    const transport = new ChatGptWebTransport({ profileDir, headless: true, appUrl })
    try {
      await expect(transport.submit({ topicId: 'model', round: 1, brief: 'never sent', files: [], model: 'unavailable model' }))
        .rejects.toMatchObject({ failure: 'ui', submissionState: 'not_sent' })
      const context = (transport as unknown as { context: BrowserContext }).context
      const page = context.pages().find(page => page.url() === appUrl)!
      expect(await page.locator('[data-message-author-role="user"]').count()).toBe(1)
      expect(page.isClosed()).toBe(false)
    } finally {
      await transport.close()
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 15_000)
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

  it('reports logged-out when only the login link is visible', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-pro-browser-'))
    const transport = new ChatGptWebTransport({
      profileDir,
      headless: true,
      appUrl: new URL('./fixtures/logged-out.html', import.meta.url).href,
    })
    try {
      const probe = await transport.probe()
      expect(probe.ok).toBe(false)
      expect(probe.loggedIn).toBe(false)
      expect(probe.reason).toContain('login')
    } finally {
      await transport.close()
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)
})
