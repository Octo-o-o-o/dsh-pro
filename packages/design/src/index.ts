import { createPlugin, DesignConfig, resolvePluginConfig } from '../../research/src/plugin.ts'
import type { PluginSpec, ResearchConfig } from '../../research/src/plugin.ts'

export const name = 'gpt-image-design'
export const inject = ['tools']

export { DesignConfig as Config }

const spec: PluginSpec = {
  name,
  tool: 'gpt_image_design',
  routes: '/gpt-image-design',
  topicType: 'design',
  homeSubdir: 'gpt-image-design',
  storeSubdir: 'design',
  skills: [{
    name: 'pro-design',
    dir: 'pro-design',
    description: '用 ChatGPT Pro 网页会话或 OpenAI 兼容生图 API 生成设计图与前端 HTML demo，产物保存在本地设计面板；只在用户明确要求设计/出图时使用。',
  }],
}

export const apply = createPlugin(spec)

export function resolveDesignConfig(config?: ResearchConfig) {
  return resolvePluginConfig(spec, config)
}
