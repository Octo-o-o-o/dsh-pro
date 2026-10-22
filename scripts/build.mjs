import { build } from 'esbuild'

/** Bundle each publishable entry; DSH host packages stay external. */
const external = ['@deepseek-ai/*', 'playwright-core']
const alias = {
  '@dsh-pro/core': './packages/core/src/index.ts',
  '@dsh-pro/transport': './packages/transport/src/index.ts',
}

await build({
  entryPoints: ['packages/research/src/index.ts'],
  outfile: 'packages/research/lib/index.js',
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
  entryPoints: ['packages/transport/src/cli.ts'],
  outfile: 'packages/transport/lib/cli.js',
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
  entryPoints: ['packages/research/client/index.tsx'],
  outfile: 'packages/research/lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  external: [...external, 'react', 'react/*', 'react-dom', 'react-dom/*'],
  alias,
  logLevel: 'info',
})
