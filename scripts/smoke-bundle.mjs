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
const expected = {
  research: { title: /ChatGPT Pro Research/ },
  design: { title: /GPT-Image Design/ },
}

for (const directory of ['research', 'design']) {
  const base = new URL(`../packages/${directory}/`, import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', base), 'utf8'))
  const clientCode = await readFile(new URL('lib/client.js', base), 'utf8')
  const registrations = []
  new Script(clientCode, { filename: `${manifest.name}/client.js` }).runInNewContext({
    window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
  })
  assert.equal(registrations.length, 1, `${manifest.name}: one lazy factory`)
  const registration = registrations[0]
  assert.equal(registration.id, manifest.name)
  assert.equal(typeof registration.factory, 'function')

  const requests = []
  const client = registration.factory(specifier => {
    assert.ok(['react', 'react/jsx-runtime'].includes(specifier), `unexpected browser dependency: ${specifier}`)
    requests.push(specifier)
    return require(specifier)
  })
  assert.ok(requests.includes('react'), `${manifest.name}: shared React instance`)
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
  assert.equal(slots.length, 0, `${manifest.name}: wait for layout declarations`)
  declarations.get('main')()
  declarations.get('sidebar.panellist')()
  assert.deepEqual(slots.map(entry => entry.options.name), ['main', 'sidebar.panellist'])
  assert.equal(slots[0].options.key, manifest.name)
  assert.equal(slots[1].options.id, manifest.name)
  assert.match(renderToString(slots[0].render()), expected[directory].title)

  const plugin = await import(new URL('lib/index.js', base))
  const captured = { tools: 0, routes: 0 }
  const ctx = new Context()
  ctx.provide('tools', { register: () => { captured.tools += 1; return () => {} } })
  ctx.provide('webServer', { register: () => { captured.routes += 1; return () => {} } })
  ctx.provide('skills', { registerProvider: () => () => {} })
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.plugin(plugin, { store: 'local' })
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.equal(captured.tools, 1, `${manifest.name}: one tool`)
  assert.equal(captured.routes, 7, `${manifest.name}: seven routes`)
  console.log(`bundle smoke ok: ${manifest.name} ${JSON.stringify({ ...captured, clientSlots: slots.length, clientRequests: requests })}`)
}
