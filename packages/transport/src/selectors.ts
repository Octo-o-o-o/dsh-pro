/**
 * Chatgpt.com selectors, kept in one place because they are the most volatile
 * part of this package. Calibrated against the live UI on 2026-10-22:
 * the composer is a role=textbox contenteditable, the send/stop buttons carry
 * Chinese aria labels, and assistant turns expose
 * `data-markdown-text-style="assistant-message"` (the old
 * `data-message-author-role` attribute is gone).
 */
export const SELECTORS = {
  turn: '[data-talvt-turn-state], [data-testid^="conversation-turn"], article',
  composer: [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'form div[contenteditable="true"]',
    '#prompt-textarea',
    'textarea[data-id="root"]',
  ].join(', '),
  sendButton: [
    'button[aria-label="发送"]',
    'button[aria-label="发送提示"]',
    'button[aria-label="发送消息"]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
    '[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
  ].join(', '),
  stopButton: [
    'button[aria-label="停止"]',
    'button[aria-label="停止生成"]',
    'button[aria-label="停止流式传输"]',
    'button[aria-label="Stop"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    '[data-testid="stop-button"]',
    '[data-testid="composer-stop-button"]',
  ].join(', '),
  copyButton: [
    'button[aria-label="复制"]',
    'button[aria-label="Copy"]',
    'button[aria-label="复制图像"]',
    'button[aria-label="Copy image"]',
    '[data-testid="copy-turn-action-button"]',
  ].join(', '),
  assistantMessage: [
    '[data-markdown-text-style="assistant-message"]',
    '[data-message-author-role="assistant"]',
    '[data-testid="generated-image-gallery"]',
  ].join(', '),
  userMessage: [
    '[data-message-author-role="user"]',
    '[data-markdown-text-style="user-message"]',
    '[data-user-message-bubble="true"]',
  ].join(', '),
  // The composer has several file inputs (camera, photos, videos). The general
  // attachment input is the one without an `accept` filter; the camera input
  // rejects multiple files.
  fileInput: [
    'input[type="file"][aria-label="附加文件"]',
    'input[type="file"][aria-label*="Attach" i]:not([capture])',
    'form input[type="file"][multiple]:not([accept]):not([capture])',
    'input[type="file"][multiple]:not([accept]):not([capture])',
  ].join(', '),
  modelPicker: [
    'button[aria-label*="选择 ChatGPT 模型"]',
    'button[aria-label*="模型"]',
    '[data-testid="model-switcher-dropdown-button"]',
  ].join(', '),
  loginLink: 'a[href*="auth/login"], button[data-testid="login-button"]',
} as const
