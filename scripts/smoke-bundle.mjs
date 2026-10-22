/**
 * Post-build smoke check: load the packaged host bundle through a real Cordis
 * context and assert the tool and routes register. CI runs this after `build`
 * so a broken bundle cannot ship silently.
 */
import { Context } from '@deepseek-ai/cordis'

const plugin = await import(new URL('../packages/research/lib/index.js', import.meta.url))
const captured = { tools: 0, routes: 0 }
const ctx = new Context()
ctx.provide('tools', { register: () => { captured.tools += 1; return () => {} } })
ctx.provide('webServer', { register: () => { captured.routes += 1; return () => {} } })
ctx.provide('skills', { registerProvider: () => () => {} })
ctx.provide('connection', { requestRejection: () => undefined })
ctx.plugin(plugin, { store: 'local' })
await new Promise(resolve => setTimeout(resolve, 150))

if (captured.tools !== 1 || captured.routes !== 3) {
  console.error(`bundle smoke failed: ${JSON.stringify(captured)}`)
  process.exit(1)
}
console.log(`bundle smoke ok: ${JSON.stringify(captured)}`)
