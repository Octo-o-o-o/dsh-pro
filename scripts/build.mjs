import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const p = relative => join(root, relative)
const { name: clientId } = JSON.parse(await readFile(p('packages/research/package.json'), 'utf8'))

/** Bundle each publishable entry; DSH host packages stay external. */
const external = ['@deepseek-ai/*', 'playwright-core']
const alias = {
  '@dsh-pro/core': p('packages/core/src/index.ts'),
  '@dsh-pro/transport': p('packages/transport/src/index.ts'),
}

await build({
  entryPoints: [p('packages/research/src/index.ts')],
  outfile: p('packages/research/lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  external,
  alias,
  banner: { js: '// dsh-pro-research — built from packages/research/src/index.ts' },
  logLevel: 'info',
})

await build({
  entryPoints: [p('packages/transport/src/cli.ts')],
  outfile: p('packages/transport/lib/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  external,
  alias,
  logLevel: 'info',
})

await build({
  entryPoints: [p('packages/research/client/index.tsx')],
  outfile: p('packages/research/lib/client.js'),
  bundle: true,
  platform: 'browser',
  // DSH executes /plugins combo scripts before materializing their CJS factories.
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  external: [...external, 'react', 'react/*', 'react-dom', 'react-dom/*'],
  alias,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports;\n} });' },
  logLevel: 'info',
})
