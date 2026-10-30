import { build as esbuildBuild } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const p = relative => join(root, relative)

// Keep filesystem writes in Node: the native esbuild writer can be denied on
// Windows even when this process can write the same files.
async function build (options) {
  const result = await esbuildBuild({ ...options, write: false })
  for (const output of result.outputFiles) {
    await mkdir(dirname(output.path), { recursive: true })
    await writeFile(output.path, output.contents)
  }
  return result
}

/** DSH host packages stay external; React comes from the client module table. */
const external = ['@deepseek-ai/*', 'playwright-core']
const alias = {
  '@dsh-pro/core': p('packages/core/src/index.ts'),
  '@dsh-pro/transport': p('packages/transport/src/index.ts'),
}

async function packageId (directory) {
  const manifest = JSON.parse(await readFile(p(`packages/${directory}/package.json`), 'utf8'))
  return manifest.name
}

// Transport CLI (local debugging only).
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

for (const directory of ['research', 'design']) {
  const id = await packageId(directory)

  await build({
    entryPoints: [p(`packages/${directory}/src/index.ts`)],
    outfile: p(`packages/${directory}/lib/index.js`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    external,
    alias,
    banner: { js: `// ${id} — built from packages/${directory}/src/index.ts` },
    logLevel: 'info',
  })

  await build({
    entryPoints: [p(`packages/${directory}/client/index.tsx`)],
    outfile: p(`packages/${directory}/lib/client.js`),
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
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports;\n} });' },
    logLevel: 'info',
  })
}
