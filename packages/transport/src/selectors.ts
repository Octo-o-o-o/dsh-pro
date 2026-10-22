/**
 * Chatgpt.com selectors, kept in one place because they are the most volatile
 * part of this package. Each entry is a comma-separated CSS list tried in
 * order; semantic attributes come first and generic structure last.
 */
export const SELECTORS = {
  composer: [
    '#prompt-textarea',
    'div[contenteditable="true"][data-virtualkeyboard="true"]',
    'form div[contenteditable="true"]',
    'textarea[data-id="root"]',
  ].join(', '),
  sendButton: [
    '[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="Send prompt"]',
  ].join(', '),
  stopButton: [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
  ].join(', '),
  copyButton: [
    '[data-testid="copy-turn-action-button"]',
    'button[aria-label="Copy"]',
  ].join(', '),
  assistantMessage: '[data-message-author-role="assistant"]',
  fileInput: 'input[type="file"]',
  modelPicker: [
    '[data-testid="model-switcher-dropdown-button"]',
    'button[aria-haspopup="menu"][data-testid*="model"]',
  ].join(', '),
  loginLink: 'a[href*="auth/login"], button[data-testid="login-button"]',
} as const
