/**
 * Chatgpt.com selectors, kept in one place because they are the most volatile
 * part of this package. Calibrated against the live UI on 2026-10-22:
 * the composer is a role=textbox contenteditable, the send/stop buttons carry
 * Chinese aria labels, and assistant turns expose
 * `data-markdown-text-style="assistant-message"` (the old
 * `data-message-author-role` attribute is gone).
 */
export const SELECTORS = {
  composer: [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'form div[contenteditable="true"]',
    '#prompt-textarea',
    'textarea[data-id="root"]',
  ].join(', '),
  sendButton: [
    'button[aria-label="发送"]',
    'button[aria-label="Send prompt"]',
    '[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[type="submit"]',
  ].join(', '),
  stopButton: [
    'button[aria-label="停止"]',
    'button[aria-label="Stop streaming"]',
    '[data-testid="stop-button"]',
  ].join(', '),
  copyButton: [
    'button[aria-label="复制"]',
    'button[aria-label="Copy"]',
    '[data-testid="copy-turn-action-button"]',
  ].join(', '),
  assistantMessage: [
    '[data-markdown-text-style="assistant-message"]',
    '[data-message-author-role="assistant"]',
  ].join(', '),
  fileInput: 'input[type="file"]',
  modelPicker: [
    'button[aria-label*="选择 ChatGPT 模型"]',
    'button[aria-label*="模型"]',
    '[data-testid="model-switcher-dropdown-button"]',
  ].join(', '),
  loginLink: 'a[href*="auth/login"], button[data-testid="login-button"]',
} as const
