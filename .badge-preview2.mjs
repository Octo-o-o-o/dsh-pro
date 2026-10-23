import { build } from 'esbuild'
import { chromium } from 'playwright-core'

await build({
  entryPoints: ['packages/research/client/sidebar-status.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'SidebarStatus',
  outfile: '.badge-status.iife.js',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'error',
})

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 360, height: 110 }, deviceScaleFactor: 2 })
page.on('console', message => console.log('PAGE', message.type(), message.text()))
page.on('pageerror', error => console.log('PAGEERROR', error.message))
await page.setContent(`<body style="margin:0;background:#f7f7f5;font-family:sans-serif">
  <div style="width:300px;padding:10px">
    <button aria-label="Image Design" style="display:flex;align-items:center;gap:10px;width:100%;height:40px;border:0;background:transparent;font:14px sans-serif;text-align:left">
      <span class="panelGlyph" style="width:16px;height:16px;border-radius:4px;background:#222;color:#fff;font-size:10px;display:grid;place-items:center">X</span>
      <span class="panelTitle_abc" style="flex:1">Image Design</span>
    </button>
  </div>
</body>`)
await page.addScriptTag({ path: '.badge-status.iife.js' })
await page.evaluate(() => {
  const topics = [
    { topic_id: 'a', status: 'waiting', updated: '1' },
    { topic_id: 'b', status: 'capped', updated: '2' },
    { topic_id: 'c', status: 'completed', updated: '3' },
    { topic_id: 'd', status: 'failed', updated: '4' },
  ]
  window.__calls = 0
  window.fetch = async () => {
    window.__calls += 1
    return { ok: true, json: async () => ({ topics }) }
  }
  window.__text = window.SidebarStatus.sidebarStatusText(topics)
  window.SidebarStatus.mountSidebarStatus({ label: 'Image Design', routes: '/gpt-image-design', panelId: 'gpt-image-design' })
  return true
})
await page.waitForTimeout(500)
console.log(await page.evaluate(() => ({
  badge: document.querySelector('[data-dsh-pro-badge]')?.outerHTML ?? null,
  row: (() => {
    const b = document.querySelector('button')
    return { aria: b?.getAttribute('aria-label'), title: Boolean(b?.querySelector('[class*="panelTitle"]')), html: b?.innerHTML }
  })(),
  text: document.body.innerText,
  calls: window.__calls,
  computed: window.__text,
  buttons: [...document.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
  mounted: Boolean(window.SidebarStatus),
})))
await page.screenshot({ path: '.badge-status.png' })
await browser.close()
