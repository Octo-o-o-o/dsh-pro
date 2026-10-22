import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const core = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url))
const transport = fileURLToPath(new URL('./packages/transport/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-pro/core': core,
      '@dsh-pro/transport': transport,
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
})
