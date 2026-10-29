import type { Locator, Page } from 'playwright-core'
import { SELECTORS } from './selectors.ts'

/** Hidden duplicates must not mask a visible send/stop control. */
export async function firstVisible(page: Page, selector: string, timeoutMs: number): Promise<Locator | undefined> {
  const locator = page.locator(selector).filter({ visible: true }).first()
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
    return locator
  } catch {
    return undefined
  }
}

export interface TurnState {
  text: string
  streaming: boolean
  terminal: boolean
  renderFailed?: boolean
  assistantCount: number
  /** Raw selector index of this answer's last segment, for artifact extraction. */
  messageIndex: number
}

export async function readUserTurns(page: Page): Promise<string[]> {
  return await page.evaluate(selector => {
    const nodes = [...document.querySelectorAll<HTMLElement>(selector)]
    return nodes.filter(node => !nodes.some(parent => parent !== node && parent.contains(node)))
      .map(node => node.innerText.trim())
  }, SELECTORS.userMessage)
}

/** Read only the answer after the requested prompt, never a global copy count. */
export async function readTurnState(page: Page, baseline: number, userBaseline?: number): Promise<TurnState> {
  return await page.evaluate(({ selectors, baseline, userBaseline }) => {
    const visible = (node: Element): boolean => {
      const style = getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
    }
    const all = [...document.querySelectorAll<HTMLElement>(selectors.assistantMessage)]
    const userNodes = [...document.querySelectorAll(selectors.userMessage)]
    const users = userNodes.filter(node => !userNodes.some(parent => parent !== node && parent.contains(node)))
    const prompt = userBaseline === undefined ? undefined : users[userBaseline]
    const nextUser = userBaseline === undefined ? undefined : users[userBaseline + 1]
    const candidates = all.slice(baseline).filter(node => node.closest(selectors.userMessage) === null && (prompt === undefined
      || (prompt.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
      && (nextUser === undefined || (node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0))
    // Old/new selectors can match both a role wrapper and its markdown child.
    const messages = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node)))
    const last = messages.at(-1)
    const root = last?.closest(selectors.turn) ?? last
    // A completed turn may have no markdown when ChatGPT's renderer fails.
    // Scope this UI error to the requested prompt, never a previous answer.
    const errorRoot = prompt?.closest(selectors.turn) ?? root
    const renderFailed = errorRoot !== undefined && errorRoot !== null
      && [...errorRoot.querySelectorAll('[data-dil-render-failed]')].some(node => visible(node)
        && node.closest(`${selectors.userMessage}, pre, code`) === null
        && (nextUser === undefined || (node.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0))
    const streaming = [...document.querySelectorAll(selectors.stopButton)].some(visible)
      || (root !== undefined && [...root.querySelectorAll('[aria-busy="true"], [data-is-streaming="true"]')].some(visible))
      || root?.matches('[aria-busy="true"], [data-is-streaming="true"]') === true
    const terminal = root !== undefined && [...root.querySelectorAll(selectors.copyButton)].some(button => {
      if (!visible(button) || button.closest('pre, code') !== null) return false
      if (button.closest(selectors.userMessage) !== null) return false
      if (button.getAttribute('data-testid') === 'copy-turn-action-button') return true
      for (let parent = button.parentElement; parent !== null && parent !== root; parent = parent.parentElement) {
        if (parent.querySelector('pre, code') !== null) return false
      }
      // Legacy aria-only buttons are valid in the turn toolbar, never inside
      // markdown (where code blocks and citations also expose Copy buttons).
      return root !== last && !messages.some(message => message.contains(button))
    })
    return {
      // A gallery's Edit button is UI, not an assistant's answer.
      text: messages.filter(node => !node.matches('[data-testid="generated-image-gallery"]'))
        .map(node => node.innerText.trim()).filter(Boolean).join('\n\n'),
      streaming,
      ...(renderFailed ? { renderFailed: true } : {}),
      terminal: !streaming && terminal
        && (!root?.hasAttribute('data-talvt-turn-state') || root.getAttribute('data-talvt-turn-state') === 'complete'),
      assistantCount: all.length,
      messageIndex: last === undefined ? -1 : all.indexOf(last),
    }
  }, { selectors: SELECTORS, baseline, userBaseline })
}
