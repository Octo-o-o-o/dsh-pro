/**
 * Load both packaged entries as DSH does: the host through Cordis and the
 * browser entry as a classic script registering a lazy module factory.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(await readFile(new URL('../packages/research/package.json', import.meta.url), 'utf8'))
const clientCode = await readFile(new URL('../packages/research/lib/client.js', import.meta.url), 'utf8')
const registrations = []
new Script(clientCode, { filename: 'dsh-pro-research/client.js' }).runInNewContext({
  window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
})
assert.equal(registrations.length, 1, 'the classic script must register exactly one lazy factory')
const registration = registrations[0]
assert.equal(registration.id, manifest.name)
assert.equal(typeof registration.factory, 'function')

const requests = []
const client = registration.factory(specifier => {
  assert.ok(['react', 'react/jsx-runtime'].includes(specifier), `unexpected browser dependency: ${specifier}`)
  requests.push(specifier)
  return require(specifier)
})
assert.ok(requests.includes('react'), 'the factory must use the shared React instance')
assert.deepEqual(Array.from(client.inject), ['slots'])
const slots = []
const declarations = new Map()
const clientCtx = new Context()
clientCtx.provide('slots', {
  inject: (name, register) => {
    declarations.set(name, register)
    return () => declarations.delete(name)
  },
  register: (options, render) => {
    slots.push({ options, render })
    return () => {}
  },
})
clientCtx.plugin(client)
await new Promise(resolve => setTimeout(resolve, 150))
assert.equal(slots.length, 0, 'the plugin must wait for layout declarations')
declarations.get('main')()
declarations.get('sidebar.panellist')()
assert.deepEqual(slots.map(entry => entry.options.name), ['main', 'sidebar.panellist'])
assert.equal(slots[0].options.key, 'pro-research')
assert.equal(slots[1].options.id, 'pro-research')
assert.match(renderToString(slots[0].render()), /Pro 研究/)

const plugin = await import(new URL('../packages/research/lib/index.js', import.meta.url))
const captured = { tools: 0, routes: 0 }
const ctx = new Context()
ctx.provide('tools', { register: () => { captured.tools += 1; return () => {} } })
ctx.provide('webServer', { register: () => { captured.routes += 1; return () => {} } })
ctx.provide('skills', { registerProvider: () => () => {} })
ctx.provide('connection', { requestRejection: () => undefined })
ctx.plugin(plugin, { store: 'local' })
await new Promise(resolve => setTimeout(resolve, 150))

assert.equal(captured.tools, 1)
assert.equal(captured.routes, 3)
console.log(`bundle smoke ok: ${JSON.stringify({ ...captured, clientSlots: slots.length, clientRequests: requests })}`)
