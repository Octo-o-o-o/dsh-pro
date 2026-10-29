import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { firstVisible, readTurnState, readUserTurns } from '../src/page-state.ts'
import { SELECTORS } from '../src/selectors.ts'

describe.skipIf(process.env.DSH_PRO_TRANSPORT_SMOKE !== '1')('real DOM completion boundaries', () => {
  let browser: Browser
  let page: Page
  // CI cold-starts Chrome alongside the transport suite; the default 10s hook
  // must not expire before Playwright's 30s browser launch timeout.
  beforeAll(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage()
  }, 45_000)
  afterAll(async () => { await browser?.close() })

  it.each(['停止流式传输', '停止生成', 'Stop generating', 'Stop streaming'])('sees visible %s after a hidden duplicate', async label => {
    await page.setContent(`<button data-testid="stop-button" hidden></button>
      <button aria-label="${label}"></button>
      <article><div data-message-author-role="assistant">partial</div>
      <button data-testid="copy-turn-action-button">Copy</button></article>`)
    expect(await readTurnState(page, 0)).toMatchObject({ streaming: true, terminal: false })
  })

  it('requires a completed current turn, not old, user, citation or code copy controls', async () => {
    await page.setContent(`<article><div data-message-author-role="assistant">old</div>
      <button data-testid="copy-turn-action-button">Copy</button></article>
      <div data-message-author-role="user">question<button aria-label="Copy">Copy</button></div>
      <article id="current"><div data-message-author-role="assistant">introduction
      <div><button aria-label="Copy">Copy</button><pre><code>partial code</code></pre></div>
      <span><button aria-label="Copy">Copy citation</button></span></div></article>`)
    expect(await readTurnState(page, 1, 0)).toMatchObject({ streaming: false, terminal: false })
    await page.locator('#current').evaluate(node => {
      const button = document.createElement('button')
      button.setAttribute('data-testid', 'copy-turn-action-button')
      node.append(button)
    })
    expect(await readTurnState(page, 1, 0)).toMatchObject({ terminal: true })
  })

  it('never treats a long text pause or an image/code fingerprint as completion', async () => {
    await page.setContent('<article><div data-message-author-role="assistant">image:1:1024x1024<pre><code>code</code></pre></div></article>')
    for (let index = 0; index < 6; index++) expect((await readTurnState(page, 0)).terminal).toBe(false)
  })

  it('recognizes the live div-based turn only after its completion state and answer toolbar agree', async () => {
    await page.setContent(`<div data-talvt-turn-state="pending" id="turn">
      <div><div data-user-message-bubble="true">question</div>
      <button aria-label="复制消息"></button></div>
      <div><div data-markdown-text-style="assistant-message">完整答复
      <pre><code>demo</code><button aria-label="复制"></button></pre></div></div>
      <div id="actions"><button aria-label="复制"></button></div></div>`)
    expect(await readTurnState(page, 0, 0)).toMatchObject({ terminal: false })
    expect(await readUserTurns(page)).toEqual(['question'])
    await page.locator('#turn').evaluate(node => node.setAttribute('data-talvt-turn-state', 'complete'))
    expect(await readTurnState(page, 0, 0)).toMatchObject({ terminal: true, streaming: false })
    await page.locator('#actions').evaluate(node => node.remove())
    expect(await readTurnState(page, 0, 0)).toMatchObject({ terminal: false })
  })

  it('recognizes a completed image-only turn and excludes user galleries and later turns', async () => {
    await page.setContent(`<div data-talvt-turn-state="complete">
      <div data-user-message-bubble="true">draw a cloud<div data-testid="generated-image-gallery">reference</div></div>
      <div data-testid="generated-image-gallery"><img alt="generated cloud"><button>编辑</button></div>
      <button aria-label="复制图像"></button></div>
      <div data-talvt-turn-state="complete"><div data-user-message-bubble="true">later</div>
      <div data-markdown-text-style="assistant-message">later answer</div><button aria-label="复制"></button></div>`)
    expect(await readTurnState(page, 0, 0)).toMatchObject({ text: '', terminal: true, messageIndex: 1 })
  })

  it('collects all current segments once and excludes later conversation turns', async () => {
    await page.setContent(`<div data-message-author-role="user"><div data-markdown-text-style="user-message">target question</div></div>
      <article><div data-message-author-role="assistant"><div data-markdown-text-style="assistant-message">section one</div></div>
      <div data-markdown-text-style="assistant-message">section two</div><button aria-label="Copy"></button></article>
      <div data-message-author-role="user">later question</div>
      <article><div data-message-author-role="assistant">unrelated later answer</div><button data-testid="copy-turn-action-button"></button></article>`)
    expect(await readUserTurns(page)).toEqual(['target question', 'later question'])
    expect(await readTurnState(page, 0, 0)).toMatchObject({ text: 'section one\n\nsection two', terminal: true, messageIndex: 2 })
  })

  it('selects a visible send button rather than the first hidden match', async () => {
    await page.setContent('<button data-testid="send-button" hidden>hidden</button><button aria-label="Send message">visible</button>')
    expect(await (await firstVisible(page, SELECTORS.sendButton, 500))?.innerText()).toBe('visible')
  })

  it('detects a completed renderer failure without markdown only in the current turn', async () => {
    await page.setContent(`<div data-talvt-turn-state="complete"><div data-user-message-bubble="true">old</div>
      <div role="status" data-dil-render-failed>无法加载此回复</div></div>
      <div data-talvt-turn-state="complete" id="current"><div data-user-message-bubble="true">current</div>
      <div role="status" data-dil-render-failed hidden>无法加载此回复</div><button aria-label="复制"></button></div>`)
    expect((await readTurnState(page, 0, 1)).renderFailed).toBeUndefined()
    await page.locator('#current [data-dil-render-failed]').evaluate(node => node.removeAttribute('hidden'))
    expect(await readTurnState(page, 0, 1)).toMatchObject({ renderFailed: true, terminal: false, text: '' })
  })
})
