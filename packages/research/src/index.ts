import { createPlugin, Config, resolvePluginConfig } from './plugin.ts'
import type { PluginSpec, ResearchConfig } from './plugin.ts'

export const name = 'chatgpt-pro-research'
export const inject = ['tools']

export { Config }

const spec: PluginSpec = {
  name,
  tool: 'pro_research',
  routes: '/chatgpt-pro-research',
  topicType: 'research',
  homeSubdir: 'chatgpt-pro-research',
  storeSubdir: 'research',
  skills: [{
    name: 'pro-research',
    dir: 'pro-research',
    description: '用 ChatGPT Pro 网页会话做无人值守的多轮调研；只在用户明确要求 Pro 调研时使用。',
  }],
}

export const apply = createPlugin(spec)

export function resolveResearchConfig(config?: ResearchConfig) {
  return resolvePluginConfig(spec, config)
}
