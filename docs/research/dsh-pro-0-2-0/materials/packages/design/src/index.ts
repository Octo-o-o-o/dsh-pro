import { createPlugin, Config } from '../../research/src/plugin.ts'
import type { PluginSpec } from '../../research/src/plugin.ts'

export const name = 'gpt-image-design'
export const inject = ['tools']

export { Config }

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
    description: '用 ChatGPT Pro 网页会话生成设计图和前端 HTML demo，产物保存在本地设计面板；只在用户明确要求设计/出图时使用。',
  }],
}

export const apply = createPlugin(spec)
